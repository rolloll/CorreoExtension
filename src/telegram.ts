import { listIncomingToAddresses, type IncomingMail } from "./gmail/api";

// Telegram alerts for new inbox mail addressed to chosen accounts. Runs in the
// background worker on the existing 1-minute alarm; only the subject (and
// sender) leave Gmail, never the body.
export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  addresses: string[];
  includeCc: boolean;
}

interface TelegramState {
  lastSec: number;
  notified: string[];
}

const CONFIG_KEY = "correo_telegram";
const STATE_KEY = "correo_telegram_state";
const NOTIFIED_CAP = 300;
const MAX_LOOKBACK_SEC = 24 * 3600;
const MAX_INDIVIDUAL = 10;

export const DEFAULT_TELEGRAM: TelegramConfig = {
  enabled: false,
  botToken: "",
  chatId: "",
  addresses: [],
  includeCc: false,
};

export async function loadTelegramConfig(): Promise<TelegramConfig> {
  const s = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_TELEGRAM, ...(s[CONFIG_KEY] as Partial<TelegramConfig> | undefined) };
}

export async function saveTelegramConfig(cfg: TelegramConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
  // A fresh start shouldn't replay mail that arrived while alerts were off.
  if (!cfg.enabled) await chrome.storage.local.remove(STATE_KEY);
}

export async function sendTelegram(cfg: Pick<TelegramConfig, "botToken" | "chatId">, text: string): Promise<void> {
  const resp = await fetch(`https://api.telegram.org/bot${cfg.botToken.trim()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId.trim(), text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  const data = (await resp.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!resp.ok || !data?.ok) throw new Error(data?.description || `텔레그램 오류 (${resp.status})`);
}

// Finds the chat that last messaged the bot (the user sends it any message
// first), so they don't have to dig the id out of the API by hand.
export async function findChatId(botToken: string): Promise<string | null> {
  const resp = await fetch(`https://api.telegram.org/bot${botToken.trim()}/getUpdates`);
  const data = (await resp.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    result?: { message?: { chat?: { id?: number } }; channel_post?: { chat?: { id?: number } } }[];
  } | null;
  if (!resp.ok || !data?.ok) throw new Error(data?.description || `텔레그램 오류 (${resp.status})`);
  for (const u of [...(data.result ?? [])].reverse()) {
    const id = u.message?.chat?.id ?? u.channel_post?.chat?.id;
    if (id !== undefined) return String(id);
  }
  return null;
}

function formatMail(m: IncomingMail): string {
  return `📧 ${m.subject.slice(0, 500)}\n보낸 사람: ${m.from.slice(0, 200)}\n받는 주소: ${m.matched}`;
}

let inFlight = false;

export async function checkTelegram(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const cfg = await loadTelegramConfig();
    if (!cfg.enabled || !cfg.botToken.trim() || !cfg.chatId.trim() || cfg.addresses.length === 0) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as TelegramState | undefined;
    if (!stored) {
      // First run: start from now instead of sending the existing backlog.
      await chrome.storage.local.set({ [STATE_KEY]: { lastSec: nowSec, notified: [] } satisfies TelegramState });
      return;
    }
    const afterSec = Math.max(stored.lastSec - 60, nowSec - MAX_LOOKBACK_SEC);
    const mails = await listIncomingToAddresses(cfg.addresses, afterSec, cfg.includeCc, new Set(stored.notified));

    const notified = [...stored.notified];
    let advanced = true;
    try {
      for (const m of mails.slice(0, MAX_INDIVIDUAL)) {
        await sendTelegram(cfg, formatMail(m));
        notified.push(m.id);
      }
      if (mails.length > MAX_INDIVIDUAL) {
        const rest = mails.slice(MAX_INDIVIDUAL);
        await sendTelegram(cfg, `📧 그 외 새 메일 ${rest.length}건\n` + rest.map((m) => `· ${m.subject.slice(0, 80)}`).join("\n"));
        for (const m of rest) notified.push(m.id);
      }
    } catch {
      // Keep lastSec where it was so unsent mail is retried on the next tick.
      advanced = false;
    }
    await chrome.storage.local.set({
      [STATE_KEY]: {
        lastSec: advanced ? nowSec : stored.lastSec,
        notified: notified.slice(-NOTIFIED_CAP),
      } satisfies TelegramState,
    });
  } catch {
    // Not signed in to Gmail yet or a transient network error: try again next minute.
  } finally {
    inFlight = false;
  }
}
