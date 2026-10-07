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
