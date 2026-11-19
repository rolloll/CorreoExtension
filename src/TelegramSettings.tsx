import { useEffect, useState } from "react";
import KeywordChips from "./KeywordChips";
import {
  DEFAULT_TELEGRAM,
  findChatId,
  loadTelegramConfig,
  saveTelegramConfig,
  sendTelegram,
  type TelegramConfig,
} from "./telegram";

// Settings block: Telegram alert when new mail is addressed to chosen accounts.
export default function TelegramSettings() {
  const [cfg, setCfg] = useState<TelegramConfig>(DEFAULT_TELEGRAM);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    loadTelegramConfig().then((c) => {
      setCfg(c);
      setLoaded(true);
    });
  }, []);

  function update(patch: Partial<TelegramConfig>) {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setMsg(null);
    if (loaded) void saveTelegramConfig({ ...next, botToken: next.botToken.trim(), chatId: next.chatId.trim() });
  }

  async function lookupChat() {
    setMsg("확인 중…");
    try {
      const id = await findChatId(cfg.botToken);
      if (id) {
        update({ chatId: id });
        setMsg(`채팅 ID를 찾았습니다: ${id}`);
      } else {
        setMsg("봇에게 보낸 메시지가 없습니다. 텔레그램에서 봇에게 아무 메시지나 보낸 뒤 다시 눌러 주세요.");
      }
    } catch (e) {
      setMsg(`실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function test() {
    setMsg("보내는 중…");
    try {
      await sendTelegram(cfg, "✅ Correo 텔레그램 알림 연결 테스트입니다.");
      setMsg("테스트 메시지를 보냈습니다.");
    } catch (e) {
      setMsg(`실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  const ready = !!cfg.botToken.trim() && !!cfg.chatId.trim();

  return (
    <div className="st-block">
      <div className="st-block-title">텔레그램 알림</div>
      <div className="st-toggle-hint">
        아래 주소가 받는 사람(To)인 새 메일이 받은편지함에 오면 텔레그램으로 제목과 보낸 사람을 보냅니다(본문은 보내지 않습니다).
        1분마다 확인하며, 켠 시점 이후에 온 메일부터 알립니다.
      </div>
      <div className="seg" style={{ margin: "8px 0" }}>
        <label className="seg-opt">
          <input type="radio" name="st-tg" checked={!cfg.enabled} onChange={() => update({ enabled: false })} />끔
        </label>
        <label className="seg-opt">
          <input type="radio" name="st-tg" checked={cfg.enabled} onChange={() => update({ enabled: true })} />켬
        </label>
      </div>
      <div className="st-toggle-hint" style={{ marginBottom: 6 }}>
        설정 방법: 텔레그램에서 @BotFather로 봇을 만들어 토큰을 받고 → 그 봇에게 아무 메시지나 보낸 뒤 → "채팅 ID 찾기"를 누르세요.
      </div>
      <input
        className="input"
        style={{ width: "100%", marginBottom: 6 }}
        type="password"
        placeholder="봇 토큰 (123456:ABC…)"
        value={cfg.botToken}
        onChange={(e) => update({ botToken: e.target.value })}
      />
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="채팅 ID"
          value={cfg.chatId}
          onChange={(e) => update({ chatId: e.target.value })}
        />
        <button className="btn btn-secondary" disabled={!cfg.botToken.trim()} onClick={lookupChat}>
          채팅 ID 찾기
        </button>
      </div>
      <div className="st-toggle-hint" style={{ marginBottom: 4 }}>알림 받을 메일 계정 (받는 사람이 이 주소일 때)</div>
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
      {msg && (
        <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {msg}
        </span>
      )}
    </div>
  );
}
