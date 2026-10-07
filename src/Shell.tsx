import { useEffect, useRef, useState, type ComponentType } from "react";
import type { ActivitySummary, ThreadFlag } from "./types";
import { loadActivityCache, markThreadResolved } from "./gmail/api";
import { loadUpdateInfo } from "./updateCheck";
import type { GmailAccount } from "./App";
import Home from "./Home";
import Labels from "./Labels";
import Contacts from "./Contacts";
import Settings from "./Settings";
import DayView from "./DayView";
import { IconHome, IconCalendar, IconLabel, IconContacts, IconSettings, IconRefresh, IconX } from "./icons";
import "./Shell.css";

export type View = "home" | "day" | "labels" | "contacts" | "settings";
export type HomeFilter = "me" | "them" | "today";

// Persisted so the toolbar popup (popup.js, a plain script with no access
// to this component tree) can apply the same "참조/공용 주소 제외" filters
// when it computes its own stat counts from the cached activity summary.
const PREFS_KEY = "correo_prefs";

interface Prefs {
  hideCc: boolean;
  hideGen: boolean;
}

async function loadPrefs(): Promise<Prefs> {
  const stored = await chrome.storage.local.get(PREFS_KEY);
  const prefs = stored[PREFS_KEY] as Partial<Prefs> | undefined;
  return { hideCc: prefs?.hideCc ?? true, hideGen: prefs?.hideGen ?? true };
}

function savePrefs(prefs: Prefs): void {
  void chrome.storage.local.set({ [PREFS_KEY]: prefs });
}

// Syncs go through the background worker so every open Correo panel / Gmail
// tab shares a single in-flight sync (and thus a single share of Gmail quota).
async function syncViaBackground(days: number): Promise<ActivitySummary> {
  const resp = await new Promise<{ ok?: boolean; error?: string } | undefined>((resolve) =>
    chrome.runtime.sendMessage({ type: "syncNow", days }, resolve),
  );
  if (!resp?.ok) throw new Error(resp?.error || "동기화에 실패했습니다.");
  const cached = await loadActivityCache();
  if (!cached) throw new Error("동기화 결과를 읽지 못했습니다.");
  return cached.summary;
}

export function visibleFlags(items: ThreadFlag[], hideCc: boolean, hideGen: boolean): ThreadFlag[] {
  return items.filter((t) => !(hideCc && t.ccOnly) && !(hideGen && t.counterpartIsGeneric));
}

const RAIL_ICONS: Record<View, ComponentType<{ size?: number }>> = {
  home: IconHome,
  day: IconCalendar,
  labels: IconLabel,
  contacts: IconContacts,
  settings: IconSettings,
};

export default function Shell({
  account,
  onDisconnect,
  initialFilter,
}: {
  account: GmailAccount;
  onDisconnect: () => void;
  initialFilter: "me" | "them" | null;
}) {
  const [view, setView] = useState<View>("home");
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [syncedAtMs, setSyncedAtMs] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [days, setDays] = useState(90);
  const [hideCc, setHideCc] = useState(true);
  const [hideGen, setHideGen] = useState(true);
  const [homeFilter, setHomeFilter] = useState<HomeFilter>(initialFilter ?? "me");
  const [labelRuleAddress, setLabelRuleAddress] = useState<string | null>(null);
  const [isEmbedded] = useState(() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  });

  // Sync on every open/reload, showing the cached data meanwhile. The ref
  // keeps StrictMode's double-mount from firing two syncs.
  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current) return;
    autoSynced.current = true;
    loadActivityCache()
      .catch(() => null)
      .then((cached) => {
        const syncDays = cached?.days ?? days;
        if (cached) {
          setSummary(cached.summary);
          setDays(cached.days);
          setSyncedAtMs(cached.syncedAtMs);
        }
        setSyncing(true);
        setSyncError(null);
        return syncViaBackground(syncDays)
          .then((result) => {
            setSummary(result);
            setSyncedAtMs(Date.now());
          })
          .catch((e) => setSyncError(String(e)))
          .finally(() => setSyncing(false));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    loadPrefs().then((prefs) => {
      setHideCc(prefs.hideCc);
      setHideGen(prefs.hideGen);
      setPrefsLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (prefsLoaded) savePrefs({ hideCc, hideGen });
  }, [prefsLoaded, hideCc, hideGen]);

  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    loadUpdateInfo()
      .then((info) => setUpdateAvailable(!!info?.available))
      .catch(() => {});
  }, []);

  async function runSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await syncViaBackground(days);
      setSummary(result);
      setSyncedAtMs(Date.now());
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function resolveThreadId(threadId: string) {
    await markThreadResolved(threadId);
    setSummary((prev) =>
      prev
        ? {
            ...prev,
            awaitingMyReply: prev.awaitingMyReply.filter((x) => x.threadId !== threadId),
            awaitingTheirReply: prev.awaitingTheirReply.filter((x) => x.threadId !== threadId),
            allThreads: prev.allThreads.map((t) => (t.threadId === threadId ? { ...t, isResolved: true } : t)),
          }
        : prev,
    );
  }

  function closePanel() {
    if (isEmbedded) window.parent.postMessage({ source: "correo", type: "close" }, "*");
  }

  function goToLabelsWithAddress(address: string) {
    setLabelRuleAddress(address);
    setView("labels");
  }

  const meCount = summary ? visibleFlags(summary.awaitingMyReply, hideCc, hideGen).length : 0;

  const railDefs: [View, string, number][] = [
    ["home", "답장", meCount],
    ["day", "기간", 0],
    ["labels", "라벨", 0],
    ["contacts", "주소록", 0],
    ["settings", "설정", 0],
  ];

  const footer = syncing
    ? "동기화 중…"
    : syncError
      ? `동기화 실패: ${syncError.slice(0, 160)}`
      : summary
      ? `최근 ${days}일 · 스레드 ${summary.threadsScanned}개${syncedAtMs ? " · " + new Date(syncedAtMs).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) + " 동기화" : ""}`
      : "아직 동기화하지 않음";

  return (
    <div className="cr-root">
      <nav className="cr-rail">
        <div className="cr-rail-brand">C</div>
        {railDefs.map(([key, label, badge]) => {
          const Icon = RAIL_ICONS[key];
          return (
            <button
              key={key}
              type="button"
              className={`cr-rail-btn ${view === key ? "active" : ""}`}
              onClick={() => setView(key)}
              title={label}
            >
              <Icon />
              <span>{label}</span>
              {badge > 0 && summary && <span className="cr-rail-badge">{badge > 99 ? "99+" : badge}</span>}
              {key === "settings" && updateAvailable && <span className="cr-rail-badge">!</span>}
            </button>
          );
        })}
        {isEmbedded && (
          <button type="button" className="cr-rail-close" title="닫기" onClick={closePanel}>
            <IconX size={16} />
          </button>
        )}
      </nav>

      <div className="cr-content">
        <div className="cr-view">
          {view === "home" && (
            <Home
              summary={summary}
              syncing={syncing}
              syncError={syncError}
              days={days}
              runSync={runSync}
              filter={homeFilter}
              setFilter={setHomeFilter}
              hideCc={hideCc}
              hideGen={hideGen}
              onResolve={resolveThreadId}
              onGoSettings={() => setView("settings")}
            />
          )}
          {view === "day" && <DayView />}
          {view === "labels" && (
            <Labels initialAddress={labelRuleAddress} onConsumeInitialAddress={() => setLabelRuleAddress(null)} />
          )}
          {view === "contacts" && (
            <Contacts summary={summary} days={days} onCreateRule={goToLabelsWithAddress} />
          )}
          {view === "settings" && (
            <Settings
              account={account}
              onDisconnect={onDisconnect}
              days={days}
              setDays={setDays}
              hideCc={hideCc}
              setHideCc={setHideCc}
              hideGen={hideGen}
              setHideGen={setHideGen}
            />
          )}
        </div>
        <div className="cr-footer">
          <span className="cr-footer-text">{footer}</span>
          <button type="button" className="btn btn-ghost btn-icon" title="다시 동기화" onClick={runSync}>
            <IconRefresh />
          </button>
        </div>
      </div>
    </div>
  );
}
