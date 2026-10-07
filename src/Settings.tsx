import { useEffect, useState } from "react";
import { loadAddressInfo, setUpCcOnlySeparation, type AddressInfo } from "./gmail/api";
import { isValidAddress, loadAliasConfig, normalizeAddress, saveAliasConfig, type AliasConfig } from "./aliases";
import { checkForUpdate, loadUpdateInfo, type UpdateInfo } from "./updateCheck";
import { loadTrackerConfig, saveTrackerConfig, type TrackerConfig } from "./tracking";
import type { GmailAccount } from "./App";
import "./Settings.css";

const PERIODS: { d: number; label: string }[] = [
  { d: 7, label: "7일" },
  { d: 30, label: "30일" },
  { d: 90, label: "90일" },
  { d: 180, label: "180일" },
  { d: 365, label: "1년" },
];

function openEmlViewer() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("index.html?view=eml") });
}

export default function Settings({
  account,
  onDisconnect,
  days,
  setDays,
  hideCc,
  setHideCc,
  hideGen,
  setHideGen,
}: {
  account: GmailAccount;
  onDisconnect: () => void;
  days: number;
  setDays: (d: number) => void;
  hideCc: boolean;
  setHideCc: (v: boolean) => void;
  hideGen: boolean;
  setHideGen: (v: boolean) => void;
}) {
  const [ccSplit, setCcSplit] = useState(false);
  const [ccSplitBusy, setCcSplitBusy] = useState(false);
  const [ccSplitMsg, setCcSplitMsg] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const version = chrome.runtime.getManifest().version;
  const [addrInfo, setAddrInfo] = useState<AddressInfo | null>(null);
  const [addrErr, setAddrErr] = useState<string | null>(null);
  const [aliasCfg, setAliasCfg] = useState<AliasConfig>({ extra: [], excluded: [] });
  const [newAlias, setNewAlias] = useState("");
  const [aliasMsg, setAliasMsg] = useState<string | null>(null);

  useEffect(() => {
    loadAliasConfig().then(setAliasCfg);
    loadAddressInfo().then(setAddrInfo).catch((e) => setAddrErr(String(e)));
  }, []);

  function updateAlias(next: AliasConfig) {
    setAliasCfg(next);
    void saveAliasConfig(next);
  }

  function toggleDetected(addr: string, include: boolean) {
    const excluded = include ? aliasCfg.excluded.filter((a) => a !== addr) : [...aliasCfg.excluded, addr];
    updateAlias({ ...aliasCfg, excluded });
  }

  const highlightCandidates = addrInfo
    ? [...new Set([addrInfo.primary, ...addrInfo.sendAs, ...aliasCfg.extra])].filter(
        (a) => a === addrInfo.primary || !aliasCfg.excluded.includes(a),
      )
    : [];
  const highlightOn = aliasCfg.highlight ?? (addrInfo ? [addrInfo.primary] : []);

  function toggleHighlight(addr: string, on: boolean) {
    const next = on ? [...new Set([...highlightOn, addr])] : highlightOn.filter((a) => a !== addr);
    updateAlias({ ...aliasCfg, highlight: next });
  }

  function addAlias() {
    const addr = normalizeAddress(newAlias);
    if (!isValidAddress(addr)) {
      setAliasMsg("올바른 메일 주소가 아닙니다.");
      return;
    }
    if (addrInfo?.sendAs.includes(addr) || aliasCfg.extra.includes(addr)) {
      setAliasMsg("이미 목록에 있는 주소입니다.");
      return;
    }
    setAliasMsg(null);
    setNewAlias("");
    updateAlias({ ...aliasCfg, extra: [...aliasCfg.extra, addr] });
  }

  const [tracker, setTracker] = useState<TrackerConfig>({ enabled: false, url: "", token: "" });
  const [trackerLoaded, setTrackerLoaded] = useState(false);
  const [trackerTest, setTrackerTest] = useState<string | null>(null);

  useEffect(() => {
    loadTrackerConfig().then((c) => {
      setTracker(c);
      setTrackerLoaded(true);
    });
  }, []);

  function updateTracker(patch: Partial<TrackerConfig>) {
    const next = { ...tracker, ...patch };
    setTracker(next);
    setTrackerTest(null);
    if (trackerLoaded) void saveTrackerConfig({ ...next, url: next.url.trim().replace(/\/+$/, ""), token: next.token.trim() });
  }

  async function testTracker() {
    setTrackerTest("확인 중…");
    try {
      const resp = await fetch(`${tracker.url.trim().replace(/\/+$/, "")}/status?ids=`, {
        headers: { Authorization: `Bearer ${tracker.token.trim()}` },
      });
      setTrackerTest(resp.ok ? "연결됐습니다." : resp.status === 401 ? "토큰이 맞지 않습니다." : `오류 (${resp.status})`);
    } catch (e) {
      setTrackerTest(`연결 실패: ${e}`);
    }
  }

  useEffect(() => {
    loadUpdateInfo().then(setUpdateInfo).catch(() => {});
  }, []);

  async function manualCheckUpdate() {
    setUpdateChecking(true);
    setUpdateMsg(null);
    const result = await checkForUpdate(false);
    setUpdateChecking(false);
    if (!result.ok) {
      setUpdateMsg(result.error);
      return;
    }
    setUpdateInfo(result.info);
    setUpdateMsg(result.info.available ? `새 버전 v${result.info.latestVersion}이 있어요.` : "최신 버전입니다.");
  }

  async function toggleCcSplit(on: boolean) {
    setCcSplit(on);
    if (!on) return;
    setCcSplitBusy(true);
    setCcSplitMsg(null);
    try {
      const count = await setUpCcOnlySeparation(true);
      setCcSplitMsg(`"Correo/참조 메일" 필터를 만들고 기존 메일 ${count}건에 적용했습니다.`);
    } catch (e) {
      setCcSplitMsg(String(e));
    } finally {
      setCcSplitBusy(false);
    }
  }

  return (
    <div className="st-root">
      <span className="st-title">설정</span>

      {updateInfo?.available && (
        <div className="st-update-banner">
          <div>
            <div className="st-update-title">새 버전이 있어요: v{updateInfo.latestVersion}</div>
            <div className="text-muted" style={{ fontSize: 12 }}>
              현재 버전 {version} · GitHub에서 새 버전을 내려받아 설치해 주세요.
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => chrome.tabs.create({ url: updateInfo.url })}>
            GitHub에서 보기
          </button>
        </div>
      )}

      <div className="st-account-row">
        <div className="st-account-info">
          <div className="text-muted" style={{ fontSize: 11 }}>
            연결된 계정
          </div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{account.email}</div>
        </div>
        <button className="btn btn-secondary" onClick={onDisconnect}>
          연결 해제
        </button>
      </div>

      <div className="st-block">
        <div className="st-block-title">동기화 기간</div>
        <div className="seg st-period-seg">
          {PERIODS.map((p) => (
            <label key={p.d} className="seg-opt">
              <input type="radio" name="st-days" checked={days === p.d} onChange={() => setDays(p.d)} />
              {p.label}
            </label>
          ))}
        </div>
      </div>

      <div className="st-toggles">
        <div className="st-toggle-row">
          <div className="st-toggle-text">
            <div className="st-toggle-label">참조 메일 제외</div>
            <div className="st-toggle-hint">답장 현황에서 참조(Cc)로만 받은 메일을 뺍니다</div>
          </div>
          <div className="seg">
            <label className="seg-opt">
              <input type="radio" name="st-hideCc" checked={!hideCc} onChange={() => setHideCc(false)} />
              끔
            </label>
            <label className="seg-opt">
              <input type="radio" name="st-hideCc" checked={hideCc} onChange={() => setHideCc(true)} />
              켬
            </label>
          </div>
        </div>
        <div className="st-toggle-row">
          <div className="st-toggle-text">
            <div className="st-toggle-label">공용 주소 제외</div>
            <div className="st-toggle-hint">noreply·news 같은 대표 주소를 뺍니다</div>
          </div>
          <div className="seg">
            <label className="seg-opt">
              <input type="radio" name="st-hideGen" checked={!hideGen} onChange={() => setHideGen(false)} />
              끔
            </label>
            <label className="seg-opt">
              <input type="radio" name="st-hideGen" checked={hideGen} onChange={() => setHideGen(true)} />
              켬
            </label>
          </div>
        </div>
        <div className="st-toggle-row">
          <div className="st-toggle-text">
            <div className="st-toggle-label">참조 메일 자동 분류</div>
            <div className="st-toggle-hint">참조로만 받은 메일 → Correo/참조 메일{ccSplit && " (끄기는 필터를 직접 지워야 해요)"}</div>
          </div>
          <div className="seg">
            <label className="seg-opt">
              <input type="radio" name="st-ccSplit" checked={!ccSplit} onChange={() => toggleCcSplit(false)} disabled={ccSplitBusy} />
              끔
            </label>
            <label className="seg-opt">
              <input type="radio" name="st-ccSplit" checked={ccSplit} onChange={() => toggleCcSplit(true)} disabled={ccSplitBusy} />
              {ccSplitBusy ? "적용 중…" : "켬"}
            </label>
          </div>
        </div>
        {ccSplitMsg && <p className="st-cc-msg">{ccSplitMsg}</p>}
      </div>

      <div className="st-block">
        <div className="st-block-title">내 주소 (별칭)</div>
        <div className="st-toggle-hint">
          이 주소들로 오거나 이 주소에서 나간 메일을 "나"로 봅니다. 변경 후에는 다시 동기화해야 반영됩니다.
        </div>
        <div style={{ margin: "8px 0", fontSize: 13 }}>
          {addrErr && <div className="st-cc-msg">{addrErr}</div>}
          {!addrInfo && !addrErr && <span className="text-muted">불러오는 중…</span>}
          {addrInfo && (
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {addrInfo.primary} <span className="text-muted" style={{ fontWeight: 400 }}>(기본, 항상 포함)</span>
            </div>
          )}
          {addrInfo?.sendAs
            .filter((a) => a !== addrInfo.primary)
            .map((a) => (
              <label key={a} className="checkline">
                <input type="checkbox" checked={!aliasCfg.excluded.includes(a)} onChange={(e) => toggleDetected(a, e.target.checked)} />
                {a} <span className="text-muted">(Gmail 보내는 주소)</span>
              </label>
            ))}
          {aliasCfg.extra.map((a) => (
            <div key={a} style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0" }}>
              <span>{a}</span>
              <span className="text-muted">(직접 추가)</span>
              <button
                className="btn btn-ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => updateAlias({ ...aliasCfg, extra: aliasCfg.extra.filter((x) => x !== a) })}
              >
                제거
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder="추가할 주소 (예: ila@samyangcnc.com)"
            value={newAlias}
            onChange={(e) => {
              setNewAlias(e.target.value);
              setAliasMsg(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && addAlias()}
          />
          <button className="btn btn-secondary" onClick={addAlias} disabled={!newAlias.trim()}>
            추가
          </button>
        </div>
        {aliasMsg && <p className="st-cc-msg">{aliasMsg}</p>}
      </div>

      <div className="st-block">
        <div className="st-block-title">Gmail 목록에서 강조할 받는 주소</div>
        <div className="st-toggle-hint">
          받는 사람(To)에 체크한 주소가 들어 있는 메일을 Gmail 목록에서 강조합니다(참조는 무시). 기본은 기본 주소 하나입니다. 목록에 없는 주소는 위 "내 주소"에서 추가하세요.
        </div>
        <div style={{ margin: "8px 0", fontSize: 13 }}>
          {highlightCandidates.map((a) => (
            <label key={a} className="checkline">
              <input type="checkbox" checked={highlightOn.includes(a)} onChange={(e) => toggleHighlight(a, e.target.checked)} />
              {a}
            </label>
          ))}
        </div>
      </div>

      <div className="st-block">
        <div className="st-block-title">열람 추적 (보낸 메일)</div>
        <div className="st-toggle-hint">
          보내는 메일에 1×1 이미지를 넣어 상대가 열었는지 추정합니다. 상대에게 표시되지 않으니 사내 정책을 확인하세요.
        </div>
        <div className="seg" style={{ margin: "8px 0" }}>
          <label className="seg-opt">
            <input type="radio" name="st-track" checked={!tracker.enabled} onChange={() => updateTracker({ enabled: false })} />
            끔
          </label>
          <label className="seg-opt">
            <input type="radio" name="st-track" checked={tracker.enabled} onChange={() => updateTracker({ enabled: true })} />
            켬
          </label>
        </div>
        <input
          className="input"
          style={{ width: "100%", marginBottom: 6 }}
          placeholder="트래커 주소 (https://correo-tracker.xxx.workers.dev)"
          value={tracker.url}
          onChange={(e) => updateTracker({ url: e.target.value })}
        />
        <input
          className="input"
          style={{ width: "100%", marginBottom: 6 }}
          type="password"
          placeholder="API 토큰"
          value={tracker.token}
          onChange={(e) => updateTracker({ token: e.target.value })}
        />
        <button className="btn btn-secondary" disabled={!tracker.url || !tracker.token} onClick={testTracker}>
          연결 테스트
        </button>
        {trackerTest && <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>{trackerTest}</span>}
      </div>

      <button className="btn btn-secondary st-eml-btn" onClick={openEmlViewer}>
        .eml 파일 뷰어 열기 (새 탭)
      </button>
      <div className="st-version-row">
        <span className="text-muted" style={{ fontSize: 12 }}>
          Correo v{version}
        </span>
        <button className="btn btn-secondary" disabled={updateChecking} onClick={manualCheckUpdate}>
          {updateChecking ? "확인 중…" : "업데이트 확인"}
        </button>
        {updateMsg && (
          <span className="text-muted" style={{ fontSize: 12 }}>
            {updateMsg}
          </span>
        )}
      </div>
    </div>
  );
}
