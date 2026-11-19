// Backup / restore of the user's settings as one JSON file, for when Chrome
// wipes extension storage (removing and re-adding the extension, e.g. after
// loading a new folder). Only configuration is included, never the caches.
const BACKUP_KEYS = [
  "correo_tracker", // read-tracking server address + token
  "correo_tracked", // pixels minted for sent mail (links opens to mails)
  "correo_telegram", // bot token, chat id, watched addresses
  "correo_ai_config", // AI service keys and models
  "correo_groups", // 노블/웹툰 grouping keywords
  "correo_aliases", // my addresses
  "correo_prefs", // 답장 screen filters
  "correo_panel_width",
];

const FORMAT = "correo-settings-v1";

interface BackupFile {
  format: string;
  exportedAt: string;
  version: string;
  data: Record<string, unknown>;
}

export async function exportSettings(): Promise<number> {
  const stored = await chrome.storage.local.get(BACKUP_KEYS);
  const file: BackupFile = {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    data: stored,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const day = new Date().toISOString().slice(0, 10);
  void chrome.downloads.download({ url, filename: `correo-settings-${day}.json`, saveAs: true }).finally(() => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  return Object.keys(stored).length;
}

// Returns how many settings were restored; throws a readable error for a file
// that isn't a Correo backup. Unknown keys in the file are ignored.
export async function importSettings(text: string): Promise<number> {
  let parsed: Partial<BackupFile>;
  try {
    parsed = JSON.parse(text) as Partial<BackupFile>;
  } catch {
    throw new Error("JSON 파일이 아닙니다.");
  }
  if (parsed.format !== FORMAT || typeof parsed.data !== "object" || parsed.data === null) {
    throw new Error("Correo 설정 백업 파일이 아닙니다.");
  }
  const toSet: Record<string, unknown> = {};
  for (const key of BACKUP_KEYS) if (key in parsed.data) toSet[key] = (parsed.data as Record<string, unknown>)[key];
  await chrome.storage.local.set(toSet);
  return Object.keys(toSet).length;
}
