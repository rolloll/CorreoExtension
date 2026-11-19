import { useEffect, useState } from "react";
import SetupGuide, { copyText, openLink, type GuideStep } from "./SetupGuide";
import { testTrackerConnection, type TrackerConfig } from "./tracking";
// The very same file that gets deployed, so the guide can never drift from it.
import workerCode from "../tracker/worker.js?raw";

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

  const steps: GuideStep[] = [
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
              <b>Hello World</b>로 시작 → 이름 <span className="sg-code">correo-tracker</span> → <b>Deploy</b>.
            </li>
            <li>
              배포되면 <b>Edit code</b>를 누르고, 기존 코드를 <b>전부 지운 뒤</b> 아래 <b>코드 복사</b>로 복사한 내용을 붙여넣고 <b>Deploy</b>합니다.
            </li>
          </ol>
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

  return <SetupGuide steps={steps} />;
}
