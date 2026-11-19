import { useEffect, useState } from "react";
import {
  DEFAULT_AI_CONFIG,
  PROVIDERS,
  callLlm,
  ensureCustomHostAccess,
  listModels,
  loadAiConfig,
  saveAiConfig,
  suggestModel,
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
  // Models the service itself reports for this key, per service (never stale).
  const [liveModels, setLiveModels] = useState<Partial<Record<ProviderId, string[]>>>({});
  const [modelsMsg, setModelsMsg] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

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

  async function loadModels(): Promise<void> {
    setLoadingModels(true);
    setModelsMsg("불러오는 중…");
    try {
      if (cfg.active === "custom" && !(await ensureCustomHostAccess(current.baseUrl ?? ""))) {
        setModelsMsg("이 서비스 주소에 접근할 권한이 필요합니다. 허용해 주세요.");
        return;
      }
      const models = await listModels(cfg.active, current);
      setLiveModels((m) => ({ ...m, [cfg.active]: models }));
      if (models.length === 0) {
        setModelsMsg("사용할 수 있는 모델이 없다고 나옵니다. 키의 권한을 확인하세요.");
      } else if (current.model && !models.includes(current.model)) {
        const pick = suggestModel(cfg.active, models);
        if (pick) {
          updateCurrent({ model: pick });
          setModelsMsg(`'${current.model}'은 지금 쓸 수 없어 '${pick}'로 바꿨습니다. (모델 ${models.length}개 중 선택 가능)`);
        } else {
          setModelsMsg(`'${current.model}'은 지금 쓸 수 없습니다. 모델 ${models.length}개 중에서 입력칸을 눌러 고르세요.`);
        }
      } else {
        setModelsMsg(`모델 ${models.length}개를 불러왔습니다. 입력칸을 눌러 고를 수 있습니다.`);
      }
    } catch (e) {
      setModelsMsg(`실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoadingModels(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestMsg("확인 중…");
    const started = Date.now();
    const took = () => `${((Date.now() - started) / 1000).toFixed(1)}초`;
    try {
      if (cfg.active === "custom" && !(await ensureCustomHostAccess(current.baseUrl ?? ""))) {
        setTestMsg("이 서비스 주소에 접근할 권한이 필요합니다. 허용해 주세요.");
        return;
      }
      // No retries: a test should answer at once, not wait out a rate limit.
      const reply = await callLlm(cfg.active, current, "한 단어로만 답하세요.", "OK 라고 답하세요.", { retries: 0, timeoutMs: 30_000 });
      setTestMsg(
        reply.trim() ? `연결됐습니다. (${took()})` : `연결은 됐지만 응답이 비어 있습니다. 모델 이름을 확인하세요. (${took()})`,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/\(404\)|not found|no longer available|not supported/i.test(message)) {
        setTestMsg("이 모델 이름은 지금 쓸 수 없습니다. 쓸 수 있는 모델을 서비스에서 불러옵니다…");
        await loadModels();
        setTestMsg("모델을 바꿨다면 '연결 테스트'를 다시 눌러 확인하세요.");
      } else {
        setTestMsg(`실패 (${took()}): ${message}`);
      }
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
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          list="st-ai-models"
          placeholder="모델 이름"
          value={current.model}
          onChange={(e) => updateCurrent({ model: e.target.value })}
        />
        <button className="btn btn-secondary" disabled={!current.apiKey.trim() || loadingModels} onClick={loadModels}>
          {loadingModels ? "불러오는 중…" : "모델 목록 불러오기"}
        </button>
      </div>
      <datalist id="st-ai-models">
        {(liveModels[cfg.active] ?? info.models).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {modelsMsg && (
        <div className="text-muted" style={{ fontSize: 12, marginBottom: 6 }}>
          {modelsMsg}
        </div>
      )}
      <div className="st-toggle-hint" style={{ marginBottom: 6 }}>
        모델 이름은 서비스에서 자주 바뀌고 종료되기도 합니다. <b>모델 목록 불러오기</b>를 누르면 이 키로 지금 쓸 수 있는 모델을 서비스에서 직접
        받아 오고, 입력칸을 눌러 고를 수 있습니다. 메일이 많으면 가볍고 빠른 모델(이름에 flash, mini, haiku가 들어간 것)이 저렴합니다.
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
