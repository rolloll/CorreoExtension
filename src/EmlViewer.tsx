import { useEffect, useMemo, useRef, useState } from "react";
import type { Addr, Attachment, ParsedEmail } from "./types";
import { hasRemoteContent, prepareEmailHtml } from "./htmlSafety";
import { parseEmlFile } from "./emlParser";
import { importEml, forwardEml } from "./gmail/api";
import type { GmailAccount } from "./App";
import { IconX } from "./icons";

interface LoadedEmail {
  id: string;
  fileName: string;
  parsed: ParsedEmail;
  rawBytes: Uint8Array;
}

function addrText(addrs: Addr[]): string {
  if (!addrs.length) return "(없음)";
  return addrs.map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? "")).join(", ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "(날짜 없음)";
  try {
    return new Date(iso).toLocaleString("ko-KR");
  } catch {
    return iso;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Tab = "preview" | "headers" | "source";

export default function EmlViewer({ gmailAccount }: { gmailAccount: GmailAccount | null }) {
  const [emails, setEmails] = useState<LoadedEmail[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("preview");
  const [allowRemote, setAllowRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [gmailBusy, setGmailBusy] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  const [forwardNote, setForwardNote] = useState("");

  const active = useMemo(() => emails.find((e) => e.id === activeId) ?? null, [emails, activeId]);

  async function openFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".eml")) continue;
      try {
        const [parsed, buf] = await Promise.all([parseEmlFile(file), file.arrayBuffer()]);
        const id = `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
        setEmails((prev) => [...prev, { id, fileName: file.name, parsed, rawBytes: new Uint8Array(buf) }]);
        setActiveId(id);
        setTab("preview");
        setAllowRemote(false);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    }
  }

  function closeEmail(id: string) {
    setEmails((prev) => prev.filter((e) => e.id !== id));
    if (activeId === id) setActiveId(null);
  }

  function saveAttachment(att: Attachment) {
    const dataUrl = `data:${att.contentType};base64,${att.dataBase64}`;
    chrome.downloads.download({ url: dataUrl, filename: att.filename, saveAs: true }).catch((e) => {
      setError(String(e));
    });
  }

  async function importToGmail() {
    if (!active) return;
    setGmailBusy(true);
    setError(null);
    try {
      await importEml(active.rawBytes);
      setNotice("Gmail로 가져왔습니다.");
    } catch (e) {
      setError(String(e));
    } finally {
      setGmailBusy(false);
    }
  }

  async function submitForward() {
    if (!active || !forwardTo.trim() || !gmailAccount) return;
    setGmailBusy(true);
    setError(null);
    try {
      await forwardEml(
        active.rawBytes,
        active.parsed.subject || "(제목 없음)",
        gmailAccount.email,
        forwardTo.trim(),
        forwardNote.trim() || null,
      );
      setNotice(`전달했습니다: ${forwardTo.trim()}`);
      setForwardOpen(false);
      setForwardTo("");
      setForwardNote("");
    } catch (e) {
      setError(String(e));
    } finally {
      setGmailBusy(false);
    }
  }

  useEffect(() => {
    function onDragOver(e: DragEvent) {
      e.preventDefault();
      setIsDragging(true);
    }
    function onDragLeave(e: DragEvent) {
      if (e.target === document.documentElement) setIsDragging(false);
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer?.files?.length) void openFiles(e.dataTransfer.files);
    }
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const bodyHtml = active?.parsed.htmlBody ?? null;
  const bodyText = active?.parsed.textBody ?? null;
  const remoteBlocked = bodyHtml ? hasRemoteContent(bodyHtml) && !allowRemote : false;
  const srcDoc = bodyHtml
    ? prepareEmailHtml(bodyHtml, allowRemote)
    : bodyText
      ? `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(bodyText)}</pre>`
      : "<p style='color:#888'>(본문 없음)</p>";

  return (
    <div className="ev-root">
      <input
        ref={fileInputRef}
        type="file"
        accept=".eml"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void openFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <aside className="ev-sidebar">
        <button className="btn btn-primary btn-block" onClick={() => fileInputRef.current?.click()}>
          + .eml 파일 열기
        </button>
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          또는 창에 파일을 드래그하세요
        </p>
        <ul className="ev-list">
          {emails.map((e) => (
            <li
              key={e.id}
              className={e.id === activeId ? "active" : ""}
              onClick={() => {
                setActiveId(e.id);
                setTab("preview");
                setAllowRemote(false);
              }}
            >
              <div className="ev-subject">{e.parsed.subject || "(제목 없음)"}</div>
              <div className="ev-from">{addrText(e.parsed.from)}</div>
              <button
                className="ev-close-btn"
                title="닫기"
                onClick={(ev) => {
                  ev.stopPropagation();
                  closeEmail(e.id);
                }}
              >
                <IconX size={14} />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className={`ev-main ${isDragging ? "dragging" : ""}`}>
        {error && (
          <div className="ev-banner error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {notice && (
          <div className="ev-banner notice" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}

        {!active && (
          <div className="ev-empty">
            <h2>Correo</h2>
            <p>가벼운 .eml 뷰어</p>
            <p className="text-muted">파일을 열거나 이 창으로 드래그하세요.</p>
          </div>
        )}

        {active && (
          <>
            <header className="ev-header">
              <h3>{active.parsed.subject || "(제목 없음)"}</h3>
              <div className="ev-meta-row">
                <span className="label">보낸사람</span>
                <span>{addrText(active.parsed.from)}</span>
              </div>
              <div className="ev-meta-row">
                <span className="label">받는사람</span>
                <span>{addrText(active.parsed.to)}</span>
              </div>
              {active.parsed.cc.length > 0 && (
                <div className="ev-meta-row">
                  <span className="label">참조</span>
                  <span>{addrText(active.parsed.cc)}</span>
                </div>
              )}
              <div className="ev-meta-row">
                <span className="label">날짜</span>
                <span>{formatDate(active.parsed.date)}</span>
              </div>
            </header>

            {gmailAccount && (
              <div className="ev-actions">
                <button className="btn btn-secondary" onClick={importToGmail} disabled={gmailBusy}>
                  Gmail로 가져오기
                </button>
                <button className="btn btn-secondary" onClick={() => setForwardOpen((v) => !v)} disabled={gmailBusy}>
                  Gmail로 전달
                </button>
              </div>
            )}

            {forwardOpen && (
              <div className="ev-forward-form">
                <input
                  className="input"
                  type="email"
                  placeholder="받는 사람 이메일"
                  value={forwardTo}
                  onChange={(e) => setForwardTo(e.target.value)}
                />
                <textarea
                  className="input"
                  placeholder="메모 (선택)"
                  value={forwardNote}
                  onChange={(e) => setForwardNote(e.target.value)}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className="btn btn-primary"
                    onClick={submitForward}
                    disabled={gmailBusy || !forwardTo.trim()}
                  >
                    보내기
                  </button>
                  <button className="btn btn-secondary" onClick={() => setForwardOpen(false)}>
                    취소
                  </button>
                </div>
              </div>
            )}

            {active.parsed.attachments.length > 0 && (
              <div className="ev-attachments">
                {active.parsed.attachments.map((att) => (
                  <div className="ev-attachment-chip" key={att.index}>
                    <span>{att.filename}</span>
                    <span className="text-muted">{formatSize(att.size)}</span>
                    <button className="btn btn-ghost" onClick={() => saveAttachment(att)}>
                      저장
                    </button>
                  </div>
                ))}
              </div>
            )}

            <nav className="ev-tabs">
              <button className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>
                미리보기
              </button>
              <button className={tab === "headers" ? "active" : ""} onClick={() => setTab("headers")}>
                원본 헤더
              </button>
              <button className={tab === "source" ? "active" : ""} onClick={() => setTab("source")}>
                원본 소스
              </button>
            </nav>

            {tab === "preview" && (
              <div className="ev-preview-pane">
                {remoteBlocked && (
                  <div className="ev-banner notice">
                    원격 이미지가 차단되었습니다 (추적 방지).
                    <button className="btn btn-ghost" onClick={() => setAllowRemote(true)}>
                      이미지 표시
                    </button>
                  </div>
                )}
                <iframe
                  key={active.id + String(allowRemote)}
                  title="email-body"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  srcDoc={srcDoc}
                  className="ev-body-frame"
                />
              </div>
            )}

            {tab === "headers" && (
              <div className="ev-headers-pane">
                <table>
                  <tbody>
                    {active.parsed.rawHeaders.map(([k, val], i) => (
                      <tr key={i}>
                        <td className="header-name">{k}</td>
                        <td>{val}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "source" && (
              <div className="ev-source-pane">
                <pre>{active.parsed.rawSource}</pre>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
