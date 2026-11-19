import Anthropic from "@anthropic-ai/sdk";

// One saved key per service; the selected one is used for summaries. Keys live
// in chrome.storage.local (this browser profile only, not encrypted).
export type ProviderId = "anthropic" | "openai" | "gemini" | "custom";

export interface ProviderConfig {
  apiKey: string;
  model: string;
  // Only for "custom": an OpenAI-compatible base URL (OpenRouter, Groq,
  // DeepSeek, a local server, ...), e.g. https://api.groq.com/openai/v1
  baseUrl?: string;
}

export interface AiConfig {
  active: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  // Suggestions only - model names change often, so the field is free text
  // and "연결 테스트" is the real check.
  models: string[];
  keyHint: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    keyHint: "sk-ant-…  (console.anthropic.com)",
  },
  {
    id: "openai",
    label: "ChatGPT",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    keyHint: "sk-…  (platform.openai.com)",
  },
  {
    id: "gemini",
    label: "Gemini",
    models: ["gemini-3.8-flash"],
    keyHint: "AIza…  (aistudio.google.com)",
  },
  {
    id: "custom",
    label: "직접 지정",
    models: [],
    keyHint: "OpenAI 호환 서비스의 키",
  },
];

export const DEFAULT_AI_CONFIG: AiConfig = {
  active: "anthropic",
  providers: {
    anthropic: { apiKey: "", model: "claude-opus-5-5" },
    openai: { apiKey: "", model: "gpt-4o-mini" },
    gemini: { apiKey: "", model: "gemini-3.8-flash" },
    custom: { apiKey: "", model: "", baseUrl: "" },
  },
};

const AI_KEY = "correo_ai_config";

// Names these services have retired (404 "no longer available"); a config that
// still holds one gets the current default instead of failing every request.
const RETIRED_MODELS: Partial<Record<ProviderId, string[]>> = {
  gemini: ["gemini-2.0-flash", "gemini-2.0", "gemini-1.5-flash", "gemini-1.5-pro"],
};

export async function loadAiConfig(): Promise<AiConfig> {
  const s = await chrome.storage.local.get(AI_KEY);
  const saved = s[AI_KEY] as Partial<AiConfig> | undefined;
  return {
    active: saved?.active ?? DEFAULT_AI_CONFIG.active,
    providers: {
      anthropic: { ...DEFAULT_AI_CONFIG.providers.anthropic, ...saved?.providers?.anthropic },
      openai: { ...DEFAULT_AI_CONFIG.providers.openai, ...saved?.providers?.openai },
      gemini: withoutRetiredModel("gemini", { ...DEFAULT_AI_CONFIG.providers.gemini, ...saved?.providers?.gemini }),
      custom: { ...DEFAULT_AI_CONFIG.providers.custom, ...saved?.providers?.custom },
    },
  };
}

function withoutRetiredModel(id: ProviderId, cfg: ProviderConfig): ProviderConfig {
  return RETIRED_MODELS[id]?.includes(cfg.model) ? { ...cfg, model: DEFAULT_AI_CONFIG.providers[id].model } : cfg;
}

export async function saveAiConfig(cfg: AiConfig): Promise<void> {
  await chrome.storage.local.set({ [AI_KEY]: cfg });
}

export function activeProvider(cfg: AiConfig): ProviderConfig {
  return cfg.providers[cfg.active];
}

export function providerLabel(id: ProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

// A rejected key: no point retrying the remaining mails with it.
export class LlmAuthError extends Error {}

function trimSlash(s: string): string {
  return s.trim().replace(/\/+$/, "");
}

// Hosts other than the three built-in ones need the user's permission
// (optional_host_permissions). Must run from a click handler.
export async function ensureCustomHostAccess(baseUrl: string): Promise<boolean> {
  let origin: string;
  try {
    origin = `${new URL(trimSlash(baseUrl)).origin}/*`;
  } catch {
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isKeyRejected(status: number, body: string): boolean {
  return status === 401 || status === 403 || (status === 400 && /API[_ ]KEY[_ ]INVALID|api key not valid/i.test(body));
}

export interface CallOptions {
  // Retries after a 429 / 5xx. The connection test uses 0 so it answers at once.
  retries?: number;
  timeoutMs?: number;
}

// Gemini puts the wait it wants in the error body: "retryDelay": "21s".
function retryDelaySeconds(body: string): number {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Number(m[1]) : 0;
}

// A 429 that waiting won't fix (daily/free quota used up or a model the plan
// can't use) is reported immediately instead of being retried for ~15 seconds.
function quotaExplanation(body: string): string | null {
  const hopeless = /limit:\s*0|PerDay|per day|billing/i.test(body) || retryDelaySeconds(body) > 20;
  if (!hopeless) return null;
  return (
    "한도 초과(429): 이 키의 사용량(무료 한도)을 다 썼거나, 이 모델은 현재 요금제로 쓸 수 없습니다. " +
    "기다려도 해결되지 않아 바로 알려 드립니다. 다른 모델(모델 목록의 flash/mini 계열)을 고르거나 나중에 다시 시도하세요. " +
    "서비스 응답: " +
    body.replace(/\s+/g, " ").slice(0, 200)
  );
}

// POST JSON with retries on 429 / 5xx and a request timeout.
async function postJson(url: string, headers: Record<string, string>, body: unknown, opts: CallOptions = {}): Promise<unknown> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error(`응답이 ${Math.round(timeoutMs / 1000)}초 넘게 없어 중단했습니다.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (resp.ok) return resp.json();
    const text = await resp.text();
    if (isKeyRejected(resp.status, text)) throw new LlmAuthError(`키가 거부되었습니다 (${resp.status}): ${text.slice(0, 200)}`);
    if (resp.status === 429) {
      const why = quotaExplanation(text);
      if (why) throw new Error(why);
    }
    const retryable = resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt >= retries) throw new Error(`요청 실패 (${resp.status}): ${text.slice(0, 300)}`);
    const hint = Number(resp.headers.get("retry-after")) || retryDelaySeconds(text);
    await sleep(hint > 0 ? Math.min(hint * 1000, 20_000) : delay);
    delay *= 2;
  }
}

async function callAnthropic(cfg: ProviderConfig, system: string, user: string, opts: CallOptions): Promise<string> {
  const client = new Anthropic({
    apiKey: cfg.apiKey.trim(),
    dangerouslyAllowBrowser: true,
    maxRetries: opts.retries ?? 4,
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  // `effort` is only accepted by the current model generation; sending it to
  // an older model id would be a 400.
  const supportsEffort = /^claude-(opus|sonnet|haiku|fable)-5/.test(cfg.model);
  try {
    const resp = await client.messages.create({
      model: cfg.model.trim(),
      // Leaves room for the model's own reasoning before the 1-3 line answer.
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
      ...(supportsEffort ? { output_config: { effort: "low" as const } } : {}),
    });
    if (resp.stop_reason === "refusal") throw new Error("모델이 이 메일의 요약을 거부했습니다.");
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new LlmAuthError(`키가 거부되었습니다: ${e.message}`);
    }
    throw e;
  }
}

async function callOpenAiCompatible(base: string, cfg: ProviderConfig, system: string, user: string, opts: CallOptions): Promise<string> {
  const data = (await postJson(
    `${trimSlash(base)}/chat/completions`,
    { Authorization: `Bearer ${cfg.apiKey.trim()}` },
    {
      model: cfg.model.trim(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    opts,
  )) as { choices?: { message?: { content?: string | null } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini(cfg: ProviderConfig, system: string, user: string, opts: CallOptions): Promise<string> {
  const data = (await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model.trim())}:generateContent`,
    { "x-goog-api-key": cfg.apiKey.trim() },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    },
    opts,
  )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
}

export async function callLlm(id: ProviderId, cfg: ProviderConfig, system: string, user: string, opts: CallOptions = {}): Promise<string> {
  if (!cfg.apiKey.trim()) throw new LlmAuthError("API 키가 없습니다.");
  if (!cfg.model.trim()) throw new Error("모델 이름이 없습니다.");
  switch (id) {
    case "anthropic":
      return callAnthropic(cfg, system, user, opts);
    case "openai":
      return callOpenAiCompatible("https://api.openai.com/v1", cfg, system, user, opts);
    case "gemini":
      return callGemini(cfg, system, user, opts);
    case "custom":
      if (!cfg.baseUrl?.trim()) throw new Error("서비스 주소(Base URL)가 없습니다.");
      return callOpenAiCompatible(cfg.baseUrl, cfg, system, user, opts);
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const resp = await fetch(url, { headers });
  if (resp.ok) return resp.json();
  const text = await resp.text();
  if (isKeyRejected(resp.status, text)) throw new LlmAuthError(`키가 거부되었습니다 (${resp.status}): ${text.slice(0, 200)}`);
  throw new Error(`요청 실패 (${resp.status}): ${text.slice(0, 300)}`);
}

// Not text-generation models (the list endpoints return everything).
const NOT_TEXT_MODEL = /embed|tts|whisper|dall|image|audio|realtime|transcribe|moderation|speech|imagen|veo|aqa|robotics/i;

function newestFirst(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// The models this key can actually use right now, asked of the service itself,
// so the list never goes stale the way a hard-coded one does.
export async function listModels(id: ProviderId, cfg: ProviderConfig): Promise<string[]> {
  const key = cfg.apiKey.trim();
  if (!key) throw new LlmAuthError("API 키가 없습니다.");
  switch (id) {
    case "anthropic": {
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
      const out: string[] = [];
      try {
        for await (const m of client.models.list()) out.push(m.id);
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
          throw new LlmAuthError(`키가 거부되었습니다: ${e.message}`);
        }
        throw e;
      }
      return newestFirst(out);
    }
    case "openai": {
      const data = (await getJson("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` })) as { data?: { id: string }[] };
      return newestFirst((data.data ?? []).map((m) => m.id).filter((i) => !NOT_TEXT_MODEL.test(i)));
    }
    case "gemini": {
      const data = (await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
        "x-goog-api-key": key,
      })) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return newestFirst(
        (data.models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""))
          .filter((i) => !NOT_TEXT_MODEL.test(i)),
      );
    }
    case "custom": {
      if (!cfg.baseUrl?.trim()) throw new Error("서비스 주소(Base URL)가 없습니다.");
      const data = (await getJson(`${trimSlash(cfg.baseUrl)}/models`, { Authorization: `Bearer ${key}` })) as { data?: { id: string }[] };
      return newestFirst((data.data ?? []).map((m) => m.id));
    }
  }
}

// A sensible cheap-and-fast pick from a live list (null = no opinion).
export function suggestModel(id: ProviderId, models: string[]): string | null {
  const unstable = /lite|exp|preview|thinking|8b/i;
  switch (id) {
    case "gemini":
      return models.find((m) => /flash/i.test(m) && !unstable.test(m)) ?? models.find((m) => /flash/i.test(m)) ?? models[0] ?? null;
    case "openai":
      return models.find((m) => /^gpt/i.test(m) && /mini/i.test(m) && !/preview|\d{4}-\d{2}-\d{2}/.test(m)) ?? null;
    case "anthropic":
      return models.find((m) => /haiku/i.test(m)) ?? models[0] ?? null;
    default:
      return null;
  }
}
