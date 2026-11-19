// Shared by the side-panel screens (Settings, DayView) and the Gmail content
// script: tracker config + the list of pixels the extension has minted.

export const TRACKER_CFG_KEY = "correo_tracker";
export const TRACKED_KEY = "correo_tracked";

export interface TrackerConfig {
  enabled: boolean;
  url: string; // Worker base URL, no trailing slash
  token: string; // API_TOKEN secret, used only for /status
}

export interface TrackedMail {
  id: string;
  subject: string;
  to: string[]; // lowercase recipient addresses
  sentMs: number;
  // Filled in after sending, once the sent message can be looked up.
  threadId?: string;
  // Queued via 예약 전송: sentMs is just the click time until the real send is found.
  scheduled?: boolean;
}

export interface Hit {
  t: number;
  ua: string;
}

// Hits this soon after sending are almost always the sender's own client
// (Gmail re-renders the sent copy) or an automated link scanner, not a read.
export const SELF_GRACE_MS = 60_000;

export async function loadTrackerConfig(): Promise<TrackerConfig> {
  const s = await chrome.storage.local.get(TRACKER_CFG_KEY);
  const c = s[TRACKER_CFG_KEY] as Partial<TrackerConfig> | undefined;
  return { enabled: !!c?.enabled, url: (c?.url || "").replace(/\/+$/, ""), token: c?.token || "" };
}

export function saveTrackerConfig(c: TrackerConfig): Promise<void> {
  return chrome.storage.local.set({ [TRACKER_CFG_KEY]: c });
}

export async function loadTracked(): Promise<TrackedMail[]> {
  const s = await chrome.storage.local.get(TRACKED_KEY);
  return (s[TRACKED_KEY] as TrackedMail[] | undefined) ?? [];
}

export async function fetchHits(cfg: TrackerConfig, ids: string[]): Promise<Record<string, Hit[]>> {
  if (!cfg.url || !cfg.token || ids.length === 0) return {};
  const out: Record<string, Hit[]> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const resp = await fetch(`${cfg.url}/status?ids=${chunk.join(",")}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!resp.ok) throw new Error(`트래커 응답 오류 (${resp.status})`);
    Object.assign(out, await resp.json());
  }
  return out;
}

export function normalizeSubject(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// A sent message is matched to the pixel minted for it by subject + a shared
// recipient + send time (the pixel is added at click time, before Gmail has
// assigned a message id, so there is no id to join on).
export function findTracked(
  tracked: TrackedMail[],
  subject: string,
  peers: string[],
  timeMs: number,
): TrackedMail | null {
  const subj = normalizeSubject(subject);
  const want = new Set(peers.map((p) => p.toLowerCase()));
  let best: TrackedMail | null = null;
  for (const t of tracked) {
    if (normalizeSubject(t.subject) !== subj) continue;
    if (!t.to.some((a) => want.has(a))) continue;
    const gap = Math.abs(t.sentMs - timeMs);
    if (gap > 10 * 60_000) continue;
    if (!best || gap < Math.abs(best.sentMs - timeMs)) best = t;
  }
  return best;
}

export function realHits(hits: Hit[], sentMs: number): Hit[] {
  return hits.filter((h) => h.t - sentMs > SELF_GRACE_MS);
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

// Checks the whole chain: the Worker answers, the token matches, and the KV
// namespace is bound. (/status?ids= with no ids never touches KV, so a missing
// binding would pass; ?list=1 reads it.)
export async function testTrackerConnection(url: string, token: string): Promise<ConnectionResult> {
  let base: string;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:") throw new Error("not https");
    base = u.origin; // drops any path the user pasted along with the address
  } catch {
    return { ok: false, message: "주소 형식이 올바르지 않습니다. https://로 시작하는 Worker 주소 전체를 붙여넣으세요." };
  }

  // Step 1: a plain request with no custom headers (so no CORS preflight).
  // This separates "wrong/undeployed address" from "server exists but isn't
  // running the Correo code", which otherwise look identical to the browser.
  let probe: Response;
  try {
    probe = await fetch(`${base}/`);
  } catch {
    return {
      ok: false,
      message:
        "이 주소에 접속할 수 없습니다. 주소 오타이거나 아직 배포되지 않았을 수 있습니다. " +
        "브라우저 새 탭에서 이 주소를 열었을 때 'ok'라고 보이는지 확인하세요.",
    };
  }
  const probeText = (await probe.text().catch(() => "")).trim();
  if (probeText !== "ok") {
    return {
      ok: false,
      message:
        "서버는 있지만 Correo 코드가 배포되지 않았습니다 (기본 Hello World 상태). " +
        "코드 붙여넣기 단계에서 기존 코드를 지우고 붙여넣은 뒤 반드시 Deploy를 누르세요.",
    };
  }

  // Step 2: the real check, with the token (also reads KV).
  let resp: Response;
  try {
    resp = await fetch(`${base}/status?list=1`, { headers: { Authorization: `Bearer ${token.trim()}` } });
  } catch {
    return { ok: false, message: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
  if (resp.status === 401) {
    return { ok: false, message: "토큰이 맞지 않습니다. Cloudflare의 API_TOKEN 값이 위 토큰과 같은지 확인하세요." };
  }
  if (resp.status >= 500) {
    return { ok: false, message: "서버는 응답했지만 저장소(KV)에 연결되지 않았습니다. Bindings에 OPENS가 추가됐는지 확인하세요." };
  }
  if (!resp.ok) return { ok: false, message: `오류 (${resp.status})` };
  const body = await resp.json().catch(() => null);
  if (!Array.isArray(body)) {
    return { ok: false, message: "서버 코드가 아직 붙여넣어지지 않은 것 같습니다. 코드 붙여넣기 단계를 확인하세요." };
  }
  return { ok: true, message: "연결됐습니다. (서버·토큰·저장소 모두 정상)" };
}
