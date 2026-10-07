// Adds the read-tracking pixel to outgoing mail at the moment "보내기" is
// pressed. Gmail's compose DOM has no stable public API, so this leans on its
// long-stable structural class names (aoO = Send button, M9 = compose view)
// and standard attributes instead of localized labels.
import { TRACKED_KEY, loadTrackerConfig, type TrackedMail } from "../tracking";

const PIXEL_ATTR = "data-correo-pixel";

// Lets the list badges refresh shortly after a send instead of waiting for
// the next periodic poll.
let onTrackedSend: (() => void) | null = null;
export function setTrackedSendHook(fn: () => void): void {
  onTrackedSend = fn;
}

function mintId(): string {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 12);
  return `${Date.now().toString(36)}-${rand}`;
}

function composeRootOf(el: Element): Element {
  return el.closest(".M9") ?? el.closest('[role="dialog"]') ?? document.body;
}

function collectRecipients(root: Element): string[] {
  const out = new Set<string>();
  root.querySelectorAll("[email], [data-hovercard-id]").forEach((n) => {
    const v = (n.getAttribute("email") || n.getAttribute("data-hovercard-id") || "").toLowerCase();
    if (v.includes("@")) out.add(v);
  });
  root.querySelectorAll('input[name="to"], input[name="cc"]').forEach((n) => {
    const v = (n as HTMLInputElement).value;
    for (const m of v.matchAll(/[\w.+-]+@[\w.-]+/g)) out.add(m[0].toLowerCase());
  });
  return [...out];
}

async function remember(entry: TrackedMail): Promise<void> {
  const s = await chrome.storage.local.get(TRACKED_KEY);
  const list = ((s[TRACKED_KEY] as TrackedMail[] | undefined) ?? []).filter((t) => t.id !== entry.id);
  list.push(entry);
  await chrome.storage.local.set({ [TRACKED_KEY]: list.slice(-500) });
}

let cfgCache: { url: string; enabled: boolean } = { url: "", enabled: false };

async function refreshConfig() {
  const c = await loadTrackerConfig();
  cfgCache = { url: c.url, enabled: c.enabled && !!c.url };
}

const BODY_SEL = 'div[g_editable="true"][role="textbox"]';

// Must run synchronously inside the mousedown/keydown handler (before Gmail
// reads the body to send), which is why the config is cached rather than awaited.
function injectPixel(root: Element, scheduled = false): void {
  if (!scheduled) onTrackedSend?.();
  if (!cfgCache.enabled) return;
  const body = root.querySelector<HTMLElement>(BODY_SEL);
  if (!body) return;
  const subject = root.querySelector<HTMLInputElement>('input[name="subjectbox"]')?.value ?? "";

  // Already has a pixel (retry after a failed send, or the send-options menu
  // was opened earlier): keep it, but refresh its record with the latest
  // click time and whether this click was a scheduled send.
  const existing = body.querySelector<HTMLImageElement>(`img[${PIXEL_ATTR}]`);
  if (existing) {
    void remember({ id: existing.getAttribute(PIXEL_ATTR) as string, subject, to: collectRecipients(root), sentMs: Date.now(), scheduled });
    return;
  }

  const id = mintId();
  const img = document.createElement("img");
  img.setAttribute(PIXEL_ATTR, id);
  img.src = `${cfgCache.url}/p/${id}.gif`;
  img.width = 1;
  img.height = 1;
  img.alt = "";
  body.appendChild(img);

  void remember({ id, subject, to: collectRecipients(root), sentMs: Date.now(), scheduled });
}

export function initComposeTracking(): void {
  void refreshConfig();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["correo_tracker"]) void refreshConfig();
  });

  // Gmail's toolbar buttons fire their action on mousedown/mouseup, i.e.
  // *before* the synthesized "click", so the pixel has to be in the body by
  // mousedown or it misses the outgoing message.
  for (const type of ["pointerdown", "mousedown", "click"]) {
    document.addEventListener(
      type,
      (e) => {
        const target = e.target as Element | null;
        const btn = target?.closest?.(".T-I.aoO");
        if (btn) {
          injectPixel(composeRootOf(btn));
          return;
        }
        // "보내기 옵션 더보기" (the arrow beside 보내기) is the only way into
        // 예약 전송; the pixel has to be in the body before the schedule is
        // confirmed, and a normal 보내기 later overwrites this as unscheduled.
        const opts = target?.closest?.(".T-I.hG");
        if (opts) injectPixel(composeRootOf(opts), true);
      },
      true,
    );
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
      const t = e.target as Element | null;
      if (t?.closest?.(BODY_SEL)) injectPixel(composeRootOf(t));
    },
    true,
  );
}
