// "열람 추정" badges on Gmail list rows for mail sent with the tracking pixel.
import {
  TRACKED_KEY,
  fetchHits,
  loadTracked,
  loadTrackerConfig,
  realHits,
  type TrackedMail,
} from "../tracking";

interface ReadState {
  readMs: number | null;
}

const states = new Map<string, ReadState>();
let refreshing = false;

const lastScheduledTry = new Map<string, number>();
const SCHEDULED_RETRY_MS = 5 * 60_000;

// Returns the lookups that succeeded: id -> { threadId, real sentMs }.
async function resolveThreads(tracked: TrackedMail[]): Promise<Record<string, { threadId: string; sentMs: number }>> {
  const now = Date.now();
  // Give Gmail a moment to finish sending before looking the message up.
  // Scheduled sends can land weeks later, so they get a longer window but
  // are retried only every few minutes.
  const pending = tracked.filter((t) => {
    if (t.threadId) return false;
    const age = now - t.sentMs;
    if (t.scheduled) {
      return age < 30 * 86_400_000 && now - (lastScheduledTry.get(t.id) ?? 0) > SCHEDULED_RETRY_MS;
    }
    return age > 20_000 && age < 7 * 86_400_000;
  });
  if (pending.length === 0) return {};
  const batch = pending.slice(0, 10);
  for (const t of batch) if (t.scheduled) lastScheduledTry.set(t.id, now);
  const resp = await new Promise<{ ok?: boolean; map?: Record<string, { threadId: string; sentMs: number }> } | undefined>(
    (resolve) =>
      chrome.runtime.sendMessage(
        {
          type: "resolveTrackedThreads",
          items: batch.map((t) => ({ id: t.id, subject: t.subject, sentMs: t.sentMs, scheduled: t.scheduled })),
        },
        resolve,
      ),
  );
  return resp?.ok && resp.map ? resp.map : {};
}

export async function refreshReadStates(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const cfg = await loadTrackerConfig();
    if (!cfg.url || !cfg.token) return;
    const tracked = await loadTracked();
    if (tracked.length === 0) return;

    const resolved = await resolveThreads(tracked);
    if (Object.keys(resolved).length > 0) {
      // Re-read before writing so a send that happened meanwhile isn't lost.
      const latest = await loadTracked();
      for (const t of latest) {
        const r = resolved[t.id];
        if (r) {
          t.threadId = r.threadId;
          t.sentMs = r.sentMs;
        }
      }
      await chrome.storage.local.set({ [TRACKED_KEY]: latest });
      tracked.splice(0, tracked.length, ...latest);
    }

    const recent = tracked.filter((t) => t.threadId).slice(-150);
    const hits = await fetchHits(cfg, recent.map((t) => t.id));
    states.clear();
    // Later sends override earlier ones so a thread shows its newest mail's state.
    for (const t of [...recent].sort((a, b) => a.sentMs - b.sentMs)) {
      const real = realHits(hits[t.id] ?? [], t.sentMs);
      states.set(t.threadId as string, { readMs: real.length ? real[0].t : null });
    }
  } catch {
    // Best-effort; badges just stay as they were.
  } finally {
    refreshing = false;
  }
}

function fmt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Runs on the periodic scan; only touches rows that already carry Correo's badge group.
export function applyReadTags(): void {
  document.querySelectorAll<HTMLElement>("[data-legacy-thread-id]").forEach((row) => {
    const group = row.querySelector(".correo-badge-group");
    if (!group) return;
    const st = states.get(row.getAttribute("data-legacy-thread-id") ?? "");
    let tag = group.querySelector<HTMLElement>(".correo-read");
    if (!st) {
      tag?.remove();
      return;
    }
    if (!tag) {
      tag = document.createElement("span");
      group.insertBefore(tag, group.firstChild);
    }
    tag.className = `correo-read ${st.readMs ? "on" : ""}`;
    tag.textContent = st.readMs ? `열람 추정 ${fmt(st.readMs)}` : "미열람";
    tag.title = st.readMs ? "상대가 메일을 연 것으로 추정됩니다" : "아직 열람 기록이 없습니다";
  });
}
