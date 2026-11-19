import { useEffect, useState } from "react";
import KeywordChips from "./KeywordChips";
import SetupGuide, { openLink, type GuideStep } from "./SetupGuide";
import {
  DEFAULT_TELEGRAM,
  findChatId,
  getBotInfo,
  loadTelegramConfig,
  saveTelegramConfig,
  sendTelegram,
  type BotInfo,
  type TelegramConfig,
} from "./telegram";

const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

// Settings block: Telegram alert when new mail is addressed to chosen accounts.
// Walks a first-time user through creating the bot, with every lookup that can
// be automated (token check, bot link, chat id) done for them.
export default function TelegramSettings() {
  const [cfg, setCfg] = useState<TelegramConfig>(DEFAULT_TELEGRAM);
  const [loaded, setLoaded] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [botErr, setBotErr] = useState<string | null>(null);
  const [acked, setAcked] = useState(false);
  const [testOk, setTestOk] = useState(false);

  useEffect(() => {
    loadTelegramConfig().then((c) => {
      setCfg(c);
      setLoaded(true);
      // Already running: show the compact form, with the guide a click away.
      setShowGuide(!c.enabled);
    });
  }, []);

  function update(patch: Partial<TelegramConfig>) {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setMsg(null);
    if (loaded) void saveTelegramConfig({ ...next, botToken: next.botToken.trim(), chatId: next.chatId.trim() });
  }

  // Validate the token as soon as it looks like one.
  useEffect(() => {
    const token = cfg.botToken.trim();
    setBot(null);
    setBotErr(null);
    if (!token) return;
    if (!TOKEN_SHAPE.test(token)) {
      setBotErr("토큰 모양이 아닙니다. BotFather가 보내준 긴 문자열(123456789:ABC…)을 통째로 붙여넣으세요.");
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      getBotInfo(token)
        .then((b) => !cancelled && setBot(b))
        .catch((e) => !cancelled && setBotErr(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cfg.botToken]);

  // Once the bot is known, wait for the user's first message to it and pick
  // the chat id up on its own.
  useEffect(() => {
    if (!bot || cfg.chatId.trim()) return;
    let stopped = false;
    async function poll() {
      try {
        const id = await findChatId(cfg.botToken);
        if (id && !stopped) update({ chatId: id });
      } catch {
        // Keep waiting; a transient error shouldn't derail the guide.
      }
    }
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // update() is recreated every render; the poll only needs the token/chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, cfg.chatId, cfg.botToken]);

  async function test() {
    setMsg("보내는 중…");
    setTestOk(false);
    try {
      await sendTelegram(cfg, "✅ Correo 텔레그램 알림 연결 테스트입니다.");
      setTestOk(true);
      setMsg("테스트 메시지를 보냈습니다. 텔레그램을 확인하세요.");
    } catch (e) {
      setMsg(`실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  const ready = !!cfg.botToken.trim() && !!cfg.chatId.trim();

  const steps: GuideStep[] = [
    {
      title: "텔레그램에서 내 봇 만들기",
      done: acked || !!bot,
      body: (
        <>
          <div>알림을 보내줄 나만의 봇을 만듭니다. 1분이면 됩니다.</div>
          <div className="sg-actions">
            <button type="button" className="btn btn-primary" onClick={() => openLink("https://t.me/BotFather")}>
              BotFather 열기
            </button>
          </div>
          <ol>
            <li>텔레그램이 열리면 <b>시작(Start)</b>을 누르세요. (설치가 안 되어 있으면 안내가 뜹니다)</li>
            <li>
              <span className="sg-code">/newbot</span> 이라고 보냅니다.
            </li>
            <li>봇 이름을 물으면 아무 이름이나 입력합니다. (예: 내 Correo 알림)</li>
            <li>
              봇 아이디를 물으면 영문으로 입력하고 <b>반드시 bot으로 끝나게</b> 합니다. (예: <span className="sg-code">my_correo_alert_bot</span>)
            </li>
            <li>
              완료되면 <b>긴 토큰</b>(<span className="sg-code">123456789:ABC…</span>)이 나옵니다. 길게 눌러 <b>복사</b>하세요.
            </li>
          </ol>
          <div className="sg-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setAcked(true)}>
              토큰을 복사했어요
            </button>
          </div>
        </>
      ),
    },
    {
      title: "토큰 붙여넣기",
      done: !!bot,
      body: (
        <>
          <input
            className="input"
            style={{ width: "100%" }}
            type="password"
            placeholder="여기에 토큰 붙여넣기 (123456789:ABC…)"
            value={cfg.botToken}
            onChange={(e) => update({ botToken: e.target.value })}
            autoFocus
          />
          {bot && (
            <div className="sg-ok">
              ✓ 봇을 확인했습니다: {bot.name} (@{bot.username})
            </div>
          )}
          {botErr && <div className="sg-err">{botErr}</div>}
          {!bot && !botErr && !cfg.botToken.trim() && <div className="sg-note">붙여넣으면 자동으로 확인합니다.</div>}
        </>
      ),
    },
    {
      title: "내 봇에게 메시지 보내기",
      done: !!cfg.chatId.trim(),
      body: (
        <>
          <div>알림을 받을 대화방을 연결합니다. 방금 만든 봇에게 먼저 말을 걸어 주세요.</div>
          <div className="sg-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!bot}
              onClick={() => bot && openLink(`https://t.me/${bot.username}`)}
            >
              {bot ? `@${bot.username} 열기` : "봇 열기"}
            </button>
          </div>
          <ol>
            <li>열린 대화에서 <b>시작(Start)</b>을 누르고, <b>아무 말이나 한 줄</b> 보내세요. (예: 안녕)</li>
            <li>이 화면으로 돌아오면 자동으로 연결됩니다.</li>
          </ol>
          {bot && !cfg.chatId.trim() && <div className="sg-note">메시지를 기다리는 중… (자동으로 확인합니다)</div>}
          {cfg.chatId.trim() && <div className="sg-ok">✓ 연결됐습니다.</div>}
        </>
      ),
    },
    {
      title: "알림 받을 메일 계정 정하고 켜기",
      done: cfg.enabled && cfg.addresses.length > 0,
      body: (
        <>
          <div>어떤 계정으로 온 메일을 알려드릴까요? 받는 사람(To)이 이 주소인 새 메일의 제목이 텔레그램으로 옵니다.</div>
          <KeywordChips
            keywords={cfg.addresses}
            onChange={(addresses) => update({ addresses })}
            placeholder="메일 주소 입력 후 Enter"
            normalize={(s) => s.toLowerCase()}
          />
          <label className="checkline">
            <input type="checkbox" checked={cfg.includeCc} onChange={(e) => update({ includeCc: e.target.checked })} />
            참조(Cc)로 받은 메일도 알림
          </label>
          <div className="sg-actions">
            <button type="button" className="btn btn-secondary" disabled={!ready} onClick={test}>
              테스트 전송
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!ready || cfg.addresses.length === 0}
              onClick={() => {
                update({ enabled: true });
                setShowGuide(false);
              }}
            >
              알림 켜기
            </button>
          </div>
          {msg && <div className={testOk ? "sg-ok" : "sg-note"}>{msg}</div>}
          <div className="sg-note">제목과 보낸 사람만 전송하며 본문은 보내지 않습니다. 1분마다 확인하고, 켠 시점 이후 메일부터 알립니다.</div>
        </>
      ),
    },
  ];

  return (
    <div className="st-block">
      <div className="st-block-title">텔레그램 알림</div>
      <div className="st-toggle-hint">
        지정한 메일 계정이 받는 사람인 새 메일이 오면 텔레그램으로 제목과 보낸 사람을 보내 드립니다.
      </div>

      {showGuide ? (
        <>
          <SetupGuide steps={steps} />
          {cfg.enabled && (
            <button className="btn btn-ghost" onClick={() => setShowGuide(false)}>
              안내 닫기
            </button>
          )}
        </>
      ) : (
        <>
          <div className="seg" style={{ margin: "8px 0" }}>
            <label className="seg-opt">
              <input type="radio" name="st-tg" checked={!cfg.enabled} onChange={() => update({ enabled: false })} />끔
            </label>
            <label className="seg-opt">
              <input type="radio" name="st-tg" checked={cfg.enabled} onChange={() => update({ enabled: true })} />켬
            </label>
          </div>
          <div className="st-toggle-hint" style={{ marginBottom: 4 }}>
            알림 받을 메일 계정 (받는 사람이 이 주소일 때)
          </div>
          <KeywordChips
            keywords={cfg.addresses}
            onChange={(addresses) => update({ addresses })}
            placeholder="주소 입력 후 Enter"
            normalize={(s) => s.toLowerCase()}
          />
          <label className="checkline" style={{ margin: "8px 0" }}>
            <input type="checkbox" checked={cfg.includeCc} onChange={(e) => update({ includeCc: e.target.checked })} />
            참조(Cc)로 받은 메일도 알림
          </label>
          <button className="btn btn-secondary" disabled={!ready} onClick={test}>
            테스트 전송
          </button>
          <button className="btn btn-ghost" style={{ marginLeft: 6 }} onClick={() => setShowGuide(true)}>
            설정 안내 다시 보기
          </button>
          {msg && (
            <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
              {msg}
            </span>
          )}
        </>
      )}
    </div>
  );
}
