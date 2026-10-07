import { getAuthToken } from "./auth";
import { loadAliasConfig, normalizeAddress } from "../aliases";
import type {
  ActivitySummary,
  CachedActivity,
  Correspondent,
  LabelOut,
  ThreadFlag,
  ThreadTag,
} from "../types";

const RESOLVED_LABEL_NAME = "Correo/처리됨";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Labels' "라벨 정리" reordering prefixes each path segment with a number to
// control sidebar order (e.g. "Correo/처리됨" becomes "Correo/01_처리됨"), so
// matching a well-known label like RESOLVED_LABEL_NAME by its literal name
// would silently create a duplicate the moment it gets reordered. Stripping
// any leading "NN_" from each segment before comparing keeps the match
// stable across that renaming.
function stripLabelOrderPrefix(segment: string): string {
  return segment.replace(/^\d+_/, "");
}

function normalizeLabelName(name: string): string {
  return name.split("/").map(stripLabelOrderPrefix).join("/").toLowerCase();
}

function findLabelByLogicalName(labels: LabelOut[], logicalName: string): LabelOut | undefined {
  const target = normalizeLabelName(logicalName);
  return labels.find((l) => normalizeLabelName(l.name) === target);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Gmail's per-user quota is ~6000 units/min; hitting it returns 429, or 403
// with reason rateLimitExceeded. Those clear on their own, so back off and
// retry instead of failing the whole operation.
async function gmailFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken(false);
  let delay = 3000;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${GMAIL_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (resp.ok || attempt >= 4) return resp;
    let rateLimited = resp.status === 429;
    if (resp.status === 403) {
      const body = await resp.clone().text();
      rateLimited = /rateLimitExceeded|userRateLimitExceeded/.test(body);
    }
    if (!rateLimited) return resp;
    await sleep(delay);
    delay *= 2;
  }
}

async function gmailJson<T>(path: string, context: string, init?: RequestInit): Promise<T> {
  const resp = await gmailFetch(path, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${context} 실패 (${resp.status}): ${text}`);
  }
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${context} 응답 해석 실패: ${e} / 응답 내용: ${text.slice(0, 300)}`);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeText(text: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(text));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ---- Labels ----

export async function listLabels(): Promise<LabelOut[]> {
  const data = await gmailJson<{ labels?: LabelOut[] }>("/labels", "라벨 목록 조회");
  return (data.labels || []).filter((l) => l.type === "user");
}

// Mirrors Gmail's own "is:unread" search default (excludes Spam/Trash), so
// this matches what a user means by "unread mail" — regardless of which of
// their own labels it's since been filed under, unlike the sidebar's
// per-label INBOX unread count which only counts mail still in the Inbox.
export async function getUnreadCount(): Promise<number> {
  const data = await gmailJson<{ resultSizeEstimate?: number }>(
    "/messages?q=is:unread&maxResults=1",
    "안 읽은 메일 수 조회",
  );
  return data.resultSizeEstimate ?? 0;
}

async function findOrCreateLabel(name: string): Promise<string> {
  const data = await gmailJson<{ labels?: LabelOut[] }>("/labels", "라벨 목록 조회");
  const existing = findLabelByLogicalName(data.labels || [], name);
  if (existing) return existing.id;
  const created = await gmailJson<LabelOut>("/labels", "라벨 생성", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return created.id;
}

export async function ensureLabel(name: string): Promise<LabelOut> {
  const data = await gmailJson<{ labels?: LabelOut[] }>("/labels", "라벨 목록 조회");
  const existing = (data.labels || []).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return gmailJson<LabelOut>("/labels", "라벨 생성", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function renameLabel(labelId: string, newName: string): Promise<void> {
  await gmailJson(`/labels/${labelId}`, "라벨 이름 변경", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export async function getLabelMessageCount(labelId: string): Promise<number> {
  const data = await gmailJson<{ messagesTotal?: number }>(`/labels/${labelId}`, "라벨 정보 조회");
  return data.messagesTotal ?? 0;
}

export async function deleteLabel(labelId: string): Promise<void> {
  const resp = await gmailFetch(`/labels/${labelId}`, { method: "DELETE" });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`라벨 삭제 실패 (${resp.status}): ${text}`);
  }
}

async function messageIdsByLabel(labelId: string): Promise<string[]> {
  const messageIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ labelIds: labelId, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailJson<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `/messages?${params.toString()}`,
      "라벨별 메일 조회",
    );
    messageIds.push(...(data.messages || []).map((m) => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken && messageIds.length < 5000);
  return messageIds;
}

export async function mergeLabels(sourceLabelId: string, targetLabelId: string): Promise<number> {
  const messageIds = await messageIdsByLabel(sourceLabelId);
  for (let i = 0; i < messageIds.length; i += 1000) {
    const chunk = messageIds.slice(i, i + 1000);
    await gmailJson("/messages/batchModify", "라벨 병합 적용", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: chunk,
        addLabelIds: [targetLabelId],
        removeLabelIds: [sourceLabelId],
      }),
    });
  }
  await deleteLabel(sourceLabelId);
  return messageIds.length;
}

export async function createFilter(
  query: string,
  labelId: string,
  archive: boolean,
): Promise<void> {
  const action: Record<string, string[]> = { addLabelIds: [labelId] };
  if (archive) action.removeLabelIds = ["INBOX"];
  await gmailJson("/settings/filters", "필터 생성", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria: { query }, action }),
  });
}

async function searchMessageIds(query: string): Promise<string[]> {
  const messageIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: query, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailJson<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `/messages?${params.toString()}`,
      "메일 검색",
    );
    messageIds.push(...(data.messages || []).map((m) => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken && messageIds.length < 5000);
  return messageIds;
}

async function batchAddLabel(messageIds: string[], labelId: string, archive: boolean): Promise<void> {
  for (let i = 0; i < messageIds.length; i += 1000) {
    const chunk = messageIds.slice(i, i + 1000);
    const body: Record<string, unknown> = { ids: chunk, addLabelIds: [labelId] };
    if (archive) body.removeLabelIds = ["INBOX"];
    await gmailJson("/messages/batchModify", "기존 메일에 라벨 적용", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

export async function applyLabelToExisting(
  query: string,
  labelId: string,
  archive: boolean,
): Promise<number> {
  const messageIds = await searchMessageIds(query);
  await batchAddLabel(messageIds, labelId, archive);
  return messageIds.length;
}

// Gmail's `to:` search/filter syntax only checks whether an address is
// *among* the recipients - it can't express "and nobody else was in To" - so
// a "solo recipient" rule has to fetch each candidate message's real To
// header and verify the To list is exactly that one address. Cc is
// deliberately ignored: mail with other people only in Cc still counts.
export async function applySoloRecipientLabel(
  address: string,
  labelId: string,
  archive: boolean,
): Promise<number> {
  const target = address.trim().toLowerCase();
  const candidateIds = await searchMessageIds(`to:${target}`);

  const checked = await mapWithConcurrency(candidateIds, 8, async (id) => {
    const params = new URLSearchParams({ format: "metadata" });
    params.append("metadataHeaders", "To");
    try {
      const msg = await gmailJson<{ payload?: { headers?: HeaderKV[] } }>(
        `/messages/${id}?${params.toString()}`,
        "메일 헤더 조회",
      );
      const to = msg.payload?.headers?.find((h) => h.name.toLowerCase() === "to")?.value || "";
      const recipients = new Set(extractAddresses(to).map((a) => a.addr));
      return recipients.size === 1 && recipients.has(target) ? id : null;
    } catch {
      return null;
    }
  });

  const messageIds = checked.filter((id): id is string => id !== null);
  await batchAddLabel(messageIds, labelId, archive);
  return messageIds.length;
}

const CC_ONLY_LABEL_NAME = "Correo/참조 메일";
// Gmail search syntax: mail where I'm Cc'd but not a direct "To" recipient.
const CC_ONLY_QUERY = "cc:me -to:me";

export async function setUpCcOnlySeparation(archive: boolean): Promise<number> {
  const labelId = await findOrCreateLabel(CC_ONLY_LABEL_NAME);
  await createFilter(CC_ONLY_QUERY, labelId, archive);
  return applyLabelToExisting(CC_ONLY_QUERY, labelId, archive);
}

// ---- Import / forward ----

export async function importEml(bytes: Uint8Array): Promise<void> {
  const raw = base64UrlEncodeBytes(bytes);
  await gmailJson(
    "/messages/import?internalDateSource=dateHeader&neverMarkSpam=true",
    "Gmail 가져오기",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    },
  );
}

function encodeMimeWord(text: string): string {
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return `=?UTF-8?B?${b64}?=`;
}

function wrapBase64(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9-_]/g, "_");
  return cleaned || "forwarded";
}

export async function forwardEml(
  bytes: Uint8Array,
  subject: string,
  fromEmail: string,
  to: string,
  note: string | null,
): Promise<void> {
  const boundary = `----correo-${Math.random().toString(36).slice(2)}`;
  const attachmentName = `${sanitizeFilename(subject)}.eml`;
  const bodyText = note || "첨부된 이메일을 전달합니다.";
  const attachmentB64 = wrapBase64(bytesToBase64(bytes));

  const mime = [
    `From: "Correo" <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${encodeMimeWord(`Fwd: ${subject}`)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    bodyText,
    ``,
    `--${boundary}`,
    `Content-Type: message/rfc822; name="${attachmentName}"`,
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    attachmentB64,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");

  const raw = base64UrlEncodeText(mime);
  await gmailJson("/messages/send", "Gmail 전달", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
}

// ---- Correspondent / reply-tracking sync ----

const GENERIC_PREFIXES = [
  "info", "sales", "support", "admin", "contact", "no-reply", "noreply",
  "help", "team", "office", "service", "hr", "marketing", "billing",
  "orders", "order", "notice", "notification", "notifications", "newsletter",
  "webmaster", "postmaster", "enquiry", "enquiries", "inquiry", "inquiries",
  "cs", "care", "general", "mail", "hello", "press", "media", "pr",
];

function isGenericAddress(addr: string): boolean {
  const local = (addr.split("@")[0] || "").toLowerCase();
  return GENERIC_PREFIXES.some(
    (p) => local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}-`) || local.startsWith(`${p}_`),
  );
}

function extractAddresses(raw: string): { addr: string; name: string | null }[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const start = part.lastIndexOf("<");
      const end = part.lastIndexOf(">");
      if (start !== -1 && end > start) {
        const addr = part.slice(start + 1, end).trim().toLowerCase();
        const namePart = part.slice(0, start).trim().replace(/^"|"$/g, "");
        if (!addr.includes("@")) return null;
        return { addr, name: namePart || null };
      }
      const addr = part.toLowerCase();
      if (!addr.includes("@")) return null;
      return { addr, name: null };
    })
    .filter((x): x is { addr: string; name: string | null } => x !== null);
}

interface HeaderKV {
  name: string;
  value: string;
}
interface MessageMeta {
  payload?: { headers?: HeaderKV[] };
  internalDate?: string;
  labelIds?: string[];
}
interface ThreadGetResponse {
  id: string;
  messages?: MessageMeta[];
}

function headerValue(msg: MessageMeta, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

// ---- "Which addresses are me" ----

// Gmail treats every send-as alias as "me", and a Google Group address that
// is also a send-as alias ends up in the Sent folder even for mail someone
// else wrote (the group re-sends it "From: <person> via <group>" with the
// group's address). So "me" has to be the whole alias set, and a group-
// reflected message has to be attributed to its real author.
export interface AddressInfo {
  primary: string;
  sendAs: string[]; // as reported by Gmail, primary included
}

let addressInfoMemo: { at: number; info: AddressInfo } | null = null;

export async function loadAddressInfo(): Promise<AddressInfo> {
  // Profile and send-as rarely change; every Correo page and sync used to
  // re-fetch them, which counted against the quota for nothing.
  if (addressInfoMemo && Date.now() - addressInfoMemo.at < 10 * 60_000) return addressInfoMemo.info;
  const profile = await gmailJson<{ emailAddress: string }>("/profile", "프로필 조회");
  const primary = profile.emailAddress.toLowerCase();
  const sendAs = new Set<string>([primary]);
  try {
    const data = await gmailJson<{ sendAs?: { sendAsEmail: string }[] }>(
      "/settings/sendAs",
      "보내는 주소 조회",
    );
    for (const a of data.sendAs || []) sendAs.add(a.sendAsEmail.toLowerCase());
  } catch {
    // Alias list is best-effort; fall back to the primary address alone.
  }
  const info = { primary, sendAs: [...sendAs] };
  addressInfoMemo = { at: Date.now(), info };
  return info;
}

async function loadMyAddresses(): Promise<{ primary: string; all: Set<string> }> {
  const [info, cfg] = await Promise.all([loadAddressInfo(), loadAliasConfig()]);
  const excluded = new Set(cfg.excluded.map(normalizeAddress));
  const all = new Set<string>([info.primary]);
  for (const a of info.sendAs) if (!excluded.has(a)) all.add(a);
  for (const a of cfg.extra) all.add(normalizeAddress(a));
  return { primary: info.primary, all };
}

const SENDER_HEADERS = ["From", "To", "Cc", "Subject", "X-Original-Sender", "X-Original-From", "List-Id"];

// The message's real author addresses. Mail reflected by a mailing list / Google
// Group carries the group's address in From; the true sender is in
// X-Original-Sender (or X-Original-From).
function senderAddresses(msg: MessageMeta, _myAddrs: Set<string>): { addr: string; name: string | null }[] {
  const from = extractAddresses(headerValue(msg, "From") || "");
  const orig = extractAddresses(headerValue(msg, "X-Original-From") || "");
  const origSender = extractAddresses(headerValue(msg, "X-Original-Sender") || "");
  const real = orig.length ? orig : origSender;
  return real.length ? real : from;
}

interface Agg {
  name: string | null;
  sent: number;
  received: number;
  last: number | null;
  awaitingMyReply: boolean;
  awaitingTheirReply: boolean;
}

function activityCacheKey(): string {
  return "correo_activity_cache";
}

export async function loadActivityCache(): Promise<CachedActivity | null> {
  const stored = await chrome.storage.local.get(activityCacheKey());
  return (stored[activityCacheKey()] as CachedActivity | undefined) ?? null;
}

async function saveActivityCache(cached: CachedActivity): Promise<void> {
  await chrome.storage.local.set({ [activityCacheKey()]: cached });
}

async function removeThreadFromCache(threadId: string): Promise<void> {
  const cached = await loadActivityCache();
  if (!cached) return;
  cached.summary.awaitingMyReply = cached.summary.awaitingMyReply.filter(
    (t) => t.threadId !== threadId,
  );
  cached.summary.awaitingTheirReply = cached.summary.awaitingTheirReply.filter(
    (t) => t.threadId !== threadId,
  );
  const tag = cached.summary.allThreads?.find((t) => t.threadId === threadId);
  if (tag) tag.isResolved = true;
  await saveActivityCache(cached);
}

export async function addLabelToThread(threadId: string, labelId: string): Promise<void> {
  await gmailJson(`/threads/${threadId}/modify`, "라벨 적용", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

export async function markThreadResolved(threadId: string): Promise<void> {
  const labelId = await findOrCreateLabel(RESOLVED_LABEL_NAME);
  await gmailJson(`/threads/${threadId}/modify`, "종결 처리", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
  await removeThreadFromCache(threadId);
}

export async function unmarkThreadResolved(threadId: string): Promise<void> {
  const data = await gmailJson<{ labels?: LabelOut[] }>("/labels", "라벨 목록 조회");
  const label = findLabelByLogicalName(data.labels || [], RESOLVED_LABEL_NAME);
  if (!label) return;
  await gmailJson(`/threads/${threadId}/modify`, "종결 해제", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: [label.id] }),
  });
}

interface DigestStore {
  threads: Record<string, { h: string; t: ThreadGetResponse }>;
}

const DIGEST_KEY = "correo_thread_digests";

async function loadDigestStore(): Promise<DigestStore> {
  const stored = await chrome.storage.local.get(DIGEST_KEY);
  return (stored[DIGEST_KEY] as DigestStore | undefined) ?? { threads: {} };
}

async function saveDigestStore(store: DigestStore): Promise<void> {
  await chrome.storage.local.set({ [DIGEST_KEY]: store });
}

export async function syncActivity(days: number): Promise<ActivitySummary> {
  const { primary: myEmail, all: myAddrs } = await loadMyAddresses();

  const labelData = await gmailJson<{ labels?: LabelOut[] }>("/labels", "라벨 목록 조회");
  const resolvedLabelId = findLabelByLogicalName(labelData.labels || [], RESOLVED_LABEL_NAME)?.id;

  const listed: { id: string; historyId?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: `newer_than:${days}d`, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailJson<{ threads?: { id: string; historyId?: string }[]; nextPageToken?: string }>(
      `/threads?${params.toString()}`,
      "스레드 목록 조회",
    );
    listed.push(...(data.threads || []));
    pageToken = data.nextPageToken;
  } while (pageToken && listed.length < 2000);

  // Incremental: a thread's historyId changes whenever anything in it does,
  // so only new/changed threads are fetched (10 quota units each); the rest
  // come from the stored copy. A full 90-day scan is then a one-time cost.
  const store = await loadDigestStore();
  const nextStore: DigestStore = { threads: {} };
  const headersWanted = [...SENDER_HEADERS, "Date"];
  let nextSlot = Date.now();
  const threads = await mapWithConcurrency(listed, 6, async (entry) => {
    const hit = store.threads[entry.id];
    if (hit && entry.historyId && hit.h === entry.historyId) {
      nextStore.threads[entry.id] = hit;
      return hit.t;
    }
    // Pace uncached fetches to stay under the per-minute quota (~7 threads/s).
    const slot = Math.max(Date.now(), nextSlot);
    nextSlot = slot + 130;
    if (slot > Date.now()) await sleep(slot - Date.now());
    const params = new URLSearchParams({ format: "metadata" });
    for (const h of headersWanted) params.append("metadataHeaders", h);
    try {
      const t = await gmailJson<ThreadGetResponse>(`/threads/${entry.id}?${params.toString()}`, "스레드 조회");
      if (entry.historyId) nextStore.threads[entry.id] = { h: entry.historyId, t };
      return t;
    } catch {
      return null;
    }
  });
  await saveDigestStore(nextStore);

  const agg = new Map<string, Agg>();
  const awaitingMyReply: ThreadFlag[] = [];
  const awaitingTheirReply: ThreadFlag[] = [];
  const allThreads: ThreadTag[] = [];
  let threadsScanned = 0;
  let resolvedHidden = 0;

  function bump(addr: string, name: string | null, kind: "sent" | "received", ts: number | null) {
    let entry = agg.get(addr);
    if (!entry) {
      entry = { name: null, sent: 0, received: 0, last: null, awaitingMyReply: false, awaitingTheirReply: false };
      agg.set(addr, entry);
    }
    entry[kind] += 1;
    if (!entry.name && name) entry.name = name;
    if (ts !== null && (entry.last === null || ts > entry.last)) entry.last = ts;
  }

  for (const thread of threads) {
    if (!thread || !thread.messages || thread.messages.length === 0) continue;
    threadsScanned++;

    const isResolved =
      !!resolvedLabelId && thread.messages.some((m) => (m.labelIds || []).includes(resolvedLabelId));
    if (isResolved) resolvedHidden++;

    const subject = headerValue(thread.messages[0], "Subject") || "(제목 없음)";

    // Tracks the most recent *received* message specifically (as opposed to
    // lastMsg below, which is just whichever message — mine or theirs —
    // came last), so "오늘/이번 주 받은 메일" can list messages by when they
    // actually arrived and know whether they've since been answered.
    let lastReceivedMs: number | null = null;
    let lastReceivedAddr: string | null = null;
    let lastReceivedName: string | null = null;
    let lastReceivedToMe = false;
    let lastReceivedTo: string[] = [];
    let repliedAfterLastReceived = false;

    for (const msg of thread.messages) {
      const fromAddrs = senderAddresses(msg, myAddrs);
      const isMine = fromAddrs.some((a) => myAddrs.has(a.addr));
      const ts = msg.internalDate ? parseInt(msg.internalDate, 10) : null;

      if (isMine) {
        if (ts !== null && lastReceivedMs !== null && ts > lastReceivedMs) {
          repliedAfterLastReceived = true;
        }
        const recipients: { addr: string; name: string | null }[] = [];
        for (const h of ["To", "Cc"]) {
          const raw = headerValue(msg, h);
          if (raw) recipients.push(...extractAddresses(raw));
        }
        for (const { addr, name } of recipients) {
          if (myAddrs.has(addr)) continue;
          bump(addr, name, "sent", ts);
        }
      } else {
        const sender = fromAddrs.find((a) => !myAddrs.has(a.addr));
        if (sender && ts !== null) {
          lastReceivedMs = ts;
          lastReceivedAddr = sender.addr;
          lastReceivedName = sender.name;
          lastReceivedTo = extractAddresses(headerValue(msg, "To") || "").map((a) => a.addr).slice(0, 30);
          lastReceivedToMe = lastReceivedTo.some((a) => myAddrs.has(a));
          repliedAfterLastReceived = false;
        }
        for (const { addr, name } of fromAddrs) {
          if (myAddrs.has(addr)) continue;
          bump(addr, name, "received", ts);
        }
      }
    }

    const lastMsg = thread.messages[thread.messages.length - 1];
    const lastFromAddrs = senderAddresses(lastMsg, myAddrs);
    const lastIsMine = lastFromAddrs.some((a) => myAddrs.has(a.addr));
    const lastTs = lastMsg.internalDate ? parseInt(lastMsg.internalDate, 10) : null;

    // Inbox-wide tag: was I addressed directly (To) or only Cc'd, and does
    // the counterpart look like a shared/team inbox? Computed for every
    // thread regardless of reply status, so the Gmail overlay can tag every
    // row without anyone opening it.
    let tagAddr: string | null = null;
    let tagName: string | null = null;
    let toOrCc: "to" | "cc" | null = null;
    if (lastIsMine) {
      const to = extractAddresses(headerValue(lastMsg, "To") || "").find((a) => !myAddrs.has(a.addr));
      if (to) {
        tagAddr = to.addr;
        tagName = to.name;
      }
    } else {
      const counterpart = lastFromAddrs.find((a) => !myAddrs.has(a.addr));
      if (counterpart) {
        tagAddr = counterpart.addr;
        tagName = counterpart.name;
        const toHasMe = extractAddresses(headerValue(lastMsg, "To") || "").some((a) => myAddrs.has(a.addr));
        const ccHasMe = extractAddresses(headerValue(lastMsg, "Cc") || "").some((a) => myAddrs.has(a.addr));
        toOrCc = toHasMe ? "to" : ccHasMe ? "cc" : null;
      }
    }
    allThreads.push({
      threadId: thread.id,
      subject,
      counterpartAddress: tagAddr,
      counterpartName: tagName,
      toOrCc,
      isGeneric: tagAddr ? isGenericAddress(tagAddr) : false,
      lastDateMs: lastTs,
      isResolved,
      lastReceivedMs,
      lastReceivedAddress: lastReceivedAddr,
      lastReceivedName,
      repliedAfterLastReceived,
      lastReceivedToMe,
      lastReceivedTo,
    });

    if (isResolved) continue;

    if (lastIsMine) {
      const hasOtherEarlier = thread.messages.some((m) =>
        senderAddresses(m, myAddrs).some((a) => !myAddrs.has(a.addr)),
      );
      if (hasOtherEarlier) {
        let primary = extractAddresses(headerValue(lastMsg, "To") || "").filter(
          (a) => !myAddrs.has(a.addr),
        );
        if (primary.length === 0) {
          primary = extractAddresses(headerValue(lastMsg, "Cc") || "").filter(
            (a) => !myAddrs.has(a.addr),
          );
        }
        for (const { addr } of primary) {
          const entry = agg.get(addr);
          if (entry) entry.awaitingTheirReply = true;
        }
        const first = primary[0];
        if (first) {
          awaitingTheirReply.push({
            threadId: thread.id,
            subject,
            counterpartAddress: first.addr,
            counterpartName: first.name,
            lastDateMs: lastTs,
            ccOnly: false,
            counterpartIsGeneric: isGenericAddress(first.addr),
          });
        }
      }
    } else {
      const counterpart = lastFromAddrs.find((a) => !myAddrs.has(a.addr));
      if (counterpart) {
        const toHasMe = extractAddresses(headerValue(lastMsg, "To") || "").some(
          (a) => myAddrs.has(a.addr),
        );
        const ccHasMe = extractAddresses(headerValue(lastMsg, "Cc") || "").some(
          (a) => myAddrs.has(a.addr),
        );
        // Skip entirely when my address isn't literally in To/Cc — usually
        // means it was sent to a team/distribution alias I'm a member of,
        // not to me personally, so it's not really "my reply" to give.
        if (toHasMe || ccHasMe) {
          const ccOnly = ccHasMe && !toHasMe;
          const entry = agg.get(counterpart.addr);
          if (entry) entry.awaitingMyReply = true;
          awaitingMyReply.push({
            threadId: thread.id,
            subject,
            counterpartAddress: counterpart.addr,
            counterpartName: counterpart.name,
            lastDateMs: lastTs,
            ccOnly,
            counterpartIsGeneric: isGenericAddress(counterpart.addr),
          });
        }
      }
    }
  }

  const correspondents: Correspondent[] = Array.from(agg.entries())
    .map(([address, a]) => ({
      address,
      name: a.name,
      sentCount: a.sent,
      receivedCount: a.received,
      lastContactMs: a.last,
      awaitingMyReply: a.awaitingMyReply,
      awaitingTheirReply: a.awaitingTheirReply,
      isGenericAddress: isGenericAddress(address),
    }))
    .sort((a, b) => (b.lastContactMs ?? 0) - (a.lastContactMs ?? 0));

  awaitingMyReply.sort((a, b) => (b.lastDateMs ?? 0) - (a.lastDateMs ?? 0));
  awaitingTheirReply.sort((a, b) => (b.lastDateMs ?? 0) - (a.lastDateMs ?? 0));

  const summary: ActivitySummary = {
    correspondents,
    awaitingMyReply,
    awaitingTheirReply,
    allThreads,
    threadsScanned,
    resolvedHidden,
  };

  await saveActivityCache({ email: myEmail, days, syncedAtMs: Date.now(), summary });
  return summary;
}

// ---- Messages by date range ----

export interface DayMessage {
  messageId: string;
  threadId: string;
  direction: "sent" | "received";
  subject: string;
  // Sent: the To recipients; received: the sender.
  peers: { addr: string; name: string | null }[];
  cc: boolean;
  // Received mail where my address is directly in To (not just Cc / a list).
  toMe: boolean;
  timeMs: number;
}

const RANGE_MESSAGE_CAP = 1000;

// Every message sent or received between two local calendar days, inclusive
// ("YYYY-MM-DD"). Gmail's date-string operators (after:/before:) are read in
// Pacific time, so the bounds are passed as epoch seconds of local midnight.
export async function listMessagesInRange(
  fromStr: string,
  toStr: string,
  sender = "",
): Promise<{ messages: DayMessage[]; truncated: boolean }> {
  const who = sender.trim().replace(/["{}()]/g, "").toLowerCase();
  const [y1, m1, d1] = fromStr.split("-").map(Number);
  const [y2, m2, d2] = toStr.split("-").map(Number);
  const startSec = Math.floor(new Date(y1, m1 - 1, d1).getTime() / 1000);
  const endSec = Math.floor(new Date(y2, m2 - 1, d2 + 1).getTime() / 1000);

  const { all: myAddrs } = await loadMyAddresses();

  let ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      // With a sender: `from:` for normal mail plus a bare-text term, since mail
      // reflected by a group has the group in From (real author in a header).
      // The exact check happens below on the real sender.
      q: `after:${startSec} before:${endSec} -in:draft${who ? ` {from:(${who}) "${who}"}` : ""}`,
      maxResults: "500",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailJson<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `/messages?${params.toString()}`,
      "메일 목록 조회",
    );
    ids.push(...(data.messages || []).map((x) => x.id));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < RANGE_MESSAGE_CAP);
  const truncated = ids.length >= RANGE_MESSAGE_CAP && !!pageToken;
  ids = ids.slice(0, RANGE_MESSAGE_CAP);

  const metas = await mapWithConcurrency(ids, 8, async (id) => {
    const params = new URLSearchParams({ format: "metadata" });
    for (const h of SENDER_HEADERS) params.append("metadataHeaders", h);
    try {
      return await gmailJson<MessageMeta & { id: string; threadId: string }>(
        `/messages/${id}?${params.toString()}`,
        "메일 조회",
      );
    } catch {
      return null;
    }
  });

  const messages: DayMessage[] = [];
  for (const msg of metas) {
    if (!msg) continue;
    const timeMs = msg.internalDate ? parseInt(msg.internalDate, 10) : 0;
    const from = senderAddresses(msg, myAddrs);
    const to = extractAddresses(headerValue(msg, "To") || "");
    const cc = extractAddresses(headerValue(msg, "Cc") || "");
    const isMine = from.some((a) => myAddrs.has(a.addr));
    const peers = isMine
      ? [...to, ...(to.length === 0 ? cc : [])].filter((a) => !myAddrs.has(a.addr))
      : from;
    messages.push({
      messageId: msg.id,
      threadId: msg.threadId,
      direction: isMine ? "sent" : "received",
      subject: headerValue(msg, "Subject") || "(제목 없음)",
      peers,
      cc: !isMine && !to.some((a) => myAddrs.has(a.addr)) && cc.some((a) => myAddrs.has(a.addr)),
      toMe: !isMine && to.some((a) => myAddrs.has(a.addr)),
      timeMs,
    });
  }
  const kept = who
    ? messages.filter(
        (m) =>
          m.direction === "received" &&
          m.peers.some((p) => p.addr.includes(who) || (p.name ?? "").toLowerCase().includes(who)),
      )
    : messages;
  kept.sort((a, b) => b.timeMs - a.timeMs);
  return { messages: kept, truncated };
}

// ---- Sent-message lookup for read tracking ----

function stripSubjectNoise(s: string): string {
  const t = s.replace(/\s+/g, " ").trim().toLowerCase();
  return t === "(제목 없음)" ? "" : t;
}

// Maps each just-sent tracked mail (known only by compose-time subject and
// time) to its Gmail thread, by finding the closest sent message with the
// same subject shortly after the send click. Scheduled mails have no fixed
// send time, so they take the earliest same-subject message sent after the
// click and report its real send time.
export async function findSentThreadIds(
  items: { id: string; subject: string; sentMs: number; scheduled?: boolean }[],
): Promise<Record<string, { threadId: string; sentMs: number }>> {
  const out: Record<string, { threadId: string; sentMs: number }> = {};
  for (const item of items) {
    const sec = Math.floor(item.sentMs / 1000);
    const range = item.scheduled ? `after:${sec - 60}` : `after:${sec - 60} before:${sec + 900}`;
    const params = new URLSearchParams({ q: `in:sent ${range}`, maxResults: "50" });
    try {
      const list = await gmailJson<{ messages?: { id: string }[] }>(`/messages?${params.toString()}`, "보낸 메일 검색");
      const want = stripSubjectNoise(item.subject);
      let best: { threadId: string; ms: number; gap: number } | null = null;
      for (const m of list.messages || []) {
        const q = new URLSearchParams({ format: "metadata" });
        q.append("metadataHeaders", "Subject");
        const msg = await gmailJson<MessageMeta & { threadId: string }>(`/messages/${m.id}?${q.toString()}`, "메일 조회");
        if (stripSubjectNoise(headerValue(msg, "Subject") || "") !== want) continue;
        const ms = msg.internalDate ? parseInt(msg.internalDate, 10) : 0;
        if (item.scheduled && ms < item.sentMs - 60_000) continue;
        const gap = item.scheduled ? ms : Math.abs(ms - item.sentMs);
        if (!best || gap < best.gap) best = { threadId: msg.threadId, ms, gap };
      }
      if (best) out[item.id] = { threadId: best.threadId, sentMs: best.ms };
    } catch {
      // Try again on the next refresh.
    }
  }
  return out;
}
