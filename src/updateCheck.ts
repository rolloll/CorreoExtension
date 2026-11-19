// Checks GitHub Releases for a newer published version than the one
// currently installed, so existing users (installed as an unpacked/sideloaded
// extension, not through the Chrome Web Store, which handles this itself)
// get notified and can jump straight to the release page.
//
// The repo must be public: the unauthenticated GitHub API can't see releases
// of a private repo.
export const GITHUB_REPO = "rolloll/CorreoExtension";

// One line for PowerShell: downloads the latest release straight into
// C:\Program Files (x86)\Correo (asks for admin itself), so no zip lands in
// Downloads. Pinned to the exact tag when known: right after a release the
// "latest" redirect can still point at the previous one for a few minutes.
export function installCommand(version?: string): string {
  const where = version ? `download/v${version.replace(/^v/i, "")}` : "latest/download";
  return `irm https://github.com/${GITHUB_REPO}/releases/${where}/install.ps1 | iex`;
}

export const UPDATE_INFO_KEY = "correo_update_info";
const DISMISSED_KEY = "correo_update_dismissed";
const NOTIFICATION_ID = "correo-update";

export interface UpdateInfo {
  available: boolean;
  latestVersion: string;
  url: string;
  checkedAt: number;
  // Last version we raised a system notification for, so the 12h poll doesn't
  // re-notify about the same release over and over.
  notifiedVersion?: string;
}

export type CheckResult =
  | { ok: true; info: UpdateInfo }
  | { ok: false; error: string };

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

// Plain numeric-tuple comparison rather than a full semver library — every
// version in this project's history has been a simple x.y.z, and a GitHub
// release tag is expected to follow the same shape (with an optional "v"
// prefix, which parseVersion strips).
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function loadUpdateInfo(): Promise<UpdateInfo | null> {
  const stored = await chrome.storage.local.get(UPDATE_INFO_KEY);
  return (stored[UPDATE_INFO_KEY] as UpdateInfo | undefined) ?? null;
}

// "나중에" on the in-app prompt hides it for that version only; a newer
// release prompts again.
export async function loadDismissedVersion(): Promise<string | null> {
  const stored = await chrome.storage.local.get(DISMISSED_KEY);
  return (stored[DISMISSED_KEY] as string | undefined) ?? null;
}

export async function dismissUpdate(version: string): Promise<void> {
  await chrome.storage.local.set({ [DISMISSED_KEY]: version });
}

async function notifyUpdate(info: UpdateInfo): Promise<void> {
  chrome.notifications.create(NOTIFICATION_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Correo 새 버전이 나왔어요",
    message: `v${info.latestVersion} (현재 ${chrome.runtime.getManifest().version}) — 클릭하면 릴리스 페이지로 이동합니다.`,
    requireInteraction: true,
  });
}

// `notify` is false for the manual "check now" button, where the user is
// already looking at the result and a system popup would be redundant.
export async function checkForUpdate(notify = true): Promise<CheckResult> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (resp.status === 404) return { ok: false, error: "아직 게시된 릴리스가 없습니다." };
    if (!resp.ok) return { ok: false, error: `GitHub 응답 오류 (${resp.status})` };
    const data = (await resp.json()) as { tag_name?: string; html_url?: string };
    const latestVersion = (data.tag_name || "").replace(/^v/i, "");
    if (!latestVersion) return { ok: false, error: "릴리스 버전을 읽을 수 없습니다." };

    const previous = await loadUpdateInfo();
    const info: UpdateInfo = {
      available: isNewerVersion(latestVersion, chrome.runtime.getManifest().version),
      latestVersion,
      url: data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
      checkedAt: Date.now(),
      notifiedVersion: previous?.notifiedVersion,
    };
    if (info.available && notify && info.notifiedVersion !== latestVersion) {
      await notifyUpdate(info);
      info.notifiedVersion = latestVersion;
    }
    await chrome.storage.local.set({ [UPDATE_INFO_KEY]: info });
    return { ok: true, info };
  } catch (e) {
    // Offline or rate-limited — not critical-path, so report rather than throw.
    return { ok: false, error: `확인 실패: ${e}` };
  }
}

// Must be registered at the service worker's top level so a click on a
// notification that outlived the worker still wakes it and opens the page.
export function registerUpdateNotificationClick(): void {
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== NOTIFICATION_ID) return;
    void loadUpdateInfo().then((info) => {
      void chrome.tabs.create({ url: info?.url ?? `https://github.com/${GITHUB_REPO}/releases/latest` });
      chrome.notifications.clear(id);
    });
  });
}

// ---- One-click update through the local helper (installed by install.ps1) ----
// Chrome only lets an extension talk to a program the user registered for it
// (native messaging). The helper can do exactly one thing: fetch the latest
// release of this repo and mirror it into this extension's own folder.
const HELPER_NAME = "com.correo.updater";

export interface HelperResult {
  ok: boolean;
  version?: string;
  error?: string;
}

function callHelper(message: { type: "ping" | "update" }): Promise<HelperResult & { installedVersion?: string }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HELPER_NAME, message, (response: HelperResult | undefined) => {
        const err = chrome.runtime.lastError; // must be read, or Chrome logs it
        if (err) resolve({ ok: false, error: err.message });
        else resolve(response ?? { ok: false, error: "도우미가 응답하지 않았습니다." });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

// True when the helper is registered for this browser profile.
export async function helperAvailable(): Promise<boolean> {
  return (await callHelper({ type: "ping" })).ok;
}

// Downloads the latest release into the install folder. On success the caller
// should chrome.runtime.reload() so the new files take effect.
export function updateViaHelper(): Promise<HelperResult> {
  return callHelper({ type: "update" });
}
