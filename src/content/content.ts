import { initComposeTracking, setTrackedSendHook } from "./compose";
import { applyReadTags, refreshReadStates } from "./readtags";
import type { ActivitySummary, LabelOut, ThreadFlag, ThreadTag } from "../types";

const PROCESSED_ATTR = "data-correo-badged";
const TO_ME_CLASS = "correo-to-me";
const CACHE_KEY = "correo_activity_cache";

interface AwaitingEntry {
  flag: ThreadFlag;
  kind: "me" | "them";
}

interface ThreadInfo {
  tag: ThreadTag | null;
  awaiting: AwaitingEntry | null;
}

function buildThreadInfoMap(summary: ActivitySummary | null): Map<string, ThreadInfo> {
  const map = new Map<string, ThreadInfo>();
  if (!summary) return map;

  for (const tag of summary.allThreads || []) {
    if (tag.isResolved) continue;
    map.set(tag.threadId, { tag, awaiting: null });
  }
  for (const flag of summary.awaitingMyReply || []) {
    const existing = map.get(flag.threadId);
    if (existing) existing.awaiting = { flag, kind: "me" };
    else map.set(flag.threadId, { tag: null, awaiting: { flag, kind: "me" } });
  }
  for (const flag of summary.awaitingTheirReply || []) {
    const existing = map.get(flag.threadId);
    if (existing && !existing.awaiting) existing.awaiting = { flag, kind: "them" };
    else if (!existing) map.set(flag.threadId, { tag: null, awaiting: { flag, kind: "them" } });
  }
  return map;
}

function daysSince(ms: number | null): number {
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

// Only "내 차례" gets a persistent at-a-glance marker in the row itself —
// everything else (참조/공용/상대 차례) lives in the "Correo ▾" menu's info
// line instead, so the list stays quiet and the rail badge count carries
// the "something needs me" signal.
function makeDtag(info: ThreadInfo): HTMLSpanElement | null {
  if (info.awaiting?.kind !== "me") return null;
  const days = daysSince(info.awaiting.flag.lastDateMs);
  const span = document.createElement("span");
  span.className = "correo-dtag";
  span.textContent = days === 0 ? "오늘" : `D+${days}`;
  return span;
}

interface ResolveResponse {
  ok: boolean;
  error?: string;
}

function resolveThread(threadId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "resolveThread", threadId }, (resp?: ResolveResponse) => {
      if (!resp?.ok) {
        reject(new Error(resp?.error || "처리에 실패했습니다."));
        return;
      }
      resolve();
    });
  });
}

interface AddTaskResponse {
  ok: boolean;
  error?: string;
}

// Module-level so the "완료" state survives a menu close/reopen without
// needing a round trip to Google Tasks to check.
const taskDoneThreads = new Set<string>();

function addTask(threadId: string, subject: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "addTaskFromThread", threadId, title: subject },
      (resp?: AddTaskResponse) => {
        if (!resp?.ok) {
          reject(new Error(resp?.error || "할 일 추가에 실패했습니다."));
          return;
        }
        taskDoneThreads.add(threadId);
        resolve();
      },
    );
  });
}

interface ListLabelsResponse {
  ok: boolean;
  labels?: LabelOut[];
  error?: string;
}

interface ApplyLabelResponse {
  ok: boolean;
  error?: string;
}

function fetchLabels(): Promise<LabelOut[]> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "listLabels" }, (resp?: ListLabelsResponse) => {
      if (!resp?.ok) {
        reject(new Error(resp?.error || "라벨 목록을 불러오지 못했습니다."));
        return;
      }
      resolve(resp.labels || []);
    });
  });
}

function applyLabel(threadId: string, labelId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "applyLabelToThread", threadId, labelId },
      (resp?: ApplyLabelResponse) => {
        if (!resp?.ok) {
          reject(new Error(resp?.error || "라벨 적용에 실패했습니다."));
          return;
        }
        resolve();
      },
    );
  });
}

// Only one of these floating popups (the label picker or the row menu) is
// ever open at a time.
let closeOpenPopup: (() => void) | null = null;

function closePopup() {
  closeOpenPopup?.();
  closeOpenPopup = null;
}

// Takes a snapshotted rect rather than re-measuring the anchor element,
// since the anchor is a hover-only row button (display:none once the
// pointer leaves the row) — by the time a second popup opens from within
// the first one, the mouse is over the popup rather than the row, so a
// fresh getBoundingClientRect() on the anchor would collapse to all zeros.
function positionNear(popup: HTMLElement, rect: DOMRect, width: number) {
  popup.style.top = `${rect.bottom + 4}px`;
  popup.style.left = `${Math.max(4, rect.right - width)}px`;
}

function trackOutsideClose(popup: HTMLElement, onClose: () => void) {
  function onOutsideClick(e: MouseEvent) {
    if (!popup.contains(e.target as Node)) onClose();
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
  // Deferred so the click that opened the popup doesn't immediately close
  // it via the same event bubbling up to document.
  setTimeout(() => {
    document.addEventListener("click", onOutsideClick);
    document.addEventListener("keydown", onKeyDown);
  }, 0);
  return () => {
    document.removeEventListener("click", onOutsideClick);
    document.removeEventListener("keydown", onKeyDown);
  };
}

function openLabelPicker(rect: DOMRect, threadId: string) {
  closePopup();

  const popup = document.createElement("div");
  popup.className = "correo-label-popup";
  positionNear(popup, rect, 240);

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "라벨 검색";
  popup.appendChild(input);

  const list = document.createElement("ul");
  popup.appendChild(list);

  function renderStatus(text: string, variant: "loading" | "error" | "empty") {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = `correo-label-popup-${variant}`;
    li.textContent = text;
    list.appendChild(li);
  }

  function renderLabels(labels: LabelOut[]) {
    const query = input.value.trim().toLowerCase();
    const filtered = query ? labels.filter((l) => l.name.toLowerCase().includes(query)) : labels;
    list.innerHTML = "";
    if (filtered.length === 0) {
      renderStatus("일치하는 라벨이 없습니다.", "empty");
      return;
    }
    filtered
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((label) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label.name;
        btn.title = label.name;
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          renderStatus("적용 중…", "loading");
          applyLabel(threadId, label.id)
            .then(() => {
              renderStatus(`"${label.name}" 라벨을 적용했습니다.`, "empty");
              setTimeout(closePopup, 600);
            })
            .catch((err: unknown) => renderStatus(String(err), "error"));
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
  }

  renderStatus("불러오는 중…", "loading");
  document.body.appendChild(popup);
  input.focus();

  let allLabels: LabelOut[] = [];
  fetchLabels()
    .then((labels) => {
      allLabels = labels;
      renderLabels(allLabels);
    })
    .catch((err: unknown) => renderStatus(String(err), "error"));

  input.addEventListener("input", () => renderLabels(allLabels));
  input.addEventListener("click", (e) => e.stopPropagation());
  popup.addEventListener("click", (e) => e.stopPropagation());

  const untrack = trackOutsideClose(popup, closePopup);
  closeOpenPopup = () => {
    popup.remove();
    untrack();
  };
}

function menuItem(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "correo-menu-item";
  btn.textContent = text;
  btn.disabled = disabled;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function openRowMenu(anchor: HTMLElement, threadId: string, subject: string, info: ThreadInfo) {
  closePopup();

  const rect = anchor.getBoundingClientRect();
  const popup = document.createElement("div");
  popup.className = "correo-row-menu";
  positionNear(popup, rect, 200);

  popup.appendChild(menuItem("라벨 붙이기…", () => openLabelPicker(rect, threadId)));

  const taskLabel = taskDoneThreads.has(threadId) ? "할 일에 추가됨 ✓" : "할 일로 추가";
  const taskBtn = menuItem(taskLabel, () => {
    taskBtn.disabled = true;
    taskBtn.textContent = "추가 중…";
    addTask(threadId, subject)
      .then(() => {
        taskBtn.textContent = "할 일에 추가됨 ✓";
      })
      .catch((err: unknown) => {
        taskBtn.disabled = false;
        taskBtn.textContent = taskLabel;
        taskBtn.title = String(err);
      });
  }, taskDoneThreads.has(threadId));
  popup.appendChild(taskBtn);

  if (info.awaiting) {
    popup.appendChild(
      menuItem("종결 처리", () => {
        closePopup();
        void resolveThread(threadId);
      }),
    );
  }

  const infoLine = document.createElement("div");
  infoLine.className = "correo-row-menu-info";
  infoLine.textContent = describeInfo(info);
  popup.appendChild(infoLine);

  document.body.appendChild(popup);
  popup.addEventListener("click", (e) => e.stopPropagation());

  const untrack = trackOutsideClose(popup, closePopup);
  closeOpenPopup = () => {
    popup.remove();
    untrack();
  };
}

function describeInfo(info: ThreadInfo): string {
  if (info.awaiting?.kind === "me") {
    const days = daysSince(info.awaiting.flag.lastDateMs);
    return `내가 답할 차례 · ${days === 0 ? "오늘 받음" : `${days}일 경과`}`;
  }
  if (info.awaiting?.kind === "them") {
    return `상대 답장 대기 · ${daysSince(info.awaiting.flag.lastDateMs)}일`;
  }
  if (info.tag?.toOrCc === "cc") return "참조로 받은 메일";
  if (info.tag?.isGeneric) return "공용 주소로 추정";
  return "처리할 것 없음";
}

function makeMenuButton(threadId: string, subject: string, info: ThreadInfo): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "correo-menu-btn";
  btn.textContent = "Correo ▾";
  btn.title = "Correo 메뉴";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRowMenu(btn, threadId, subject, info);
  });
  return btn;
}

function scan(infoMap: Map<string, ThreadInfo>) {
  // TEMP DEBUG
  void infoMap;
  const nodes = document.querySelectorAll<HTMLElement>(
    `[data-legacy-thread-id]:not([${PROCESSED_ATTR}])`,
  );
  nodes.forEach((node) => {
    node.setAttribute(PROCESSED_ATTR, "1");
    const threadId = node.getAttribute("data-legacy-thread-id");
    if (!threadId) return;
    // Must be read before the group is inserted, otherwise it'd include the
    // group's own button labels.
    const subject = node.textContent?.trim() || "(제목 없음)";
    const info = infoMap.get(threadId) ?? { tag: null, awaiting: null };
    // Addressed to me directly (To, whoever is on Cc) - highlight the row.
    const toMe = !!info.tag?.lastReceivedTo?.some((a) => highlightSet.has(a));
    // Gmail may reuse a row element for a different thread, so reset first.
    node.closest("tr.zA")?.classList.toggle(TO_ME_CLASS, toMe);
    // TEMP DEBUG: expose what the highlight decision was based on.
    node.closest("tr.zA")?.setAttribute(
      "data-correo-dbg",
      JSON.stringify({ tag: !!info.tag, to: info.tag?.lastReceivedTo ?? null, toOrCc: info.tag?.toOrCc ?? null, hl: [...highlightSet], mapSize: infoMap.size }),
    );

    const group = document.createElement("span");
    group.className = "correo-badge-group";
    const dtag = makeDtag(info);
    if (dtag) group.appendChild(dtag);
    group.appendChild(makeMenuButton(threadId, subject, info));
    node.insertBefore(group, node.firstChild);
  });
}

function clearBadges() {
  closePopup();
  document.querySelectorAll(".correo-badge-group").forEach((el) => el.remove());
  document.querySelectorAll(`.${TO_ME_CLASS}`).forEach((el) => el.classList.remove(TO_ME_CLASS));
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => el.removeAttribute(PROCESSED_ATTR));
}

const LABEL_CHIP_HIDDEN_CLASS = "correo-label-chip-hidden";

// Gmail shows a parent label chip (e.g. "08_마케팅팀") and a more specific
// child chip using its "/"-nesting convention (e.g. "08_마케팅팀/04_일라") side
// by side when a message has both applied — wasting row width on a chip
// that's already implied by the more specific one. Hide the parent chip only
// when some other chip in the same row is an exact "<parent>/" prefix of it
// (checked via the chip's full visible text, which Gmail renders as the
// whole path rather than just the leaf segment) — a plain substring check
// would risk false positives on coincidentally similar label names.
function hideRedundantLabelChips() {
  document.querySelectorAll<HTMLElement>("tr.zA").forEach((row) => {
    const chips = Array.from(row.querySelectorAll<HTMLElement>("div.ar.as"));
    if (chips.length < 2) return;
    const texts = chips.map((chip) => chip.textContent?.trim() || "");
    chips.forEach((chip, i) => {
      const text = texts[i];
      const isRedundant =
        text !== "" && texts.some((other, j) => j !== i && other.startsWith(`${text}/`));
      chip.classList.toggle(LABEL_CHIP_HIDDEN_CLASS, isRedundant);
    });
  });
}

// Addresses whose direct mail is highlighted: the user's chosen list, or the
// account's primary address when they haven't chosen. Read at display time so
// editing the list in Settings takes effect without another sync.
let highlightSet = new Set<string>();

async function loadHighlightSet(): Promise<void> {
  const s = await chrome.storage.local.get([CACHE_KEY, "correo_aliases"]);
  const email = (s[CACHE_KEY] as { email?: string } | undefined)?.email;
  const chosen = (s["correo_aliases"] as { highlight?: string[] } | undefined)?.highlight;
  const list = chosen ?? (email ? [email] : []);
  highlightSet = new Set(list.map((a) => a.trim().toLowerCase()));
}

const AUTO_SYNC_MAX_AGE_MS = 5 * 60_000;

// The Gmail overlay (badges, highlights) reads the cached sync result, so a
// stale cache silently leaves new mail unmarked. Refresh it from here via the
// background worker whenever it is older than a few minutes, instead of
// waiting for the side panel to be opened.
async function syncIfStale(): Promise<void> {
  const s = await chrome.storage.local.get(CACHE_KEY);
  const cached = s[CACHE_KEY] as { syncedAtMs?: number; summary?: ActivitySummary } | undefined;
  // TEMP DEBUG
  document.documentElement.setAttribute(
    "data-correo-cache",
    JSON.stringify({
      syncedAt: cached?.syncedAtMs ? new Date(cached.syncedAtMs).toLocaleString("ko-KR") : null,
      threads: cached?.summary?.allThreads?.length ?? null,
      newestLast: Math.max(0, ...(cached?.summary?.allThreads ?? []).map((t) => t.lastDateMs ?? 0)) || null,
    }),
  );
  if (cached?.syncedAtMs && Date.now() - cached.syncedAtMs < AUTO_SYNC_MAX_AGE_MS) return;
  chrome.runtime.sendMessage({ type: "syncNow", auto: true }, (resp?: { ok?: boolean; error?: string }) => {
    document.documentElement.setAttribute("data-correo-sync", JSON.stringify(resp ?? { ok: false, error: "no response" }));
  });
}

async function loadSummary(): Promise<ActivitySummary | null> {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cached = stored[CACHE_KEY] as { summary: ActivitySummary } | undefined;
  return cached?.summary ?? null;
}

const PANEL_WIDTH_KEY = "correo_panel_width";
const DEFAULT_PANEL_WIDTH = 760;
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 900;

// Set once mountSidePanel finishes, so the "openSidePanel" runtime message
// (sent from popup.js's "사이드 패널로 열기" choice) can open the same panel
// instance instead of reaching into its closure.
let openSidePanelFromOutside: ((filter?: string) => void) | null = null;

// Lets Correo's full app (home dashboard, labels, contacts, settings) be
// used as a slide-in panel over Gmail itself, as an alternative to opening
// it in its own tab. It's just the same built app in an iframe — no logic
// is duplicated here.
async function mountSidePanel() {
  if (document.getElementById("correo-side-panel")) return;

  const stored = await chrome.storage.local.get(PANEL_WIDTH_KEY);
  const savedWidth = stored[PANEL_WIDTH_KEY] as number | undefined;

  const toggle = document.createElement("button");
  toggle.id = "correo-side-toggle";
  toggle.type = "button";
  toggle.title = "Correo 열기";
  toggle.textContent = "Correo";

  const panel = document.createElement("div");
  panel.id = "correo-side-panel";
  panel.style.width = `${savedWidth || DEFAULT_PANEL_WIDTH}px`;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "correo-side-panel-resize";

  const iframe = document.createElement("iframe");
  iframe.className = "correo-side-panel-frame";
  const baseSrc = chrome.runtime.getURL("index.html");

  panel.appendChild(resizeHandle);
  panel.appendChild(iframe);

  function setOpen(open: boolean, filter?: string) {
    if (open) {
      const url = filter ? `${baseSrc}?filter=${encodeURIComponent(filter)}` : baseSrc;
      // Reloading on every "open with a specific filter" request is cheap
      // for a mail app and much simpler than post-messaging a live state
      // change into an already-mounted iframe.
      if (filter || !iframe.src) iframe.src = url;
    }
    panel.classList.toggle("correo-side-panel-open", open);
    toggle.classList.toggle("correo-side-toggle-hidden", open);
  }

  toggle.addEventListener("click", () => setOpen(true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("correo-side-panel-open")) setOpen(false);
  });
  window.addEventListener("message", (e) => {
    if (e.source === iframe.contentWindow && e.data?.source === "correo" && e.data?.type === "close") {
      setOpen(false);
    }
  });

  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    panel.classList.add("correo-side-panel-resizing");
    function onMove(moveEvent: MouseEvent) {
      const width = Math.min(
        MAX_PANEL_WIDTH,
        Math.max(MIN_PANEL_WIDTH, window.innerWidth - moveEvent.clientX),
      );
      panel.style.width = `${width}px`;
    }
    function onUp() {
      panel.classList.remove("correo-side-panel-resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const width = parseInt(panel.style.width, 10);
      if (!Number.isNaN(width)) void chrome.storage.local.set({ [PANEL_WIDTH_KEY]: width });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  openSidePanelFromOutside = (filter) => setOpen(true, filter);
}

async function main() {
  initComposeTracking();
  await mountSidePanel();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: unknown; filter?: unknown };
    if (msg?.type === "openSidePanel") {
      openSidePanelFromOutside?.(typeof msg.filter === "string" ? msg.filter : undefined);
      sendResponse({ ok: true });
    }
  });

  await loadHighlightSet();
  let infoMap = buildThreadInfoMap(await loadSummary());
  scan(infoMap);
  hideRedundantLabelChips();

  // Gmail is a long-lived single-page app that keeps re-rendering rows as
  // you scroll/navigate, so a periodic re-scan is simpler and more robust
  // than trying to track every mutation precisely.
  setInterval(() => {
    scan(infoMap);
    hideRedundantLabelChips();
    applyReadTags();
  }, 1500);

  setTrackedSendHook(() => {
    // Gmail needs ~20s to finish sending before the sent copy can be found.
    setTimeout(() => void refreshReadStates(), 25_000);
  });
  void syncIfStale();
  setInterval(() => void syncIfStale(), 60_000);
  void refreshReadStates();
  setInterval(() => void refreshReadStates(), 60_000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes[CACHE_KEY] || changes["correo_aliases"])) return;
    void (async () => {
      await loadHighlightSet();
      infoMap = buildThreadInfoMap(await loadSummary());
      clearBadges();
      scan(infoMap);
    })();
  });
}

void main();
