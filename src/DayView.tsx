import { useEffect, useRef, useState } from "react";
import { loadAliasConfig, normalizeAddress } from "./aliases";
import { loadAddressInfo, listMessagesInRange, type DayMessage, type RangeStats } from "./gmail/api";
import { loadTrackerConfig, loadTracked, fetchHits, findTracked, realHits } from "./tracking";
import { downloadExport, type ExportFormat, type ExportOptions } from "./exportMessages";
import { activeProvider, loadAiConfig, providerLabel } from "./aiProviders";
import { countUncached, summarizeMessages } from "./aiSummary";
import KeywordChips from "./KeywordChips";
import { DEFAULT_GROUPS, OTHER_GROUP, groupOf, loadGroups, saveGroups, type MailGroup } from "./groups";
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
  // "" = every address of mine; otherwise one account (primary or alias).
  const [account, setAccount] = useState("");
  const [myAccounts, setMyAccounts] = useState<string[]>([]);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [withSummary, setWithSummary] = useState(false);
  const [summarizing, setSummarizing] = useState<{ done: number; total: number } | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const [groups, setGroups] = useState<MailGroup[]>(DEFAULT_GROUPS);
  const [groupFilter, setGroupFilter] = useState("all");
  const [editingGroups, setEditingGroups] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stats, setStats] = useState<RangeStats | null>(null);
  // messageId -> null (tracked, no read yet) | first-read time; absent = not tracked
  const [reads, setReads] = useState<Record<string, number | null>>({});

  const valid = !!from && !!to && from <= to;

  useEffect(() => {
    loadGroups().then(setGroups).catch(() => {});
    // The connected Gmail account plus its send-as aliases and the extras added in 설정.
    Promise.all([loadAddressInfo(), loadAliasConfig()])
      .then(([info, cfg]) => {
        const excluded = new Set(cfg.excluded.map(normalizeAddress));
        const list = [info.primary, ...info.sendAs.filter((a) => !excluded.has(a)), ...cfg.extra.map(normalizeAddress)];
        setMyAccounts([...new Set(list)]);
      })
      .catch(() => {});
  }, []);

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
    setProgress(null);
    setStats(null);
    listMessagesInRange(from, to, sender, {
      account,
      isCancelled: () => cancelled,
      onProgress: (done, total) => !cancelled && setProgress({ done, total }),
    })
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        setTruncated(r.truncated);
        setStats(r.stats);
        void loadReads(r.messages, () => cancelled);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [from, to, valid, sender, account]);

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
  const byDir = messages?.filter((m) => filter === "all" || m.direction === filter) ?? [];
  const groupNames = [...groups.map((g) => g.name), OTHER_GROUP];
  const groupCount = (name: string) => byDir.filter((m) => groupOf(m, groups) === name).length;
  // A removed group can leave a stale selection behind; fall back to showing all.
  const activeGroup = groupNames.includes(groupFilter) ? groupFilter : "all";
  const shown = activeGroup === "all" ? byDir : byDir.filter((m) => groupOf(m, groups) === activeGroup);
  const isRange = from !== to;

  async function runExport() {
    setExportMsg(null);
    const opts: ExportOptions = { groupOf: (m) => groupOf(m, groups) };
    if (withSummary) {
      const cfg = await loadAiConfig();
      const provider = activeProvider(cfg);
      if (!provider.apiKey.trim()) {
        setExportMsg("설정 → AI 요약에서 API 키를 먼저 저장해 주세요.");
        return;
      }
      const fresh = await countUncached(shown, cfg);
      if (
        fresh > 0 &&
        !window.confirm(
          `${fresh}건을 ${providerLabel(cfg.active)}(${provider.model})로 요약합니다.\n\n` +
            "· 각 메일의 제목·보낸 사람·본문이 해당 서비스로 전송됩니다.\n" +
            "· 서비스 이용료가 발생할 수 있습니다 (이미 요약한 메일은 저장본을 씁니다).\n\n계속할까요?",
        )
      ) {
        return;
      }
      cancelRef.current = false;
      setSummarizing({ done: 0, total: shown.length });
      try {
        opts.summaries = await summarizeMessages(shown, cfg, {
          isCancelled: () => cancelRef.current,
          onProgress: (done, total) => setSummarizing({ done, total }),
        });
      } catch (e) {
        setSummarizing(null);
        setExportMsg(e instanceof Error ? e.message : String(e));
        return;
      }
      setSummarizing(null);
      if (cancelRef.current) {
        setExportMsg("요약을 취소했습니다. 파일은 만들지 않았습니다.");
        return;
      }
    }
    downloadExport(shown, exportFormat, from, to, opts);
  }

  function updateGroups(next: MailGroup[]) {
    setGroups(next);
    void saveGroups(next);
  }

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
        <select
          className="dv-date"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          aria-label="내 계정"
          title="이 계정으로 받았거나 이 계정에서 보낸 메일만 봅니다"
        >
          <option value="">내 계정: 전체 (받은 메일 + 보낸 메일)</option>
          {myAccounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="dv-picker">
        <input
          type="text"
          className="dv-date"
          placeholder="상대방 (보낸·받는 사람 이름 또는 주소) — 비우면 전체"
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

      <div className="dv-groups">
        {["all", ...groupNames].map((name) => (
          <button
            key={name}
            type="button"
            className={`dv-group ${activeGroup === name ? "active" : ""}`}
            onClick={() => setGroupFilter(name)}
          >
            {name === "all" ? "모두" : name}
            {messages && <span className="dv-tab-n">{name === "all" ? byDir.length : groupCount(name)}</span>}
          </button>
        ))}
        <button type="button" className="dv-preset dv-group-edit" onClick={() => setEditingGroups((v) => !v)}>
          {editingGroups ? "닫기" : "그룹 설정"}
        </button>
      </div>
      {editingGroups && (
        <div className="dv-group-editor">
          <div className="text-muted dv-group-help">
            제목 또는 보낸/받는 사람의 이름·주소에 키워드가 들어 있으면 해당 그룹으로 분류합니다 (위에서부터 먼저 맞는 그룹).
            Gmail 라벨은 바뀌지 않습니다.
          </div>
          {groups.map((g, i) => (
            <div key={`${i}-${g.name}`} className="dv-group-card">
              <div className="dv-group-row">
                <input
                  className="dv-date dv-group-name"
                  defaultValue={g.name}
                  aria-label="그룹 이름"
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== g.name) updateGroups(groups.map((x, j) => (j === i ? { ...x, name } : x)));
                  }}
                />
                <button type="button" className="dv-preset" onClick={() => updateGroups(groups.filter((_, j) => j !== i))}>
                  그룹 삭제
                </button>
              </div>
              <KeywordChips
                keywords={g.keywords}
                onChange={(keywords) => updateGroups(groups.map((x, j) => (j === i ? { ...x, keywords } : x)))}
              />
            </div>
          ))}
          <div className="dv-group-row">
            <button
              type="button"
              className="dv-preset"
              onClick={() => updateGroups([...groups, { name: `그룹 ${groups.length + 1}`, keywords: [] }])}
            >
              + 그룹 추가
            </button>
            <button type="button" className="dv-preset" onClick={() => updateGroups(DEFAULT_GROUPS)}>
              기본값으로
            </button>
          </div>
        </div>
      )}
      <div className="dv-export">
        <select
          className="dv-date dv-export-fmt"
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
          aria-label="파일 형식"
        >
          <option value="csv">CSV (엑셀)</option>
          <option value="txt">텍스트 (.txt)</option>
        </select>
        <button
          type="button"
          className="dv-preset"
          disabled={!messages || shown.length === 0 || !!summarizing}
          onClick={runExport}
        >
          추출 ({shown.length}건)
        </button>
        <label className="dv-export-ai" title="설정 → AI 요약에서 저장한 API 키로 각 메일을 1~3줄로 요약해 파일에 넣습니다">
          <input type="checkbox" checked={withSummary} onChange={(e) => setWithSummary(e.target.checked)} />
          AI 요약 포함
        </label>
      </div>
      {(summarizing || exportMsg) && (
        <div className="dv-export-status">
          {summarizing && (
            <>
              <span>
                요약 중… {summarizing.done}/{summarizing.total}
              </span>
              <button type="button" className="dv-preset" onClick={() => (cancelRef.current = true)}>
                취소
              </button>
            </>
          )}
          {!summarizing && exportMsg && <span className="dv-error-inline">{exportMsg}</span>}
        </div>
      )}

      <div className="dv-list">
        {error && <p className="dv-error">{error}</p>}
        {!valid && <div className="dv-empty text-muted">날짜를 선택하세요.</div>}
        {valid && !error && !messages && (
          <div className="dv-empty text-muted">
            불러오는 중…{progress ? ` ${progress.done}/${progress.total}` : ""}
          </div>
        )}
        {stats && (
          <div className="dv-note">
            {stats.total}통 · {(stats.elapsedMs / 1000).toFixed(1)}초
            {stats.total > stats.fetched ? ` · ${stats.total - stats.fetched}통은 저장본 사용` : ""}
            {stats.rateLimitWaitMs > 0 ? ` · Gmail 호출 제한 대기 ${(stats.rateLimitWaitMs / 1000).toFixed(0)}초` : ""}
          </div>
        )}
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
                    <span className="dv-group-tag">{groupOf(m, groups)}</span>
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
