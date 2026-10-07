import { useEffect, useMemo, useState } from "react";
import type { ContactFormFields, Person } from "./contacts/api";
import { createContact, deleteContact, listContacts, listDirectoryPeople, updateContact } from "./contacts/api";
import type { ActivitySummary } from "./types";
import { IconChevronRight, IconChevronLeft, IconPlus } from "./icons";
import "./Contacts.css";

function displayName(p: Person): string {
  const n = p.names?.[0];
  if (n?.displayName) return n.displayName;
  const joined = [n?.givenName, n?.familyName].filter(Boolean).join(" ");
  if (joined) return joined;
  return p.emailAddresses?.[0]?.value || "(이름 없음)";
}

const emptyForm: ContactFormFields = { givenName: "", familyName: "", email: "", phone: "", org: "" };

type Msg = { type: "ok" | "err"; text: string } | null;
type Source = "personal" | "directory";

interface Row {
  key: string;
  person: Person;
  source: Source;
  name: string;
  email: string;
  org: string;
  phone: string;
}

function matches(row: Row, query: string): boolean {
  if (!query) return true;
  return row.name.toLowerCase().includes(query) || row.email.toLowerCase().includes(query) || row.org.toLowerCase().includes(query);
}

function openThread(threadId: string) {
  void chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#all/${threadId}` });
}

export default function Contacts({
  summary,
  days,
  onCreateRule,
}: {
  summary: ActivitySummary | null;
  days: number;
  onCreateRule: (address: string) => void;
}) {
  const [contacts, setContacts] = useState<Person[]>([]);
  const [directoryContacts, setDirectoryContacts] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);

  const [search, setSearch] = useState("");
  const [srcFilter, setSrcFilter] = useState<"all" | Source>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ContactFormFields>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [personal, directory] = await Promise.all([
        listContacts().catch(() => []),
        listDirectoryPeople().catch(() => []),
      ]);
      setContacts(personal);
      setDirectoryContacts(directory);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const rows: Row[] = useMemo(() => {
    const personal: Row[] = contacts.map((p) => ({
      key: `p:${p.resourceName}`,
      person: p,
      source: "personal",
      name: displayName(p),
      email: p.emailAddresses?.[0]?.value || "",
      org: p.organizations?.[0]?.name || "개인",
      phone: p.phoneNumbers?.[0]?.value || "",
    }));
    const directory: Row[] = directoryContacts.map((p) => ({
      key: `d:${p.resourceName}`,
      person: p,
      source: "directory",
      name: displayName(p),
      email: p.emailAddresses?.[0]?.value || "",
      org: p.organizations?.[0]?.name || "회사 디렉터리",
      phone: p.phoneNumbers?.[0]?.value || "",
    }));
    return [...personal, ...directory];
  }, [contacts, directoryContacts]);

  const query = search.trim().toLowerCase();
  const filtered = rows.filter((r) => (srcFilter === "all" || r.source === srcFilter) && matches(r, query));

  const orgGroups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of filtered) {
      const org = r.org.split(" · ")[0] || "기타";
      if (!map.has(org)) map.set(org, []);
      map.get(org)!.push(r);
    }
    return Array.from(map.entries());
  }, [filtered]);

  function waitCountOf(email: string): number {
    if (!summary || !email) return 0;
    return (
      summary.awaitingMyReply.filter((t) => t.counterpartAddress === email).length +
      summary.awaitingTheirReply.filter((t) => t.counterpartAddress === email).length
    );
  }

  const selected = rows.find((r) => r.key === selectedKey) || null;

  function selectRow(r: Row) {
    setSelectedKey(r.key);
    setCreatingNew(false);
    setEditing(false);
    setMsg(null);
    const n = r.person.names?.[0];
    setForm({
      givenName: n?.givenName || "",
      familyName: n?.familyName || "",
      email: r.email,
      phone: r.phone,
      org: r.person.organizations?.[0]?.name || "",
    });
  }

  function startCreate() {
    setSelectedKey(null);
    setCreatingNew(true);
    setEditing(true);
    setForm(emptyForm);
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      if (creatingNew) {
        const created = await createContact(form);
        setMsg({ type: "ok", text: "연락처를 만들었습니다." });
        await refresh();
        setCreatingNew(false);
        setSelectedKey(`p:${created.resourceName}`);
        setEditing(false);
      } else if (selected) {
        const updated = await updateContact(selected.person.resourceName, selected.person.etag, form);
        setMsg({ type: "ok", text: "연락처를 저장했습니다." });
        await refresh();
        setSelectedKey(`p:${updated.resourceName}`);
        setEditing(false);
      }
    } catch (e) {
      setMsg({ type: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    if (!window.confirm(`"${selected.name}" 연락처를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    try {
      await deleteContact(selected.person.resourceName);
      setSelectedKey(null);
      await refresh();
    } catch (e) {
      setMsg({ type: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const detailThreads = selected && summary
    ? summary.allThreads.filter((t) => t.counterpartAddress === selected.email).slice(0, 3)
    : [];

  const srcs: { key: "all" | Source; label: string }[] = [
    { key: "all", label: "전체" },
    { key: "personal", label: "개인" },
    { key: "directory", label: "디렉터리" },
  ];

  if (selected || creatingNew) {
    const isDirectory = selected?.source === "directory";
    const wait = selected ? waitCountOf(selected.email) : 0;
    const sent = selected && summary ? summary.correspondents.find((c) => c.address === selected.email)?.sentCount ?? 0 : 0;
    const recv = selected && summary ? summary.correspondents.find((c) => c.address === selected.email)?.receivedCount ?? 0 : 0;

    return (
      <div className="ct-root">
        <div className="ct-back-row">
          <button
            className="btn btn-ghost"
            onClick={() => {
              setSelectedKey(null);
              setCreatingNew(false);
            }}
          >
            <IconChevronLeft />
            주소록
          </button>
        </div>
        <div className="ct-detail-scroll">
          {!editing ? (
            <>
              <div>
                <div className="card-kicker">{creatingNew ? "새 연락처" : isDirectory ? "회사 디렉터리" : "개인 연락처"}</div>
                <div className="ct-detail-name">{selected?.name}</div>
                <div className="ct-detail-org">{selected?.org}</div>
              </div>
              <div className="ct-fields">
                <div className="ct-field-row">
                  <span className="text-muted">이메일</span>
                  <span>{selected?.email || "—"}</span>
                </div>
                <div className="ct-field-row">
                  <span className="text-muted">전화</span>
                  <span>{selected?.phone || "전화번호 없음"}</span>
                </div>
              </div>
              {!isDirectory && (
                <div className="blueprint ct-stats">
                  <i className="corner tl" />
                  <i className="corner tr" />
                  <i className="corner bl" />
                  <i className="corner br" />
                  <div className="ct-stat-cell">
                    <div className="ct-stat-n">{sent}</div>
                    <div className="ct-stat-label">보냄</div>
                  </div>
                  <div className="ct-stat-cell">
                    <div className="ct-stat-n">{recv}</div>
                    <div className="ct-stat-label">받음</div>
                  </div>
                  <div className="ct-stat-cell accent">
                    <div className="ct-stat-n">{wait}</div>
                    <div className="ct-stat-label">답장 대기</div>
                  </div>
                </div>
              )}
              <div className="ct-threads">
                <div className="ct-threads-title">최근 스레드</div>
                {detailThreads.map((t) => (
                  <div key={t.threadId} className="ct-thread-row" onClick={() => openThread(t.threadId)}>
                    <span className="ct-thread-subject">{t.subject}</span>
                    <span className="text-muted">{t.lastDateMs ? new Date(t.lastDateMs).toLocaleDateString("ko-KR") : ""}</span>
                  </div>
                ))}
                {detailThreads.length === 0 && (
                  <p className="text-muted" style={{ fontSize: 12 }}>
                    최근 {days}일간 주고받은 메일이 없습니다.
                  </p>
                )}
              </div>
              <div className="ct-actions-row">
                {selected && (
                  <button className="btn btn-primary" onClick={() => onCreateRule(selected.email)}>
                    라벨 규칙 만들기
                  </button>
                )}
                {selected?.email && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      navigator.clipboard?.writeText(selected.email).catch(() => {});
                      setMsg({ type: "ok", text: `주소를 복사했습니다: ${selected.email}` });
                    }}
                  >
                    주소 복사
                  </button>
                )}
                {!isDirectory && selected && (
                  <button className="btn btn-secondary" onClick={() => setEditing(true)}>
                    편집
                  </button>
                )}
              </div>
              {msg && <p className={msg.type === "ok" ? "ct-success" : "ct-error"}>{msg.text}</p>}
            </>
          ) : (
            <>
              <div className="card-title">{creatingNew ? "새 연락처" : "연락처 편집"}</div>
              <div className="ct-form">
                <label>
                  이름
                  <input className="input" value={form.givenName} onChange={(e) => setForm({ ...form, givenName: e.target.value })} />
                </label>
                <label>
                  성
                  <input className="input" value={form.familyName} onChange={(e) => setForm({ ...form, familyName: e.target.value })} />
                </label>
                <label>
                  이메일
                  <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </label>
                <label>
                  전화번호
                  <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </label>
                <label>
                  회사/조직
                  <input className="input" value={form.org} onChange={(e) => setForm({ ...form, org: e.target.value })} />
                </label>
              </div>
              <div className="ct-actions-row">
                <button className="btn btn-primary" onClick={save} disabled={busy}>
                  {busy ? "저장 중…" : creatingNew ? "만들기" : "저장"}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => (creatingNew ? setCreatingNew(false) : setEditing(false))}
                >
                  취소
                </button>
                {!creatingNew && (
                  <button className="btn btn-secondary ct-danger" onClick={remove} disabled={busy}>
                    삭제
                  </button>
                )}
              </div>
              {msg && <p className={msg.type === "ok" ? "ct-success" : "ct-error"}>{msg.text}</p>}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ct-root">
      <div className="ct-list-head">
        <span className="ct-list-title">주소록</span>
        <div className="ct-search-row">
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="이름, 이메일, 회사 검색"
          />
          <button className="btn btn-secondary btn-icon" title="새 연락처" onClick={startCreate}>
            <IconPlus />
          </button>
        </div>
        <div className="seg ct-src-seg">
          {srcs.map((s) => (
            <label key={s.key} className="seg-opt">
              <input type="radio" name="ct-src" checked={srcFilter === s.key} onChange={() => setSrcFilter(s.key)} />
              {s.label}
            </label>
          ))}
        </div>
      </div>
      <div className="ct-list-scroll">
        {loading && <p className="text-muted" style={{ padding: 14 }}>불러오는 중…</p>}
        {orgGroups.map(([org, items]) => (
          <div key={org}>
            <div className="ct-org-head">
              <span>{org}</span>
              <span>{items.length}</span>
            </div>
            {items.map((r) => {
              const wait = waitCountOf(r.email);
              return (
                <div key={r.key} className="ct-row" onClick={() => selectRow(r)}>
                  <div className="ct-row-text">
                    <div className="ct-row-name">{r.name}</div>
                    <div className="ct-row-email">{r.email}</div>
                  </div>
                  {wait > 0 && <span className="ct-row-wait">대기 {wait}</span>}
                  <IconChevronRight size={14} />
                </div>
              );
            })}
          </div>
        ))}
        {!loading && orgGroups.length === 0 && <p className="text-muted" style={{ padding: 14 }}>연락처가 없습니다.</p>}
      </div>
    </div>
  );
}
