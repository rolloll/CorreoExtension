import { useEffect, useState } from "react";
import {
  getAuthToken,
  getAccountEmail,
  signOut,
  saveAccountEmail,
  loadAccountEmail,
  clearAccountEmail,
} from "./gmail/auth";
import Shell from "./Shell";
import EmlViewer from "./EmlViewer";
import "./theme.css";
import "./App.css";

export interface GmailAccount {
  email: string;
}

function initialFilterFromUrl(): "me" | "them" | null {
  const f = new URLSearchParams(location.search).get("filter");
  return f === "me" || f === "them" ? f : null;
}

export default function App() {
  const isEmlView = new URLSearchParams(location.search).get("view") === "eml";
  const [gmailAccount, setGmailAccount] = useState<GmailAccount | null>(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAccountEmail()
      .then((email) => setGmailAccount(email ? { email } : null))
      .catch(() => setGmailAccount(null));
  }, []);

  async function connectGmail() {
    setGmailLoading(true);
    setError(null);
    try {
      const token = await getAuthToken(true);
      const email = await getAccountEmail(token);
      await saveAccountEmail(email);
      setGmailAccount({ email });
    } catch (e) {
      setError(String(e));
    } finally {
      setGmailLoading(false);
    }
  }

  async function disconnectGmail() {
    try {
      await signOut();
      await clearAccountEmail();
      setGmailAccount(null);
    } catch (e) {
      setError(String(e));
    }
  }

  if (isEmlView) {
    return <EmlViewer gmailAccount={gmailAccount} />;
  }

  if (!gmailAccount) {
    return (
      <div className="cr-root cr-pitch-root">
        <div className="cr-pitch">
          <div className="cr-pitch-title">
            받은편지함을
            <br />
            정리할 준비.
          </div>
          <p className="cr-pitch-body">
            Google 계정을 연결하면 답장 대기 메일이 받은편지함 행에 바로 표시됩니다.
          </p>
          <div className="blueprint cr-pitch-grid">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            <div className="cr-pitch-cell">
              <div className="cr-pitch-cell-title">답장</div>
              <div className="cr-pitch-cell-hint">내 차례·상대 차례</div>
            </div>
            <div className="cr-pitch-cell">
              <div className="cr-pitch-cell-title">라벨</div>
              <div className="cr-pitch-cell-hint">규칙·순서·병합</div>
            </div>
            <div className="cr-pitch-cell">
              <div className="cr-pitch-cell-title">주소록</div>
              <div className="cr-pitch-cell-hint">개인·디렉터리</div>
            </div>
          </div>
          <div className="blueprint">
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            <button
              className="btn btn-primary btn-block cr-pitch-connect"
              onClick={connectGmail}
              disabled={gmailLoading}
            >
              {gmailLoading ? "연결 중…" : "Google 계정으로 연결"}
            </button>
          </div>
          <p className="cr-pitch-foot">메일 데이터는 이 브라우저(chrome.storage)에만 캐시됩니다.</p>
          {error && <p className="cr-pitch-error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <Shell account={gmailAccount} onDisconnect={disconnectGmail} initialFilter={initialFilterFromUrl()} />
  );
}
