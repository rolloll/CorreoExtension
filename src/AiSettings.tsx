import { useEffect, useState } from "react";
import {
  DEFAULT_AI_CONFIG,
  PROVIDERS,
  callLlm,
  ensureCustomHostAccess,
  loadAiConfig,
  saveAiConfig,
  type AiConfig,
  type ProviderConfig,
  type ProviderId,
} from "./aiProviders";

// Settings block: one saved key per AI service, the selected one summarizes
// mail in the date-range export.
export default function AiSettings() {
  const [cfg, setCfg] = useState<AiConfig>(DEFAULT_AI_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    loadAiConfig().then((c) => {
      setCfg(c);
      setLoaded(true);
    });
  }, []);

  const info = PROVIDERS.find((p) => p.id === cfg.active) ?? PROVIDERS[0];
  const current = cfg.providers[cfg.active];

  function update(next: AiConfig) {
    setCfg(next);
    setTestMsg(null);
    if (loaded) void saveAiConfig(next);
  }

  function updateCurrent(patch: Partial<ProviderConfig>) {
    update({ ...cfg, providers: { ...cfg.providers, [cfg.active]: { ...current, ...patch } } });
  }

  async function test() {
    setTesting(true);
    setTestMsg("확인 중…");
    try {
      if (cfg.active === "custom" && !(await ensureCustomHostAccess(current.baseUrl ?? ""))) {
        setTestMsg("이 서비스 주소에 접근할 권한이 필요합니다. 허용해 주세요.");
        return;
      }
      const reply = await callLlm(cfg.active, current, "한 단어로만 답하세요.", "OK 라고 답하세요.");
      setTestMsg(reply.trim() ? "연결됐습니다." : "연결은 됐지만 응답이 비어 있습니다. 모델 이름을 확인하세요.");
    } catch (e) {
      setTestMsg(`실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="st-block">
      <div className="st-block-title">AI 요약 (기간 탭 추출)</div>
      <div className="st-toggle-hint">
        기간 탭에서 메일 목록을 추출할 때 각 메일을 1~3줄로 요약합니다. 서비스별 키를 저장해 두고 아래에서 사용할 서비스를 고르세요.
        요약할 때 메일 제목·보낸 사람·본문이 선택한 서비스로 전송되며 이용료가 발생할 수 있습니다. 키는 이 브라우저에만 저장됩니다(암호화되지 않음).
      </div>
      <div className="seg" style={{ margin: "8px 0" }}>
        {PROVIDERS.map((p) => (
          <label key={p.id} className="seg-opt">
            <input
              type="radio"
              name="st-ai-provider"
              checked={cfg.active === p.id}
              onChange={() => update({ ...cfg, active: p.id as ProviderId })}
            />
            {p.label}
            {cfg.providers[p.id].apiKey && " ✓"}
          </label>
        ))}
      </div>
      <input
        className="input"
        style={{ width: "100%", marginBottom: 6 }}
        type="password"
        placeholder={`${info.label} API 키 — ${info.keyHint}`}
        value={current.apiKey}
        onChange={(e) => updateCurrent({ apiKey: e.target.value })}
      />
      {cfg.active === "custom" && (
        <input
          className="input"
          style={{ width: "100%", marginBottom: 6 }}
          placeholder="서비스 주소 (예: https://api.groq.com/openai/v1)"
          value={current.baseUrl ?? ""}
          onChange={(e) => updateCurrent({ baseUrl: e.target.value })}
        />
      )}
      <input
        className="input"
        style={{ width: "100%", marginBottom: 6 }}
        list="st-ai-models"
        placeholder="모델 이름"
        value={current.model}
        onChange={(e) => updateCurrent({ model: e.target.value })}
      />
      <datalist id="st-ai-models">
        {info.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <div className="st-toggle-hint" style={{ marginBottom: 6 }}>
        모델 이름은 서비스에서 바뀔 수 있어 직접 고칠 수 있습니다. 메일이 많으면 가벼운 모델(예: claude-haiku-5-5, gpt-4o-mini, gemini-2.0-flash)이 저렴합니다.
      </div>
      <button className="btn btn-secondary" disabled={!current.apiKey || !current.model || testing} onClick={test}>
        연결 테스트
      </button>
      {testMsg && (
        <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {testMsg}
        </span>
      )}
    </div>
  );
}
