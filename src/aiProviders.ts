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
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"],
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
    gemini: { apiKey: "", model: "gemini-2.0-flash" },
    custom: { apiKey: "", model: "", baseUrl: "" },
  },
};

const AI_KEY = "correo_ai_config";

export async function loadAiConfig(): Promise<AiConfig> {
  const s = await chrome.storage.local.get(AI_KEY);
  const saved = s[AI_KEY] as Partial<AiConfig> | undefined;
  return {
    active: saved?.active ?? DEFAULT_AI_CONFIG.active,
    providers: {
      anthropic: { ...DEFAULT_AI_CONFIG.providers.anthropic, ...saved?.providers?.anthropic },
      openai: { ...DEFAULT_AI_CONFIG.providers.openai, ...saved?.providers?.openai },
      gemini: { ...DEFAULT_AI_CONFIG.providers.gemini, ...saved?.providers?.gemini },
      custom: { ...DEFAULT_AI_CONFIG.providers.custom, ...saved?.providers?.custom },
    },
  };
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

// POST JSON with a few retries on 429 / 5xx (honouring Retry-After).
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp.json();
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) throw new LlmAuthError(`키가 거부되었습니다 (${resp.status}): ${text.slice(0, 200)}`);
    const retryable = resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt >= 3) throw new Error(`요청 실패 (${resp.status}): ${text.slice(0, 300)}`);
    const retryAfter = Number(resp.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : delay);
    delay *= 2;
  }
}

async function callAnthropic(cfg: ProviderConfig, system: string, user: string): Promise<string> {
  const client = new Anthropic({ apiKey: cfg.apiKey.trim(), dangerouslyAllowBrowser: true, maxRetries: 4 });
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

async function callOpenAiCompatible(base: string, cfg: ProviderConfig, system: string, user: string): Promise<string> {
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
  )) as { choices?: { message?: { content?: string | null } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini(cfg: ProviderConfig, system: string, user: string): Promise<string> {
  const data = (await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model.trim())}:generateContent`,
    { "x-goog-api-key": cfg.apiKey.trim() },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    },
  )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
}

export async function callLlm(id: ProviderId, cfg: ProviderConfig, system: string, user: string): Promise<string> {
  if (!cfg.apiKey.trim()) throw new LlmAuthError("API 키가 없습니다.");
  if (!cfg.model.trim()) throw new Error("모델 이름이 없습니다.");
  switch (id) {
    case "anthropic":
      return callAnthropic(cfg, system, user);
    case "openai":
      return callOpenAiCompatible("https://api.openai.com/v1", cfg, system, user);
    case "gemini":
      return callGemini(cfg, system, user);
    case "custom":
      if (!cfg.baseUrl?.trim()) throw new Error("서비스 주소(Base URL)가 없습니다.");
      return callOpenAiCompatible(cfg.baseUrl, cfg, system, user);
  }
}
