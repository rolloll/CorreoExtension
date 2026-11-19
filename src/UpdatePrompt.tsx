import { useEffect, useState } from "react";
import { UPDATE_INFO_KEY, dismissUpdate, loadDismissedVersion, loadUpdateInfo, type UpdateInfo } from "./updateCheck";
import "./UpdatePrompt.css";

// In-app counterpart to the system notification (which the OS can suppress,
// e.g. Windows focus assist): shown whenever a newer GitHub release exists
// and the user hasn't dismissed that specific version.
export default function UpdatePrompt() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

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
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          void chrome.tabs.create({ url: info.url });
        }}
      >
        릴리스 페이지 열기
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
