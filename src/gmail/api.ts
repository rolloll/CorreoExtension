import { buildRangeQuery, matchesAccount, matchesCounterpart } from "../rangeFilter";
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
// Total time spent sleeping on rate-limit retries in this page; lets a caller
// (the date-range view) report how much of a slow load was quota back-off.
let rateLimitWaitedMs = 0;

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
    rateLimitWaitedMs += delay;
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

export async function mapWithConcurrency<T, R>(
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

interface GmailFilter {
  id: string;
  criteria?: { query?: string; from?: string; to?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

// Filters already on the account whose condition is the same as `query`.
// Gmail may have stored it as criteria.query ("from:x") or, if made in
// Gmail's own UI, as criteria.from / criteria.to.
async function findFiltersWithCondition(query: string): Promise<GmailFilter[]> {
  const data = await gmailJson<{ filter?: GmailFilter[] }>("/settings/filters", "필터 목록 조회");
  const m = /^(from|to):(.+)$/i.exec(query.trim());
  const key = m?.[1].toLowerCase() as "from" | "to" | undefined;
  const addr = m?.[2].trim().toLowerCase();
  return (data.filter || []).filter((f) => {
    const c = f.criteria;
    if (!c) return false;
    if ((c.query ?? "").trim().toLowerCase() === query.trim().toLowerCase()) return true;
    return !!key && !c.query && (c[key] ?? "").trim().toLowerCase() === addr;
  });
}

// "created", or "exists" when an identical filter was already there (e.g. a
// previous attempt made it and a later step failed), so retrying is harmless.
export async function createFilter(
  query: string,
  labelId: string,
  archive: boolean,
): Promise<"created" | "exists"> {
  const action: Record<string, string[]> = { addLabelIds: [labelId] };
  if (archive) action.removeLabelIds = ["INBOX"];
  const resp = await gmailFetch("/settings/filters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria: { query }, action }),
  });
  if (resp.ok) return "created";
  const text = await resp.text();
  if (resp.status === 400 && /already exists/i.test(text)) {
    const existing = await findFiltersWithCondition(query);
    const same = existing.find(
      (f) =>
        !!f.action?.addLabelIds?.includes(labelId) &&
        !!f.action?.removeLabelIds?.includes("INBOX") === archive,
    );
    if (same) return "exists";
    if (existing.length > 0) {
      const names = new Map((await listLabels()).map((l) => [l.id, l.name]));
      const what = existing
        .map((f) => {
          const labels = (f.action?.addLabelIds ?? []).map((id) => names.get(id) ?? id).join(", ") || "라벨 없음";
          return `${labels}${f.action?.removeLabelIds?.includes("INBOX") ? " + 받은편지함에서 보관처리" : ""}`;
        })
        .join(" / ");
      throw new Error(
        `같은 조건(${query})의 필터가 이미 있고 다른 동작을 합니다 (${what}). ` +
          "Gmail 설정 → 필터 및 차단된 주소에서 기존 필터를 삭제하거나 수정한 뒤 다시 시도해 주세요.",
      );
    }
  }
  throw new Error(`필터 생성 실패 (${resp.status}): ${text}`);
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

// Every value of a header that can repeat (Delivered-To appears once per hop).
function headerValues(msg: MessageMeta, name: string): string[] {
  return (msg.payload?.headers ?? []).filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);
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

// all:      the addresses that count as "me" (send-as aliases minus the ones the
//           user excluded in 설정, plus the extras).
// sendFrom: every address I can send from, excluded or not. A shared address
//           the user excluded from "me" (e.g. a group address) is still one
//           that I send from, so mail I wrote from it must count as sent.
async function loadMyAddresses(): Promise<{ primary: string; all: Set<string>; sendFrom: Set<string> }> {
  const [info, cfg] = await Promise.all([loadAddressInfo(), loadAliasConfig()]);
  const excluded = new Set(cfg.excluded.map(normalizeAddress));
  const all = new Set<string>([info.primary]);
  const sendFrom = new Set<string>([info.primary]);
  for (const a of info.sendAs) {
    sendFrom.add(a);
    if (!excluded.has(a)) all.add(a);
  }
  for (const a of cfg.extra) {
    all.add(normalizeAddress(a));
    sendFrom.add(normalizeAddress(a));
  }
  return { primary: info.primary, all, sendFrom };
}

const SENDER_HEADERS = ["From", "To", "Cc", "Subject", "X-Original-Sender", "X-Original-From", "List-Id", "Delivered-To"];

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
  const { primary: myEmail, all: myAddrs, sendFrom } = await loadMyAddresses();

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
      const isMine = isMyMessage(msg, fromAddrs, sendFrom);
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
    const lastIsMine = isMyMessage(lastMsg, lastFromAddrs, sendFrom);
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
  // Full header addresses, used by the export (peers is only the "other side").
  fromAddrs: { addr: string; name: string | null }[];
  toAddrs: { addr: string; name: string | null }[];
  ccAddrs: { addr: string; name: string | null }[];
  // Sent by me directly: in Gmail's Sent folder and not a mailing-list copy.
  // A group copy whose From is my send-as alias is also filed under SENT, but
  // someone else (or an outside company) wrote it - see isMyMessage().
  mine: boolean;
}

const RANGE_MESSAGE_CAP = 1000;

export interface RangeStats {
  total: number;
  fetched: number; // metadata calls actually made
  elapsedMs: number;
  // Summed per-request back-off sleeps; requests run in parallel, so this can
  // exceed elapsedMs. A large value means Gmail's quota was the bottleneck.
  rateLimitWaitMs: number;
}

export interface RangeOptions {
  // My own addresses to look at (one or several): only mail received at one of
  // them or sent from one of them. Empty = all of them.
  accounts?: string[];
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

// Message headers never change, so they're kept between visits: re-opening a
// range (or widening it) only fetches the messages not seen before.
// v3: entries are fetched with a fields mask and now keep labelIds (SENT).
const RANGE_CACHE_KEY = "correo_range_meta_cache_v3";
const OLD_RANGE_CACHE_KEYS = ["correo_range_meta_cache", "correo_range_meta_cache_v2"];
const RANGE_CACHE_MAX = 4000;
type RangeMeta = MessageMeta & { id: string; threadId: string };

// Parsing the stored cache (thousands of entries) on every visit is slow, so
// it is kept in memory for the lifetime of the page.
let rangeCacheMem: Record<string, RangeMeta> | null = null;

async function loadRangeCache(): Promise<Record<string, RangeMeta>> {
  if (rangeCacheMem) return rangeCacheMem;
  void chrome.storage.local.remove(OLD_RANGE_CACHE_KEYS);
  const s = await chrome.storage.local.get(RANGE_CACHE_KEY);
  rangeCacheMem = (s[RANGE_CACHE_KEY] as Record<string, RangeMeta> | undefined) ?? {};
  return rangeCacheMem;
}

async function saveRangeCache(cache: Record<string, RangeMeta>): Promise<void> {
  let entries = Object.entries(cache);
  if (entries.length > RANGE_CACHE_MAX) {
    // Keep the newest messages.
    entries.sort((a, b) => parseInt(b[1].internalDate ?? "0", 10) - parseInt(a[1].internalDate ?? "0", 10));
    entries = entries.slice(0, RANGE_CACHE_MAX);
  }
  await chrome.storage.local.set({ [RANGE_CACHE_KEY]: Object.fromEntries(entries) });
}

// ---- Batched metadata fetch ----
// Gmail's batch endpoint answers many sub-requests in one HTTP call; for a
// range of a few hundred messages that is much faster than one call each. The
// fields mask also trims every response down to what the view reads.

const BATCH_SIZE = 50;
const BATCH_PARALLEL = 4;

function metadataPath(id: string): string {
  const params = new URLSearchParams({
    format: "metadata",
    fields: "id,threadId,internalDate,labelIds,payload/headers",
  });
  for (const h of SENDER_HEADERS) params.append("metadataHeaders", h);
  return `/gmail/v1/users/me/messages/${id}?${params.toString()}`;
}

interface BatchItem {
  status: number;
  json: RangeMeta | null;
}

async function fetchMetadataBatch(ids: string[], token: string): Promise<(BatchItem | null)[]> {
  const boundary = `correo_${Math.random().toString(36).slice(2)}`;
  let body = "";
  ids.forEach((id, i) => {
    body += `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\nGET ${metadataPath(id)}\r\n\r\n`;
  });
  body += `--${boundary}--`;
  const resp = await fetch("https://www.googleapis.com/batch/gmail/v1", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (!resp.ok) throw new Error(`batch ${resp.status}`);
  const m = /boundary="?([^";]+)"?/i.exec(resp.headers.get("content-type") || "");
  if (!m) throw new Error("batch boundary");
  const text = (await resp.text()).replace(/\r\n/g, "\n");
  const out: (BatchItem | null)[] = new Array(ids.length).fill(null);
  for (const part of text.split(`--${m[1]}`)) {
    const cid = /Content-ID:\s*<response-item(\d+)>/i.exec(part);
    if (!cid) continue;
    const h = part.indexOf("HTTP/");
    if (h < 0) continue;
    const st = /HTTP\/[\d.]+\s+(\d+)/.exec(part.slice(h));
    let json: RangeMeta | null = null;
    const sep = part.indexOf("\n\n", h);
    if (sep >= 0) {
      try {
        json = JSON.parse(part.slice(sep + 2).trim()) as RangeMeta;
      } catch {
        // Leave json null; the caller treats it as a miss.
      }
    }
    out[+cid[1]] = { status: st ? +st[1] : 0, json };
  }
  return out;
}

// Headers for `ids`, from the cache where possible. Misses are fetched in
// batches; whatever a batch can't deliver (throttled, odd response) falls back
// to one request each, which has its own retry.
async function fetchRangeMetas(
  ids: string[],
  cache: Record<string, RangeMeta>,
  opts: RangeOptions,
  onFetched: () => void,
  onDone: () => void,
): Promise<(RangeMeta | null)[]> {
  const out: (RangeMeta | null)[] = new Array(ids.length).fill(null);
  const missing: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const hit = cache[ids[i]];
    if (hit) {
      out[i] = hit;
      onDone();
    } else {
      missing.push(i);
    }
  }
  if (missing.length === 0) return out;

  let token: string | null = null;
  try {
    token = await getAuthToken(false);
  } catch {
    // The per-message fallback below reports/handles auth problems.
  }
  const chunks: number[][] = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) chunks.push(missing.slice(i, i + BATCH_SIZE));

  let pause = 0; // grows while Gmail throttles, shrinks while it doesn't
  async function runChunk(chunk: number[]): Promise<void> {
    let pending = chunk.slice();
    if (token) {
      for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
        if (opts.isCancelled?.()) return;
        if (pause) await sleep(pause);
        let res: (BatchItem | null)[];
        try {
          res = await fetchMetadataBatch(
            pending.map((i) => ids[i]),
            token,
          );
        } catch {
          break;
        }
        const retry: number[] = [];
        let throttled = false;
        pending.forEach((idx, k) => {
          const r = res[k];
          if (r && r.status === 200 && r.json && r.json.id) {
            cache[ids[idx]] = r.json;
            out[idx] = r.json;
            onFetched();
            onDone();
          } else if (r && (r.status === 429 || r.status === 403 || r.status >= 500)) {
            retry.push(idx);
            throttled = true;
          } else if (r && r.status >= 400) {
            onDone(); // gone/forbidden: nothing to retry
          } else {
            retry.push(idx);
          }
        });
        pending = retry;
        if (throttled) {
          pause = Math.min(2000, (pause || 250) * 2);
          const wait = Math.min(4000, 500 * 2 ** attempt);
          rateLimitWaitedMs += wait;
          await sleep(wait);
        } else {
          pause = Math.max(0, pause - 100);
        }
      }
    }
    if (pending.length > 0) {
      await mapWithConcurrency(pending, 4, async (idx) => {
        if (opts.isCancelled?.()) return;
        const params = new URLSearchParams({ format: "metadata" });
        for (const h of SENDER_HEADERS) params.append("metadataHeaders", h);
        try {
          const m = await gmailJson<RangeMeta>(`/messages/${ids[idx]}?${params.toString()}`, "메일 조회");
          cache[ids[idx]] = m;
          out[idx] = m;
          onFetched();
        } catch {
          // Leave it out of this view; the next visit tries again.
        } finally {
          onDone();
        }
      });
    }
  }

  const queue = chunks.slice();
  await Promise.all(
    Array.from({ length: Math.min(BATCH_PARALLEL, queue.length) }, async () => {
      for (;;) {
        if (opts.isCancelled?.()) return;
        const chunk = queue.shift();
        if (!chunk) return;
        await runChunk(chunk);
      }
    }),
  );
  return out;
}

// Gmail marks a message SENT whenever its From is one of my send-as aliases -
// including a copy a Google Group re-delivered to me, whose real author is
// someone else (or an outside company). Those copies carry a List-Id header;
// a message I sent myself never does. So "mine" = my address in From AND no
// List-Id.
function isMyMessage(msg: MessageMeta, fromAddrs: { addr: string }[], myAddrs: Set<string>): boolean {
  return fromAddrs.some((a) => myAddrs.has(a.addr)) && !headerValue(msg, "List-Id");
}

// Every message sent or received between two local calendar days, inclusive
// ("YYYY-MM-DD"). Gmail's date-string operators (after:/before:) are read in
// Pacific time, so the bounds are passed as epoch seconds of local midnight.
export async function listMessagesInRange(
  fromStr: string,
  toStr: string,
  counterpart = "",
  opts: RangeOptions = {},
): Promise<{ messages: DayMessage[]; truncated: boolean; stats: RangeStats }> {
  const startedAt = Date.now();
  const waitedBefore = rateLimitWaitedMs;
  const [y1, m1, d1] = fromStr.split("-").map(Number);
  const [y2, m2, d2] = toStr.split("-").map(Number);
  const startSec = Math.floor(new Date(y1, m1 - 1, d1).getTime() / 1000);
  const endSec = Math.floor(new Date(y2, m2 - 1, d2 + 1).getTime() / 1000);

  // The address lookup runs alongside the message listing instead of before it.
  const myAddrsPromise = loadMyAddresses();
  myAddrsPromise.catch(() => {});

  let ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      // The exact checks happen below on the real headers.
      q: buildRangeQuery(startSec, endSec, counterpart, opts.accounts ?? []),
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
  const { all: myAddrs, sendFrom } = await myAddrsPromise;
  const truncated = ids.length >= RANGE_MESSAGE_CAP && !!pageToken;
  ids = ids.slice(0, RANGE_MESSAGE_CAP);

  const cache = await loadRangeCache();
  let fetched = 0;
  let done = 0;
  const metas = await fetchRangeMetas(
    ids,
    cache,
    opts,
    () => {
      fetched++;
    },
    () => {
      opts.onProgress?.(++done, ids.length);
    },
  );
  if (!opts.isCancelled?.() && fetched > 0) {
    // Only persist what this range (or earlier ones) fetched; failures stay out.
    void saveRangeCache(cache).catch(() => {});
  }

  const messages: DayMessage[] = [];
  for (const msg of metas) {
    if (!msg) continue;
    const timeMs = msg.internalDate ? parseInt(msg.internalDate, 10) : 0;
    const from = senderAddresses(msg, myAddrs);
    const to = extractAddresses(headerValue(msg, "To") || "");
    const cc = extractAddresses(headerValue(msg, "Cc") || "");
    // A group copy whose From is my alias is "received", not "sent".
    const isMine = isMyMessage(msg, from, sendFrom);
    const delivered = headerValues(msg, "Delivered-To");
    if (!matchesAccount(opts.accounts ?? [], isMine, from, to, cc, delivered)) continue;
    if (!matchesCounterpart(counterpart, isMine, from, to, cc, sendFrom)) continue;
    const peers = isMine
      ? [...to, ...(to.length === 0 ? cc : [])].filter((a) => !sendFrom.has(a.addr))
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
      fromAddrs: from,
      toAddrs: to,
      ccAddrs: cc,
      mine: (msg.labelIds ?? []).includes("SENT") && !headerValue(msg, "List-Id"),
    });
  }
  // Account / counterpart filters were applied per message above.
  const kept = messages;
  kept.sort((a, b) => b.timeMs - a.timeMs);
  return {
    messages: kept,
    truncated,
    stats: {
      total: ids.length,
      fetched,
      elapsedMs: Date.now() - startedAt,
      rateLimitWaitMs: rateLimitWaitedMs - waitedBefore,
    },
  };
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

// ---- Message body text (for AI summaries) ----

interface MessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: MessagePart[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function findPartText(part: MessagePart, mime: string): string | null {
  if (!part.filename && part.mimeType === mime && part.body?.data) return decodeBase64Url(part.body.data);
  for (const p of part.parts ?? []) {
    const hit = findPartText(p, mime);
    if (hit !== null) return hit;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const BODY_TEXT_CAP = 20000;

// Plain-text body of a message (text/plain preferred, else the HTML stripped),
// without quoted-reply lines and collapsed whitespace. Long bodies are cut at
// BODY_TEXT_CAP characters.
export async function getMessageText(messageId: string): Promise<string> {
  const msg = await gmailJson<{ payload?: MessagePart }>(`/messages/${messageId}?format=full`, "메일 본문 조회");
  if (!msg.payload) return "";
  const plain = findPartText(msg.payload, "text/plain");
  const raw = plain ?? htmlToText(findPartText(msg.payload, "text/html") ?? "");
  const text = raw
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(">"))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > BODY_TEXT_CAP ? text.slice(0, BODY_TEXT_CAP) : text;
}

// ---- Whole-thread text (for AI summaries) ----
// A short reply ("확인했습니다") says nothing without the mail it answers, and
// the launch date / promotion period usually sit in the other side's first
// mail. So summaries are made from the whole conversation.

interface ThreadFullMessage {
  id: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: MessagePart & { headers?: HeaderKV[] };
}

const FIRST_LAST_BODY_CAP = 12000;
const MIDDLE_BODY_CAP = 3000;
const TRANSCRIPT_CAP = 40000;

// Message text without the quoted history: ">" lines, "... wrote:" lines and,
// for HTML-only mail, <blockquote> blocks (a forwarded message is not in a
// blockquote, so forwards keep their content).
function messageBodyText(payload: MessagePart): string {
  let raw = findPartText(payload, "text/plain");
  if (raw === null) {
    let html = findPartText(payload, "text/html") ?? "";
    let prev: string;
    do {
      prev = html;
      html = html.replace(/<blockquote[^>]*>(?:(?!<blockquote)[\s\S])*?<\/blockquote>/gi, " ");
    } while (html !== prev);
    raw = htmlToText(html);
  }
  return raw
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(">") && !/(wrote:|작성:)\s*$/.test(l.trim()))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The conversation `threadId` belongs to, oldest mail first, as one text for
// the model, plus the id of its newest mail (summary cache key). Drafts are
// left out.
export async function getThreadTranscript(threadId: string): Promise<{ lastMessageId: string; text: string } | null> {
  const thread = await gmailJson<{ messages?: ThreadFullMessage[] }>(`/threads/${threadId}?format=full`, "대화 조회");
  const msgs = (thread.messages ?? [])
    .filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  const parts = msgs.map((m, i) => {
    let body = messageBodyText(m.payload ?? {});
    const cap = i === 0 || i === msgs.length - 1 ? FIRST_LAST_BODY_CAP : MIDDLE_BODY_CAP;
    if (body.length > cap) body = body.slice(0, cap) + "\n…(이하 생략)";
    const when = m.internalDate ? new Date(parseInt(m.internalDate, 10)).toLocaleString("ko-KR") : "";
    const from = m.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    const tag = i === msgs.length - 1 ? " · 가장 최근 메일" : "";
    return `[${i + 1}/${msgs.length}${tag}] ${when} | 보낸 사람: ${from}\n${body || "(본문 없음)"}`;
  });
  const text = parts.join("\n\n-----\n\n");
  return { lastMessageId: last.id, text: text.length > TRANSCRIPT_CAP ? text.slice(0, TRANSCRIPT_CAP) : text };
}

// ---- Label for mail I sent myself ----
// Gmail files group copies whose From is my alias under "Sent" too, so the
// Sent folder can't tell my mail from a colleague's or a vendor's. This puts
// a label of my choice on the conversations I really sent (no List-Id).
//
// The label's name is never baked into the code (it gets renamed): public/
// sent-label.txt names it once, the Gmail label ID is then remembered and
// survives renames. A missing label is never created.

const SENT_LABEL_ID_KEY = "correo_sent_label_id";
const SENT_LABEL_JOB_KEY = "correo_label_job";
const SENT_LABEL_MIN_GAP_MS = 4 * 60_000;
const SENT_LABEL_FIRST_DAYS = 45; // first run after (re)loading: catch up
const SENT_LABEL_DAYS = 2;
const SENT_LABEL_MAX_CHECK = 150; // header lookups per run
const SENT_LABEL_MAX_APPLY = 50; // conversations labelled per run

let sentLabelBusy = false;
let sentLabelAt = 0;
let sentLabelFirst = true;
const sentLabelDone = new Set<string>(); // threads already labelled
const sentLabelSkip = new Set<string>(); // messages that need no label

async function resolveSentLabelId(): Promise<string> {
  const labels = (await gmailJson<{ labels?: LabelOut[] }>("/labels", "라벨 목록 조회")).labels ?? [];
  const stored = (await chrome.storage.local.get(SENT_LABEL_ID_KEY))[SENT_LABEL_ID_KEY] as string | undefined;
  if (stored && labels.some((l) => l.id === stored)) return stored;
  const name = (await (await fetch(chrome.runtime.getURL("sent-label.txt"))).text()).trim();
  const found = name ? labels.find((l) => l.name === name) : undefined;
  if (!found) throw new Error(`라벨 '${name}' 이(가) 없어 건너뜀 (새로 만들지 않음)`);
  await chrome.storage.local.set({ [SENT_LABEL_ID_KEY]: found.id });
  return found.id;
}

// Puts the label on conversations I sent myself. Runs from the minute alarm,
// but at most every few minutes; the outcome is kept in storage
// (correo_label_job) so a failure can be read afterwards.
export async function labelMySentMail(): Promise<void> {
  if (sentLabelBusy || Date.now() - sentLabelAt < SENT_LABEL_MIN_GAP_MS) return;
  sentLabelBusy = true;
  sentLabelAt = Date.now();
  let labeled = 0;
  let checked = 0;
  let error: string | null = null;
  try {
    const info = await loadAddressInfo();
    const labelId = await resolveSentLabelId();
    const days = sentLabelFirst ? SENT_LABEL_FIRST_DAYS : SENT_LABEL_DAYS;
    const todo = new Map<string, true>();
    for (const addr of new Set(info.sendAs)) {
      let pageToken = "";
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ q: `in:sent newer_than:${days}d from:${addr}`, maxResults: "100" });
        if (pageToken) params.set("pageToken", pageToken);
        const list = await gmailJson<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(
          `/messages?${params.toString()}`,
          "보낸 메일 라벨 대상 조회",
        );
        for (const m of list.messages ?? []) {
          if (sentLabelDone.has(m.threadId) || sentLabelSkip.has(m.id) || todo.has(m.threadId)) continue;
          if (checked >= SENT_LABEL_MAX_CHECK) continue;
          checked++;
          const msg = await gmailJson<MessageMeta>(
            `/messages/${m.id}?format=metadata&metadataHeaders=List-Id&fields=id,labelIds,payload/headers`,
            "보낸 메일 헤더 조회",
          );
          // Already labelled, or a group copy: nothing to do.
          if ((msg.labelIds ?? []).includes(labelId) || headerValue(msg, "List-Id")) sentLabelSkip.add(m.id);
          else todo.set(m.threadId, true);
        }
        pageToken = list.nextPageToken ?? "";
        if (!pageToken) break;
      }
    }
    for (const threadId of [...todo.keys()].slice(0, SENT_LABEL_MAX_APPLY)) {
      await addLabelToThread(threadId, labelId);
      sentLabelDone.add(threadId);
      labeled++;
    }
    if (checked < SENT_LABEL_MAX_CHECK && todo.size <= SENT_LABEL_MAX_APPLY) sentLabelFirst = false;
  } catch (e) {
    error = String(e);
  } finally {
    sentLabelBusy = false;
  }
  try {
    await chrome.storage.local.set({ [SENT_LABEL_JOB_KEY]: { at: Date.now(), labeled, checked, error } });
  } catch {
    // Storage hiccup: the label work itself is already done.
  }
}

// ---- New inbox mail addressed to given accounts (for Telegram alerts) ----

export interface IncomingMail {
  id: string;
  subject: string;
  from: string;
  // The watched address that was found in To/Cc.
  matched: string;
  timeMs: number;
}

// Inbox messages received since `afterSec` whose To (and, if includeCc, Cc)
// contains one of `addresses`. Gmail's search narrows the candidates; the
// real headers decide, so a partial match in a display name can't slip in.
export async function listIncomingToAddresses(
  addresses: string[],
  afterSec: number,
  includeCc: boolean,
  skipIds: Set<string>,
): Promise<IncomingMail[]> {
  const watch = addresses.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (watch.length === 0) return [];
  const terms = watch.flatMap((a) => (includeCc ? [`to:${a}`, `cc:${a}`] : [`to:${a}`]));
  const params = new URLSearchParams({
    q: `in:inbox after:${afterSec} {${terms.join(" ")}}`,
    maxResults: "50",
  });
  const list = await gmailJson<{ messages?: { id: string }[] }>(`/messages?${params.toString()}`, "새 메일 조회");
  const out: IncomingMail[] = [];
  for (const { id } of list.messages ?? []) {
    if (skipIds.has(id)) continue;
    const q = new URLSearchParams({ format: "metadata" });
    for (const h of ["From", "To", "Cc", "Subject"]) q.append("metadataHeaders", h);
    const msg = await gmailJson<MessageMeta>(`/messages/${id}?${q.toString()}`, "메일 조회");
    const to = extractAddresses(headerValue(msg, "To") || "").map((a) => a.addr);
    const cc = includeCc ? extractAddresses(headerValue(msg, "Cc") || "").map((a) => a.addr) : [];
    const matched = watch.find((w) => to.includes(w) || cc.includes(w));
    if (!matched) continue;
    out.push({
      id,
      subject: headerValue(msg, "Subject") || "(제목 없음)",
      from: headerValue(msg, "From") || "",
      matched,
      timeMs: msg.internalDate ? parseInt(msg.internalDate, 10) : 0,
    });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}
