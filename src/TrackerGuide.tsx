import { useEffect, useState } from "react";
import SetupGuide, { copyText, openLink, type GuideStep } from "./SetupGuide";
import { testTrackerConnection, type TrackerConfig } from "./tracking";
import { GITHUB_REPO } from "./updateCheck";
// The very same file that gets deployed, so the guide can never drift from it.
import workerCode from "../tracker/worker.js?raw";

// Cloudflare reads tracker/ (worker.js + wrangler.toml + .dev.vars.example +
// package.json) from the public GitHub repo.
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=https://github.com/${GITHUB_REPO}/tree/main/tracker`;

function makeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Step-by-step setup of the read-tracking server (a free Cloudflare Worker),
// done entirely through Cloudflare's website - no installs, no command line.
export default function TrackerGuide({
  tracker,
  onChange,
}: {
  tracker: TrackerConfig;
  onChange: (patch: Partial<TrackerConfig>) => void;
}) {
  const [acked, setAcked] = useState<boolean[]>([false, false, false, false]);
  const [copied, setCopied] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [manual, setManual] = useState(false);
  const [quickAcked, setQuickAcked] = useState(false);
  const [existing, setExisting] = useState(false);

  // Check on its own once the pasted address looks complete (debounced).
  useEffect(() => {
    const url = tracker.url.trim();
    if (!/^https:\/\/[^/\s]+\.[a-z]{2,}/i.test(url) || !tracker.token) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setTesting(true);
      testTrackerConnection(url, tracker.token).then((r) => {
        if (cancelled) return;
        setTest(r);
        setTesting(false);
      });
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [tracker.url, tracker.token]);

  // A fresh random token the user will paste into Cloudflare as API_TOKEN.
  useEffect(() => {
    if (!tracker.token) onChange({ token: makeToken() });
    // Only once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ack = (i: number) => setAcked((a) => a.map((v, j) => (j === i ? true : v)));
  const copy = (key: string, text: string) =>
    void copyText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    });

  async function runTest() {
    setTesting(true);
    setTest(null);
    setTest(await testTrackerConnection(tracker.url, tracker.token));
    setTesting(false);
  }

  const doneBtn = (i: number) => (
    <div className="sg-actions">
      <button type="button" className="btn btn-primary" onClick={() => ack(i)}>
        완료했어요
      </button>
    </div>
  );

  // Quick path: Cloudflare's "Deploy to Cloudflare" button clones tracker/ from
  // GitHub, creates the KV namespace itself and asks for API_TOKEN, so the
  // manual KV/binding/secret steps below aren't needed.
  const quickSteps: GuideStep[] = [
    {
      title: "Cloudflare에 서버 만들기 (버튼 한 번)",
      done: quickAcked,
      body: (
        <>
          <div>
            열람 확인을 받아줄 내 전용 작은 서버를 만듭니다. Cloudflare <b>무료 플랜</b>이면 되고, 저장소는 자동으로 만들어집니다.
          </div>
          <ol>
            <li>
              아래 <b>Cloudflare에 배포</b>를 누르고, 로그인(또는 무료 가입)합니다. GitHub 연결을 물으면 허용하세요.
            </li>
            <li>
              <b>API_TOKEN</b> 칸에 아래 토큰을 붙여넣습니다.
            </li>
            <li>
              <b>Deploy</b>를 누르고 끝날 때까지 기다립니다.
            </li>
          </ol>
          <div className="sg-actions">
            <span className="sg-code">{tracker.token || "…"}</span>
            <button type="button" className="btn btn-secondary" disabled={!tracker.token} onClick={() => copy("token", tracker.token)}>
              {copied === "token" ? "복사됨 ✓" : "토큰 복사"}
            </button>
          </div>
          <div className="sg-actions">
            <button type="button" className="btn btn-primary" onClick={() => openLink(DEPLOY_URL)}>
              Cloudflare에 배포
            </button>
          </div>
          <div className="sg-note">
            처음 가입하면 "workers.dev 주소"를 정하라고 물을 수 있습니다. 원하는 이름을 정하면 됩니다. 토큰은 이 프로그램에도 자동 저장되어 있습니다.
          </div>
          <div className="sg-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setQuickAcked(true)}>
              배포를 마쳤어요
            </button>
          </div>
        </>
      ),
    },
    {
      title: "서버 주소 붙여넣기",
      done: !!test?.ok,
      body: (
        <>
          <div>
            배포가 끝나면 서버 주소가 보입니다. (<span className="sg-code">https://correo-tracker.○○○.workers.dev</span>) 그 주소를 붙여넣으면 자동으로
            확인합니다.
          </div>
          <input
            className="input"
            style={{ width: "100%" }}
            placeholder="https://correo-tracker.○○○.workers.dev"
            value={tracker.url}
            onChange={(e) => {
              setTest(null);
              onChange({ url: e.target.value });
            }}
            autoFocus
          />
          {testing && <div className="sg-note">확인 중…</div>}
          {test && (
            <div className={test.ok ? "sg-ok" : "sg-err"}>
              {test.ok ? "✓ " : ""}
              {test.message}
            </div>
          )}
        </>
      ),
    },
    {
      title: "열람 추적 켜기",
      done: tracker.enabled,
      body: (
        <>
          <div>
            켜면 앞으로 보내는 메일에 눈에 보이지 않는 1×1 이미지가 들어가고, 상대가 열면 <b>기간 탭</b>의 보낸 메일에 "열람 추정" 시각이 표시됩니다.
          </div>
          <div className="sg-note">
            상대에게 표시되지 않지만 사내 정책을 확인하세요. 메일 앱이 이미지를 막으면 열어도 "미열람"으로 보일 수 있습니다.
          </div>
          <div className="sg-actions">
            <button type="button" className="btn btn-primary" onClick={() => onChange({ enabled: true })}>
              열람 추적 켜기
            </button>
          </div>
        </>
      ),
    },
  ];

  const manualSteps: GuideStep[] = [
    {
      title: "Cloudflare 계정 준비 (무료)",
      done: acked[0],
      body: (
        <>
          <div>
            열람 확인은 내 전용 작은 서버가 필요합니다. Cloudflare의 <b>무료 플랜</b>으로 충분하고, 카드 등록은 필요 없습니다. 이미 계정이 있으면
            로그인만 하세요.
          </div>
          <div className="sg-actions">
            <button type="button" className="btn btn-secondary" onClick={() => openLink("https://dash.cloudflare.com/sign-up")}>
              Cloudflare 열기
            </button>
          </div>
          <div className="sg-note">가입 후 이메일 인증까지 끝나면 아래 버튼을 누르세요.</div>
          {doneBtn(0)}
        </>
      ),
    },
    {
      title: "저장소(KV) 만들기",
      done: acked[1],
      body: (
        <>
          <ol>
            <li>아래 버튼으로 KV 화면을 엽니다.</li>
            <li>
              <b>Create(만들기)</b>를 누르고, 이름에 <span className="sg-code">OPENS</span> 를 입력한 뒤 추가합니다.
            </li>
          </ol>
          <div className="sg-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openLink("https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces")}
            >
              KV 화면 열기
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => copy("kv", "OPENS")}>
              {copied === "kv" ? "복사됨" : "이름 복사"}
            </button>
          </div>
          {doneBtn(1)}
        </>
      ),
    },
    {
      title: "서버(Worker) 만들고 코드 붙여넣기",
      done: acked[2],
      body: (
        <>
          <ol>
            <li>아래 버튼으로 Worker 만들기 화면을 엽니다.</li>
            <li>
              <b>Hello World</b>로 시작 → 이름 <span className="sg-code">correo-tracker</span> → <b>Deploy</b>. (이건 빈 샘플 서버를 만드는 단계입니다.)
            </li>
            <li>
              <b>Edit code</b>를 누르고, 샘플 코드를 <b>전부 지운 뒤</b> 아래 <b>코드 복사</b>로 복사한 Correo 코드를 붙여넣고 <b>Deploy를 한 번 더</b>{" "}
              누릅니다.
            </li>
          </ol>
          <div className="sg-note">
            이미 "Deployed"라고 나왔어도 샘플 코드 상태일 수 있습니다. 주소를 브라우저에서 열었을 때 <b>ok</b>가 보여야 Correo 코드로 바뀐 것입니다.
            (<b>Hello World!</b>가 보이면 아직 샘플 코드입니다.)
          </div>
          <div className="sg-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => openLink("https://dash.cloudflare.com/?to=/:account/workers-and-pages/create")}
            >
              Worker 만들기 열기
            </button>
            <button type="button" className="btn btn-primary" onClick={() => copy("code", workerCode)}>
              {copied === "code" ? "복사됨 ✓" : "코드 복사"}
            </button>
          </div>
          <div className="sg-note">처음이라면 Cloudflare가 "workers.dev 주소"를 정하라고 물을 수 있습니다. 원하는 이름을 정하면 됩니다.</div>
          {doneBtn(2)}
        </>
      ),
    },
    {
      title: "저장소·토큰 연결하기",
      done: acked[3],
      body: (
        <>
          <div>
            방금 만든 Worker 화면에서 <b>Settings(설정)</b> 탭으로 이동해 두 가지를 추가하고 각각 <b>Deploy</b>합니다.
          </div>
          <ol>
            <li>
              <b>Bindings → Add → KV namespace</b>: 변수 이름 <span className="sg-code">OPENS</span>, 저장소는 2단계에서 만든{" "}
              <span className="sg-code">OPENS</span> 선택
            </li>
            <li>
              <b>Variables and Secrets → Add</b>: 종류 <b>Secret</b>, 이름 <span className="sg-code">API_TOKEN</span>, 값은 아래 토큰
            </li>
          </ol>
          <div className="sg-actions">
            <span className="sg-code">{tracker.token || "…"}</span>
            <button type="button" className="btn btn-primary" disabled={!tracker.token} onClick={() => copy("token", tracker.token)}>
              {copied === "token" ? "복사됨 ✓" : "토큰 복사"}
            </button>
          </div>
          <div className="sg-note">
            이 토큰은 자동으로 이 프로그램에도 저장되어 있어서 따로 입력하지 않아도 됩니다. 화면 이름이 조금 달라도 비슷한 항목을 찾아 진행하세요.
          </div>
          {doneBtn(3)}
        </>
      ),
    },
    {
      title: "서버 주소 입력하고 연결 확인",
      done: !!test?.ok,
      body: (
        <>
          <div>
            Worker 화면 위쪽에 보이는 주소(<span className="sg-code">https://correo-tracker.○○○.workers.dev</span>)를 붙여넣으세요.
          </div>
          <input
            className="input"
            style={{ width: "100%" }}
            placeholder="https://correo-tracker.○○○.workers.dev"
            value={tracker.url}
            onChange={(e) => {
              setTest(null);
              onChange({ url: e.target.value });
            }}
          />
          <div className="sg-actions">
            <button type="button" className="btn btn-primary" disabled={!tracker.url.trim() || testing} onClick={runTest}>
              {testing ? "확인 중…" : "연결 확인"}
            </button>
          </div>
          {test && (
            <div className={test.ok ? "sg-ok" : "sg-err"}>
              {test.ok ? "✓ " : ""}
              {test.message}
            </div>
          )}
        </>
      ),
    },
    {
      title: "열람 추적 켜기",
      done: tracker.enabled,
      body: (
        <>
          <div>
            이제 켜기만 하면 됩니다. 켜면 앞으로 보내는 메일에 눈에 보이지 않는 1×1 이미지가 들어가고, 상대가 열면 <b>기간 탭</b>의 보낸 메일에 "열람
            추정" 시각이 표시됩니다.
          </div>
          <div className="sg-note">
            상대에게 표시되지 않지만 사내 정책을 확인하세요. 메일 앱이 이미지를 막으면 열어도 "미열람"으로 보일 수 있습니다.
          </div>
          <div className="sg-actions">
            <button type="button" className="btn btn-primary" onClick={() => onChange({ enabled: true })}>
              열람 추적 켜기
            </button>
          </div>
        </>
      ),
    },
  ];

  // Someone who already runs a tracker server (same address + token) only needs
  // to type those two things.
  const existingBlock = (
    <div className="sg-step current">
      <div className="sg-body" style={{ paddingLeft: 12 }}>
        <div>이미 만든 서버가 있다면 주소와 토큰만 입력하세요. 입력하면 자동으로 확인합니다.</div>
        <input
          className="input"
          style={{ width: "100%" }}
          placeholder="서버 주소 (https://….workers.dev)"
          value={tracker.url}
          onChange={(e) => {
            setTest(null);
            onChange({ url: e.target.value });
          }}
        />
        <input
          className="input"
          style={{ width: "100%" }}
          type="password"
          placeholder="토큰 (서버를 만들 때 정한 API_TOKEN 값)"
          value={tracker.token}
          onChange={(e) => {
            setTest(null);
            onChange({ token: e.target.value });
          }}
        />
        <div className="sg-note">
          토큰은 Cloudflare에서 다시 볼 수 없습니다 ("Value encrypted"로 표시되는 게 정상). 서버를 만들 때 따로 저장해 둔 값을 쓰세요.
        </div>
        {testing && <div className="sg-note">확인 중…</div>}
        {test && (
          <div className={test.ok ? "sg-ok" : "sg-err"}>
            {test.ok ? "✓ " : ""}
            {test.message}
          </div>
        )}
        <div className="sg-actions">
          <button type="button" className="btn btn-primary" disabled={!test?.ok || tracker.enabled} onClick={() => onChange({ enabled: true })}>
            {tracker.enabled ? "켜져 있음" : "열람 추적 켜기"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {existing ? existingBlock : <SetupGuide steps={manual ? manualSteps : quickSteps} />}
      <div className="sg-actions">
        {(existing || manual) && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setExisting(false);
              setManual(false);
            }}
          >
            ← 간단한 방법으로
          </button>
        )}
        {!existing && (
          <button type="button" className="btn btn-ghost" onClick={() => setExisting(true)}>
            이미 만든 서버가 있어요
          </button>
        )}
        {!manual && !existing && (
          <button type="button" className="btn btn-ghost" onClick={() => setManual(true)}>
            배포 버튼이 안 될 때: 직접 만들기
          </button>
        )}
      </div>
    </>
  );
}
