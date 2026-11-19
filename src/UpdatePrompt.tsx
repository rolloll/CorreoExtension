import { useEffect, useState } from "react";
import { INSTALL_COMMAND, UPDATE_INFO_KEY, dismissUpdate, loadDismissedVersion, loadUpdateInfo, type UpdateInfo } from "./updateCheck";
import "./UpdatePrompt.css";

// In-app counterpart to the system notification (which the OS can suppress,
// e.g. Windows focus assist): shown whenever a newer GitHub release exists
// and the user hasn't dismissed that specific version.
export default function UpdatePrompt() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  if (!info?.available || dismissed === info.latestVersion) return null;
  const current = chrome.runtime.getManifest().version;

  return (
    <div className="up-root" role="alert">
      <div className="up-text">
        <strong>새 버전 v{info.latestVersion}이 나왔어요</strong>
        <span className="text-muted"> (현재 v{current})</span>
        {copied && (
          <div className="text-muted" style={{ fontSize: 12 }}>
            PowerShell에 붙여넣어 실행한 뒤, chrome://extensions에서 Correo의 새로고침 버튼을 누르세요.
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-primary"
        title="PowerShell에 붙여넣어 실행하면 C:\Program Files (x86)\Correo에 새 버전이 설치됩니다"
        onClick={() => {
          void navigator.clipboard.writeText(INSTALL_COMMAND).then(() => setCopied(true));
        }}
      >
        {copied ? "복사됨" : "업데이트 명령 복사"}
      </button>
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
