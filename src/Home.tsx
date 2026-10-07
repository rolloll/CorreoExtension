import { useMemo, useState } from "react";
import type { ActivitySummary, ThreadFlag, ThreadTag } from "./types";
import type { HomeFilter } from "./Shell";
import { visibleFlags } from "./Shell";
import { addThreadAsTask } from "./gmail/tasks";
import { IconChevronDown } from "./icons";
import "./Home.css";

function openThread(threadId: string) {
  void chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#all/${threadId}` });
}

function isToday(ms: number): boolean {
  const d = new Date(ms);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

interface Item {
  threadId: string;
  name: string;
  cc: boolean;
  days: number;
  dtag: string;
  subject: string;
  statusLabel: string | null;
  statusCls: string;
  barAccent: boolean;
}

function daysSince(ms: number | null): number {
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

function fromFlag(t: ThreadFlag, barAccent: boolean, statusLabel: string | null, statusCls: string): Item {
  const days = daysSince(t.lastDateMs);
  return {
    threadId: t.threadId,
    name: t.counterpartName || t.counterpartAddress,
    cc: t.ccOnly,
    days,
    dtag: days === 0 ? "오늘" : `D+${days}`,
    subject: t.subject,
    statusLabel,
    statusCls,
    barAccent,
  };
}

function fromReceivedTag(t: ThreadTag): Item {
  const days = daysSince(t.lastReceivedMs);
  return {
    threadId: t.threadId,
    name: t.lastReceivedName || t.lastReceivedAddress || "(알 수 없음)",
    cc: t.toOrCc === "cc",
    days,
    dtag: days === 0 ? "오늘" : `D+${days}`,
    subject: t.subject,
    statusLabel: t.repliedAfterLastReceived ? "답장함" : "답장 대기",
    statusCls: t.repliedAfterLastReceived ? "tag-neutral" : "tag-accent",
    barAccent: !t.repliedAfterLastReceived,
  };
}

export default function Home({
  summary,
  syncing,
  syncError,
  days,
  runSync,
  filter,
  setFilter,
  hideCc,
  hideGen,
  onResolve,
  onGoSettings,
}: {
  summary: ActivitySummary | null;
  syncing: boolean;
  syncError: string | null;
  days: number;
  runSync: () => void;
  filter: HomeFilter;
  setFilter: (f: HomeFilter) => void;
  hideCc: boolean;
  hideGen: boolean;
  onResolve: (threadId: string) => Promise<void>;
  onGoSettings: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [taskDone, setTaskDone] = useState<Record<string, boolean>>({});
  const [taskBusy, setTaskBusy] = useState<string | null>(null);

  const todayLabel = useMemo(
    () => new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" }),
    [],
  );

  const me = summary ? visibleFlags(summary.awaitingMyReply, hideCc, hideGen) : [];
  const them = summary ? visibleFlags(summary.awaitingTheirReply, hideCc, hideGen) : [];
  const todayReceived = summary
    ? summary.allThreads.filter(
        (t) =>
          !t.isResolved &&
          t.lastReceivedMs !== null &&
          isToday(t.lastReceivedMs) &&
          !(hideCc && t.toOrCc === "cc") &&
          !(hideGen && t.isGeneric),
      )
    : [];

  // Why "오늘 받음" is empty, shown only when it is: separates "no mail has
  // today's date in the synced data" (stale/failed sync) from "filtered out".
  const withReceived = summary ? summary.allThreads.filter((t) => t.lastReceivedMs !== null) : [];
  const newestReceivedMs = withReceived.reduce((m, t) => Math.max(m, t.lastReceivedMs ?? 0), 0);
  const todayRaw = withReceived.filter((t) => isToday(t.lastReceivedMs as number));
  const todayDiag =
    summary && todayReceived.length === 0
      ? todayRaw.length === 0
        ? `동기화된 데이터에 오늘 받은 메일이 없습니다. 가장 최근 수신: ${
            newestReceivedMs ? new Date(newestReceivedMs).toLocaleString("ko-KR") : "없음"
          } (스레드 ${summary.allThreads.length}개). 다시 동기화해 보세요.`
        : `오늘 받은 스레드 ${todayRaw.length}개가 필터로 제외됨 — 종결 ${todayRaw.filter((t) => t.isResolved).length}, 참조 ${
            todayRaw.filter((t) => t.toOrCc === "cc").length
          }, 공용 주소 ${todayRaw.filter((t) => t.isGeneric).length}`
      : null;

  const plate: { key: HomeFilter; label: string; n: number }[] = [
    { key: "me", label: "내 차례", n: me.length },
    { key: "them", label: "상대 차례", n: them.length },
    { key: "today", label: "오늘 받음", n: todayReceived.length },
  ];

  const items: Item[] =
    filter === "me"
      ? me.map((t) => fromFlag(t, true, "답장 대기", "tag-accent"))
      : filter === "them"
        ? them.map((t) => fromFlag(t, false, "답장함", "tag-neutral"))
        : todayReceived.map(fromReceivedTag);

  const buckets =
    filter === "today"
      ? [{ key: "d0", title: "오늘", items }]
      : [
          { key: "d0", title: "오늘", items: items.filter((it) => it.days === 0) },
          { key: "d1", title: "1–3일", items: items.filter((it) => it.days >= 1 && it.days <= 3) },
          { key: "d4", title: "4일 이상", items: items.filter((it) => it.days >= 4) },
        ].filter((b) => b.items.length > 0);

  const excl = [hideCc && "참조", hideGen && "공용 주소"].filter(Boolean) as string[];
  const filterNote = excl.length ? `${excl.join("·")} 제외됨` : "모든 메일 표시";

  async function handleTask(threadId: string, subject: string) {
    if (taskDone[threadId]) return;
    setTaskBusy(threadId);
    try {
      await addThreadAsTask(threadId, subject);
      setTaskDone((prev) => ({ ...prev, [threadId]: true }));
    } finally {
      setTaskBusy(null);
    }
  }

  async function handleResolve(threadId: string) {
    setResolvingId(threadId);
    try {
      await onResolve(threadId);
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="hm-root">
      <div className="hm-head">
        <span className="hm-head-title">오늘</span>
        <span className="hm-head-date">{todayLabel}</span>
      </div>

      {!summary ? (
        <div className="hm-sync-wrap">
          <div className="card blueprint hm-sync-card">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            <div className="card-kicker">첫 동기화</div>
            <div className="card-title">최근 {days}일 메일을 스캔합니다</div>
            <p className="card-body">기간은 설정에서 바꿀 수 있습니다.</p>
            <button className="btn btn-primary" style={{ justifyContent: "flex-start" }} onClick={runSync} disabled={syncing}>
              {syncing ? "동기화 중…" : "지금 동기화"}
            </button>
            {syncing && (
              <div className="hm-progress">
                <div className="hm-progress-bar" />
              </div>
            )}
            {syncError && <p className="hm-error">{syncError}</p>}
          </div>
        </div>
      ) : (
        <>
          <div className="blueprint hm-plate">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            {plate.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`hm-plate-btn ${filter === p.key ? "active" : ""}`}
                onClick={() => setFilter(p.key)}
              >
                <span className="hm-plate-n">{p.n}</span>
                <span className="hm-plate-label">{p.label}</span>
              </button>
            ))}
          </div>
          <div className="hm-filternote">
            {filterNote} ·{" "}
            <a
              href="#settings"
              onClick={(e) => {
                e.preventDefault();
                onGoSettings();
              }}
            >
              변경
            </a>
          </div>

          <div className="hm-list">
            {buckets.map((b) => (
              <div key={b.key} className="hm-bucket">
                <button
                  type="button"
                  className="hm-bucket-head"
                  onClick={() => setCollapsed((p) => ({ ...p, [b.key]: !p[b.key] }))}
                >
                  <span className={`hm-bucket-chevron ${collapsed[b.key] ? "collapsed" : ""}`}>
                    <IconChevronDown size={12} />
                  </span>
                  {b.title}
                  <span className="hm-bucket-count">{b.items.length}</span>
                </button>
                {!collapsed[b.key] &&
                  b.items.map((it) => (
                    <div key={it.threadId} className="hm-item">
                      <span className={`hm-item-bar ${it.barAccent ? "accent" : ""}`} />
                      <div className="hm-item-body">
                        <div
                          className="hm-item-row"
                          onClick={() => setOpenRow((p) => (p === it.threadId ? null : it.threadId))}
                        >
                          <span className="hm-item-name">{it.name}</span>
                          {it.cc && <span className="text-muted">참조</span>}
                          <span className="hm-item-dtag">{it.dtag}</span>
                        </div>
                        <div className="hm-item-subject" onClick={() => setOpenRow((p) => (p === it.threadId ? null : it.threadId))}>
                          {it.subject}
                          {it.statusLabel && (
                            <span className={`tag ${it.statusCls}`} style={{ marginLeft: 6 }}>
                              {it.statusLabel}
                            </span>
                          )}
                        </div>
                        {openRow === it.threadId && (
                          <div className="hm-item-actions">
                            <button className="btn btn-primary" onClick={() => openThread(it.threadId)}>
                              Gmail에서 열기
                            </button>
                            <button
                              className="btn btn-secondary"
                              disabled={taskBusy === it.threadId}
                              onClick={() => handleTask(it.threadId, it.subject)}
                            >
                              {taskDone[it.threadId] ? "할 일 추가됨" : taskBusy === it.threadId ? "추가 중…" : "할 일로"}
                            </button>
                            <button
                              className="btn btn-secondary"
                              disabled={resolvingId === it.threadId}
                              onClick={() => handleResolve(it.threadId)}
                            >
                              {resolvingId === it.threadId ? "처리 중…" : "종결"}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            ))}
            {filter === "today" && todayDiag && <div className="hm-empty text-muted" style={{ fontSize: 12 }}>{todayDiag}</div>}
            {buckets.length === 0 && filter !== "today" && (
              <div className="hm-empty">
                <div className="hm-empty-title">모두 처리했습니다</div>
                <div className="text-muted">새 메일은 다음 동기화 때 여기에 나타납니다.</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
