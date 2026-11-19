import { useEffect, useState } from "react";
import {
  installCommand,
  UPDATE_INFO_KEY,
  dismissUpdate,
  helperAvailable,
  loadDismissedVersion,
  loadUpdateInfo,
  updateViaHelper,
  type UpdateInfo,
} from "./updateCheck";
import "./UpdatePrompt.css";

type Phase = "idle" | "updating" | "done" | "error";

// In-app counterpart to the system notification (which the OS can suppress,
// e.g. Windows focus assist): shown whenever a newer GitHub release exists
// and the user hasn't dismissed that specific version. With the update helper
// installed it updates in one click; otherwise it hands over the install command.
export default function UpdatePrompt() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [helper, setHelper] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadUpdateInfo().then(setInfo).catch(() => {});
    loadDismissedVersion().then(setDismissed).catch(() => {});
    // The background worker re-checks every 12h; pick that up without a reload.
    function onChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
      if (area === "local" && changes[UPDATE_INFO_KEY]) setInfo((changes[UPDATE_INFO_KEY].newValue as UpdateInfo) ?? null);
    }
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Only ask the helper (it starts a process) once there is something to update.
  const available = !!info?.available;
  useEffect(() => {
    if (available) helperAvailable().then(setHelper).catch(() => setHelper(false));
  }, [available]);

  if (!info?.available || dismissed === info.latestVersion) return null;
  const current = chrome.runtime.getManifest().version;

  async function updateNow() {
    setPhase("updating");
    setError(null);
    const result = await updateViaHelper();
    if (!result.ok) {
      setPhase("error");
      setError(result.error ?? "알 수 없는 오류");
      return;
    }
    setPhase("done");
    // Give the message a moment to be read; the reload closes this page.
    setTimeout(() => chrome.runtime.reload(), 1500);
  }

  return (
    <div className="up-root" role="alert">
      <div className="up-text">
        <strong>새 버전 v{info.latestVersion}이 나왔어요</strong>
        <span className="text-muted"> (현재 v{current})</span>
        {phase === "updating" && <div className="text-muted" style={{ fontSize: 12 }}>업데이트 중… 몇 초 걸립니다.</div>}
        {phase === "done" && (
          <div className="text-muted" style={{ fontSize: 12 }}>
            ✓ 업데이트 완료. 확장을 다시 로드합니다. 끝나면 Gmail·Correo 탭을 새로고침하세요.
          </div>
        )}
        {phase === "error" && <div style={{ fontSize: 12, color: "#b3261e", wordBreak: "break-all" }}>업데이트 실패: {error}</div>}
        {helper === false && copied && (
          <div className="text-muted" style={{ fontSize: 12 }}>
            PowerShell에 붙여넣어 실행한 뒤, chrome://extensions에서 Correo의 새로고침 버튼을 누르세요. 이 설치는 처음 한 번만 하면, 다음부터는 이
            자리에 <b>지금 업데이트</b> 버튼이 나옵니다.
          </div>
        )}
      </div>
      {helper === true ? (
        <button type="button" className="btn btn-primary" disabled={phase === "updating" || phase === "done"} onClick={updateNow}>
          {phase === "updating" ? "업데이트 중…" : "지금 업데이트"}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          title="PowerShell에 붙여넣어 실행하면 C:\Program Files (x86)\Correo에 새 버전이 설치됩니다"
          onClick={() => {
            void navigator.clipboard.writeText(installCommand(info.latestVersion)).then(() => setCopied(true));
          }}
        >
          {copied ? "복사됨" : "업데이트 명령 복사"}
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          void chrome.tabs.create({ url: info.url });
        }}
      >
        릴리스 페이지
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          setDismissed(info.latestVersion);
          void dismissUpdate(info.latestVersion);
        }}
      >
        나중에
      </button>
    </div>
  );
}
