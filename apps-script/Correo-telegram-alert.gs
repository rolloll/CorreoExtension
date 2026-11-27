/**
 * Correo 텔레그램 새 메일 알림 (Google Apps Script)
 *
 * 크롬/PC가 꺼져 있어도 Google 서버에서 1분마다 Gmail을 확인해 텔레그램으로 알려 줍니다.
 * 규칙은 Correo 확장과 같습니다: 받은편지함(in:inbox)에 새로 도착한 메일 중
 * 감시 주소가 받는 사람(To)에 있는 메일을 알립니다. (INCLUDE_CC=true 면 참조(Cc)도 포함)
 *
 * 설정은 코드에 쓰지 말고 [프로젝트 설정 → 스크립트 속성]에 넣으세요.
 *   BOT_TOKEN  : BotFather가 준 봇 토큰
 *   CHAT_ID    : 알림 받을 채팅 ID (모르면 findChatId() 실행 후 로그 확인)
 *   ADDRESSES  : 감시할 주소, 쉼표로 구분 (예: raphie@samyangcnc.com,marketing@samyangcnc.com)
 *   INCLUDE_CC : 참조도 알림받으려면 true (선택)
 */

var MAX_INDIVIDUAL = 10;     // 한 번에 개별 알림은 최대 10건, 나머지는 요약 1건
var MAX_NOTIFIED = 200;      // 중복 방지용으로 기억할 메일 ID 수
var MAX_LOOKBACK_SEC = 86400; // 오래 멈췄다 켜져도 최대 24시간 전까지만 확인

/** 1분마다 실행되는 함수 (트리거가 호출) */
function checkNewMail() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // 이전 실행이 아직 끝나지 않았으면 건너뜀
  try {
    run_();
  } finally {
    lock.releaseLock();
  }
}

function run_() {
  var props = PropertiesService.getScriptProperties();
  var token = (props.getProperty('BOT_TOKEN') || '').trim();
  var chatId = (props.getProperty('CHAT_ID') || '').trim();
  var addrs = (props.getProperty('ADDRESSES') || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
  var includeCc = (props.getProperty('INCLUDE_CC') || '').trim().toLowerCase() === 'true';

  if (!token || !chatId || addrs.length === 0) {
    console.warn('설정이 비어 있습니다. BOT_TOKEN / CHAT_ID / ADDRESSES 스크립트 속성을 확인하세요.');
    return;
  }

  var now = Math.floor(Date.now() / 1000);
  var state = JSON.parse(props.getProperty('STATE') || 'null');
  if (!state) {
    // 첫 실행: 지금 이후에 오는 메일부터 알립니다 (기존 메일은 알리지 않음)
    props.setProperty('STATE', JSON.stringify({ lastSec: now, notified: [] }));
    console.log('초기화 완료. 지금부터 새로 도착하는 메일을 알립니다.');
    return;
  }

  var after = Math.max(state.lastSec - 60, now - MAX_LOOKBACK_SEC);
  var terms = [];
  addrs.forEach(function (a) {
    terms.push('to:' + a);
    if (includeCc) terms.push('cc:' + a);
  });
  var query = 'in:inbox after:' + after + ' {' + terms.join(' ') + '}';

  var mine = myAddresses_();
  var seen = {};
  state.notified.forEach(function (id) { seen[id] = true; });

  var found = [];
  GmailApp.search(query, 0, 50).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var id = msg.getId();
      if (seen[id] || msg.isDraft() || msg.isInTrash()) return;
      if (msg.getDate().getTime() / 1000 < after) return;
      if (extractEmails_(msg.getFrom()).some(function (e) { return mine[e]; })) return; // 내가 보낸 메일 제외
      var to = extractEmails_(msg.getTo());
      var cc = includeCc ? extractEmails_(msg.getCc()) : [];
      var matched = null;
      for (var i = 0; i < addrs.length && !matched; i++) {
        if (to.indexOf(addrs[i]) !== -1 || cc.indexOf(addrs[i]) !== -1) matched = addrs[i];
      }
      if (matched) {
        found.push({
          id: id,
          subject: msg.getSubject() || '(제목 없음)',
          from: msg.getFrom() || '',
          matched: matched,
          time: msg.getDate().getTime()
        });
      }
    });
  });
  found.sort(function (a, b) { return a.time - b.time; });

  var notified = state.notified.slice();
  var ok = true;
  try {
    found.slice(0, MAX_INDIVIDUAL).forEach(function (m) {
      send_(token, chatId,
        '📧 ' + m.subject.slice(0, 500) +
        '\n보낸 사람: ' + m.from.slice(0, 200) +
        '\n받는 주소: ' + m.matched);
      notified.push(m.id);
    });
    if (found.length > MAX_INDIVIDUAL) {
      var rest = found.slice(MAX_INDIVIDUAL);
      send_(token, chatId,
        '📧 그 외 새 메일 ' + rest.length + '건\n' +
        rest.map(function (m) { return '· ' + m.subject.slice(0, 80); }).join('\n'));
      rest.forEach(function (m) { notified.push(m.id); });
    }
  } catch (err) {
    ok = false;
    console.error('텔레그램 전송 실패: ' + err); // 실패하면 다음 실행에서 다시 시도합니다
  }

  props.setProperty('STATE', JSON.stringify({
    lastSec: ok ? now : state.lastSec,
    notified: notified.slice(-MAX_NOTIFIED)
  }));
}

function send_(token, chatId, text) {
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      disable_web_page_preview: true
    })
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() !== 200 || !body.ok) {
    throw new Error((body && body.description) || ('텔레그램 오류 (' + res.getResponseCode() + ')'));
  }
}

function extractEmails_(s) {
  var m = (s || '').toLowerCase().match(/[a-z0-9._%+'\-]+@[a-z0-9.\-]+\.[a-z]{2,}/g);
  return m || [];
}

function myAddresses_() {
  var set = {};
  var me = Session.getEffectiveUser().getEmail();
  if (me) set[me.toLowerCase()] = true;
  try {
    GmailApp.getAliases().forEach(function (a) { set[a.toLowerCase()] = true; });
  } catch (e) {}
  return set;
}

/* ───────── 한 번만 실행하는 도우미 함수들 ───────── */

/** 1분 간격 트리거를 만듭니다. (이미 있으면 지우고 다시 만듭니다) */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkNewMail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkNewMail').timeBased().everyMinutes(1).create();
  console.log('1분 트리거를 만들었습니다.');
}

/** 연결 테스트 메시지를 보냅니다. */
function testTelegram() {
  var props = PropertiesService.getScriptProperties();
  send_((props.getProperty('BOT_TOKEN') || '').trim(),
        (props.getProperty('CHAT_ID') || '').trim(),
        '✅ Correo 텔레그램 알림(Apps Script) 연결 테스트입니다.');
  console.log('테스트 메시지를 보냈습니다. 텔레그램을 확인하세요.');
}

/** 봇에게 아무 말이나 보낸 뒤 실행하면 채팅 ID를 로그에 보여 줍니다. */
function findChatId() {
  var token = (PropertiesService.getScriptProperties().getProperty('BOT_TOKEN') || '').trim();
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  var body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error(body.description || '텔레그램 오류');
  var list = (body.result || []).slice().reverse();
  for (var i = 0; i < list.length; i++) {
    var chat = (list[i].message && list[i].message.chat) || (list[i].channel_post && list[i].channel_post.chat);
    if (chat) { console.log('CHAT_ID = ' + chat.id); return; }
  }
  console.log('아직 메시지가 없습니다. 봇에게 말을 한 줄 보낸 뒤 다시 실행하세요.');
}

/** 알림 기록을 초기화합니다. (다음 실행부터 "지금 이후" 메일만 알림) */
function resetState() {
  PropertiesService.getScriptProperties().deleteProperty('STATE');
  console.log('초기화했습니다.');
}
