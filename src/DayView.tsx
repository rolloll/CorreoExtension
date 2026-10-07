import { useEffect, useState } from "react";
import { listMessagesInRange, type DayMessage } from "./gmail/api";
import { loadTrackerConfig, loadTracked, fetchHits, findTracked, realHits } from "./tracking";
import "./DayView.css";

type DirFilter = "all" | "received" | "sent";

function toDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateStr(d);
}

function openThread(threadId: string) {
  void chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#all/${threadId}` });
}

function dayHeading(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
}

export default function DayView() {
  const todayStr = toDateStr(new Date());
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [filter, setFilter] = useState<DirFilter>("all");
  const [senderInput, setSenderInput] = useState("");
  const [sender, setSender] = useState("");
  const [messages, setMessages] = useState<DayMessage[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // messageId -> null (tracked, no read yet) | first-read time; absent = not tracked
  const [reads, setReads] = useState<Record<string, number | null>>({});

  const valid = !!from && !!to && from <= to;

  // Debounce typing so each keystroke doesn't trigger a Gmail search.
  useEffect(() => {
    const t = setTimeout(() => setSender(senderInput.trim()), 500);
    return () => clearTimeout(t);
  }, [senderInput]);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    setMessages(null);
    setError(null);
    listMessagesInRange(from, to, sender)
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        setTruncated(r.truncated);
        void loadReads(r.messages, () => cancelled);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [from, to, valid, sender]);

  async function loadReads(msgs: DayMessage[], isCancelled: () => boolean) {
    try {
      const cfg = await loadTrackerConfig();
      if (!cfg.url || !cfg.token) return;
      const tracked = await loadTracked();
      const matched: { msgId: string; id: string; sentMs: number }[] = [];
      for (const m of msgs) {
        if (m.direction !== "sent") continue;
        const t = findTracked(tracked, m.subject, m.peers.map((p) => p.addr), m.timeMs);
        if (t) matched.push({ msgId: m.messageId, id: t.id, sentMs: t.sentMs });
      }
      if (matched.length === 0) return;
      const hits = await fetchHits(cfg, matched.map((x) => x.id));
      if (isCancelled()) return;
      const next: Record<string, number | null> = {};
      for (const x of matched) {
        const real = realHits(hits[x.id] ?? [], x.sentMs);
        next[x.msgId] = real.length ? real[0].t : null;
      }
      setReads(next);
    } catch {
      // Tracking is best-effort; the list still works without it.
    }
  }

  function setRange(f: string, t: string) {
    setFrom(f);
    setTo(t);
  }

  function changeFrom(v: string) {
    if (!v) return;
    setFrom(v);
    if (to < v) setTo(v);
  }

  function changeTo(v: string) {
    if (!v) return;
    setTo(v);
    if (from > v) setFrom(v);
  }

  const received = messages?.filter((m) => m.direction === "received").length ?? 0;
  const sent = messages?.filter((m) => m.direction === "sent").length ?? 0;
  const shown = messages?.filter((m) => filter === "all" || m.direction === filter) ?? [];
  const isRange = from !== to;

  const tabs: { key: DirFilter; label: string; n: number }[] = [
    { key: "all", label: "전체", n: received + sent },
    { key: "received", label: "받은 메일", n: received },
    { key: "sent", label: "보낸 메일", n: sent },
  ];

  const presets: { label: string; f: string; t: string }[] = [
    { label: "오늘", f: todayStr, t: todayStr },
    { label: "어제", f: daysAgo(1), t: daysAgo(1) },
    { label: "최근 7일", f: daysAgo(6), t: todayStr },
    { label: "최근 30일", f: daysAgo(29), t: todayStr },
  ];

  let lastDay = "";

  return (
    <div className="dv-root">
      <div className="dv-head">
        <span className="dv-title">기간별</span>
      </div>
      <div className="dv-picker">
        <input type="date" className="dv-date" value={from} max={todayStr} onChange={(e) => changeFrom(e.target.value)} />
        <span className="dv-sep">~</span>
        <input type="date" className="dv-date" value={to} max={todayStr} onChange={(e) => changeTo(e.target.value)} />
      </div>
      <div className="dv-picker">
        <input
          type="text"
          className="dv-date"
          placeholder="보낸 사람 (이름 또는 주소) — 비우면 전체"
          value={senderInput}
          onChange={(e) => setSenderInput(e.target.value)}
        />
        {senderInput && (
          <button type="button" className="dv-preset" onClick={() => setSenderInput("")}>
            지우기
          </button>
        )}
      </div>
      <div className="dv-presets">
        {presets.map((p) => (
          <button key={p.label} type="button" className="dv-preset" onClick={() => setRange(p.f, p.t)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="dv-tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`dv-tab ${filter === t.key ? "active" : ""}`}
            onClick={() => setFilter(t.key)}
          >
            {t.label} <span className="dv-tab-n">{messages ? t.n : "–"}</span>
          </button>
        ))}
      </div>

      <div className="dv-list">
        {error && <p className="dv-error">{error}</p>}
        {!valid && <div className="dv-empty text-muted">날짜를 선택하세요.</div>}
        {valid && !error && !messages && <div className="dv-empty text-muted">불러오는 중…</div>}
        {messages && shown.length === 0 && <div className="dv-empty text-muted">해당 기간의 메일이 없습니다.</div>}
        {truncated && <div className="dv-note">메일이 많아 최근 1,000통까지만 표시합니다. 기간을 좁혀 보세요.</div>}
        {shown.map((m) => {
          const names = m.peers.map((p) => p.name || p.addr);
          const peerText = names.length
            ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` 외 ${names.length - 2}` : "")
            : "(알 수 없음)";
          const day = toDateStr(new Date(m.timeMs));
          const showDay = isRange && day !== lastDay;
          lastDay = day;
          return (
            <div key={m.messageId}>
              {showDay && <div className="dv-day">{dayHeading(day)}</div>}
              <div className={`dv-item ${m.toMe ? "to-me" : ""}`} onClick={() => openThread(m.threadId)} title="Gmail에서 열기">
                <span className={`dv-dir ${m.direction}`}>{m.direction === "sent" ? "보냄" : "받음"}</span>
                <div className="dv-item-body">
                  <div className="dv-item-row">
                    <span className="dv-item-name">{peerText}</span>
                    {m.cc && <span className="text-muted">참조</span>}
                    <span className="dv-item-time">
                      {new Date(m.timeMs).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}
                    </span>
                  </div>
                  <div className="dv-item-subject">
                    {m.subject}
                    {m.messageId in reads && (
                      <span className={`dv-read ${reads[m.messageId] ? "on" : ""}`}>
                        {reads[m.messageId]
                          ? `열람 추정 ${new Date(reads[m.messageId] as number).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`
                          : "미열람"}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
