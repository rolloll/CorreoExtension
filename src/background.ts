import { findSentThreadIds, markThreadResolved, addLabelToThread, listLabels, getUnreadCount, syncActivity, loadActivityCache } from "./gmail/api";
import { addThreadAsTask } from "./gmail/tasks";
import { checkForUpdate, registerUpdateNotificationClick } from "./updateCheck";

const UNREAD_BADGE_ALARM = "correo-unread-badge";
const UPDATE_CHECK_ALARM = "correo-update-check";

async function refreshUnreadBadge(): Promise<void> {
  try {
    const count = await getUnreadCount();
    const text = count > 0 ? (count > 999 ? "999+" : String(count)) : "";
    await chrome.action.setBadgeText({ text });
  } catch {
    // Not signed in yet, or a transient network error — leave the badge as
    // it was rather than flashing it empty on every failed poll.
  }
}

chrome.action.setBadgeBackgroundColor({ color: "#5980a6" });
chrome.alarms.create(UNREAD_BADGE_ALARM, { periodInMinutes: 1 });
// Checked far less often than the unread badge — this is just "is there a
// newer GitHub release", not something that needs near-real-time polling.
chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: 720 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UNREAD_BADGE_ALARM) void refreshUnreadBadge();
  if (alarm.name === UPDATE_CHECK_ALARM) void checkForUpdate();
});
void refreshUnreadBadge();
void checkForUpdate();
registerUpdateNotificationClick();
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update") void checkForUpdate();
});

// The toolbar icon now opens a popup (see popup.html/popup.js) offering a
// choice between this and the Gmail side panel, so chrome.action.onClicked
// no longer fires — this is invoked via the "openAsTab" message instead.
async function openCorreoTab(): Promise<void> {
  const url = chrome.runtime.getURL("index.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0 && tabs[0].id !== undefined) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId !== undefined) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
}

interface ResolveThreadMessage {
  type: "resolveThread";
  threadId: string;
}

function isResolveThreadMessage(message: unknown): message is ResolveThreadMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "resolveThread" &&
    typeof (message as { threadId?: unknown }).threadId === "string"
  );
}

interface ApplyLabelMessage {
  type: "applyLabelToThread";
  threadId: string;
  labelId: string;
}

function isApplyLabelMessage(message: unknown): message is ApplyLabelMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "applyLabelToThread" &&
    typeof (message as { threadId?: unknown }).threadId === "string" &&
    typeof (message as { labelId?: unknown }).labelId === "string"
  );
}

interface ListLabelsMessage {
  type: "listLabels";
}

function isListLabelsMessage(message: unknown): message is ListLabelsMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "listLabels"
  );
}

interface AddTaskMessage {
  type: "addTaskFromThread";
  threadId: string;
  title: string;
}

function isAddTaskMessage(message: unknown): message is AddTaskMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "addTaskFromThread" &&
    typeof (message as { threadId?: unknown }).threadId === "string" &&
    typeof (message as { title?: unknown }).title === "string"
  );
}

interface OpenAsTabMessage {
  type: "openAsTab";
}

function isOpenAsTabMessage(message: unknown): message is OpenAsTabMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "openAsTab"
  );
}

interface SyncNowMessage {
  type: "syncNow";
  days?: number;
  // Background-initiated by a Gmail tab (not a user click): skipped if a sync
  // was attempted very recently, so failing syncs don't get hammered.
  auto?: boolean;
}

function isSyncNowMessage(message: unknown): message is SyncNowMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "syncNow"
  );
}

// Several Gmail tabs / Correo panels can ask at once; share one in-flight
// sync between them (concurrent syncs would double the quota use).
let syncInFlight: Promise<void> | null = null;
let lastAttemptMs = 0;
const AUTO_RETRY_GAP_MS = 3 * 60_000;

function syncNow(days?: number, auto = false): Promise<void> {
  if (syncInFlight) return syncInFlight;
  if (auto && Date.now() - lastAttemptMs < AUTO_RETRY_GAP_MS) return Promise.resolve();
  lastAttemptMs = Date.now();
  syncInFlight = (async () => {
    const cached = await loadActivityCache();
    await syncActivity(days ?? cached?.days ?? 90);
    void refreshUnreadBadge();
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isOpenAsTabMessage(message)) {
    openCorreoTab().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (isSyncNowMessage(message)) {
    syncNow(message.days, message.auto)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (isResolveThreadMessage(message)) {
    markThreadResolved(message.threadId)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (isApplyLabelMessage(message)) {
    addLabelToThread(message.threadId, message.labelId)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (isListLabelsMessage(message)) {
    listLabels()
      .then((labels) => sendResponse({ ok: true, labels }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (isAddTaskMessage(message)) {
    addThreadAsTask(message.threadId, message.title)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if ((message as { type?: unknown })?.type === "resolveTrackedThreads") {
    const items = (message as { items?: { id: string; subject: string; sentMs: number; scheduled?: boolean }[] }).items ?? [];
    findSentThreadIds(items)
      .then((map) => sendResponse({ ok: true, map }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
