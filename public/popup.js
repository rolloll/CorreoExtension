const ACTIVITY_KEY = "correo_activity_cache";
const PREFS_KEY = "correo_prefs";
const ACCOUNT_KEY = "correo_gmail_account";

const root = document.getElementById("root");

function daysSince(ms) {
  if (!ms) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function dtag(ms) {
  const d = daysSince(ms);
  return d === 0 ? "오늘" : `D+${d}`;
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of children || []) node.appendChild(c);
  return node;
}

function refreshIconSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML =
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path>';
  return svg;
}

async function loadState() {
  const stored = await chrome.storage.local.get([ACTIVITY_KEY, PREFS_KEY, ACCOUNT_KEY]);
  const cached = stored[ACTIVITY_KEY];
  const prefs = stored[PREFS_KEY] || { hideCc: true, hideGen: true };
  return { account: stored[ACCOUNT_KEY] || null, cached: cached || null, prefs };
}

function visible(items, prefs) {
  return items.filter((t) => !(prefs.hideCc && t.ccOnly) && !(prefs.hideGen && t.counterpartIsGeneric));
}

async function openPanel(filter) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://mail.google.com/")) {
    return false;
  }
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "openSidePanel", filter }, () => resolve(true));
  });
}

async function render() {
  root.innerHTML = "";
  const { account, cached, prefs } = await loadState();

  const header = el("div", { class: "head" }, [
    el("div", { class: "brand", text: "C" }),
    el("span", { class: "head-title", text: "Correo" }),
  ]);

  if (account) {
    const refreshBtn = el("button", { class: "icon-btn", title: "다시 동기화" }, [refreshIconSvg()]);
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.classList.add("spinning");
      refreshBtn.disabled = true;
      try {
        await new Promise((resolve) => chrome.runtime.sendMessage({ type: "syncNow" }, resolve));
      } finally {
        await render();
      }
    });
    header.appendChild(refreshBtn);
  }
  root.appendChild(header);

  if (!account) {
    root.appendChild(
      el("div", { class: "connect-wrap" }, [
        el("div", { class: "connect-title", text: "Gmail 연결이 필요해요" }),
        el("p", { text: "Correo를 열어 Google 계정을 연결해주세요." }),
        (() => {
          const btn = el("button", { class: "btn primary", text: "Correo 열기" });
          btn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "openAsTab" }, () => window.close());
          });
          return btn;
        })(),
      ]),
    );
    return;
  }

  if (!cached) {
    root.appendChild(
      el("div", { class: "connect-wrap" }, [
        el("div", { class: "connect-title", text: "아직 동기화하지 않았어요" }),
        el("p", { text: "Correo를 열어 첫 동기화를 실행해주세요." }),
      ]),
    );
    renderActions(null);
    return;
  }

  const summary = cached.summary;
  const me = visible(summary.awaitingMyReply, prefs);
  const them = visible(summary.awaitingTheirReply, prefs);

  const plate = el("div", { class: "plate" });
  const meBtn = el("button", { class: me.length > 0 ? "accent" : "" }, [
    el("span", { class: "plate-n", text: String(me.length) }),
    el("span", { class: "plate-label", text: "내가 답할 메일" }),
  ]);
  meBtn.addEventListener("click", async () => {
    const ok = await openPanel("me");
    if (ok) window.close();
  });
  const themBtn = el("button", {}, [
    el("span", { class: "plate-n", text: String(them.length) }),
    el("span", { class: "plate-label", text: "답을 기다리는 메일" }),
  ]);
  themBtn.addEventListener("click", async () => {
    const ok = await openPanel("them");
    if (ok) window.close();
  });
  plate.appendChild(meBtn);
  plate.appendChild(themBtn);
  root.appendChild(plate);

  const oldest = [...me, ...them].sort((a, b) => (a.lastDateMs ?? 0) - (b.lastDateMs ?? 0)).slice(0, 2);
  if (oldest.length > 0) {
    const box = el("div", { class: "oldest" }, [el("div", { class: "oldest-title", text: "가장 오래 기다린 메일" })]);
    for (const t of oldest) {
      box.appendChild(
        el("div", { class: "oldest-row" }, [
          el("span", { class: "oldest-dtag", text: dtag(t.lastDateMs) }),
          el("span", { class: "oldest-subject", text: t.subject }),
        ]),
      );
    }
    root.appendChild(box);
  } else {
    root.appendChild(el("div", { class: "empty-hint", text: "처리할 메일이 없습니다." }));
  }

  renderActions(cached);
}

function renderActions(cached) {
  const actions = el("div", { class: "actions" });
  const panelBtn = el("button", { class: "btn primary", text: "패널 열기" });
  panelBtn.addEventListener("click", async () => {
    const ok = await openPanel();
    if (ok) {
      window.close();
    } else {
      showMsg("Gmail 탭에서만 사이드 패널을 열 수 있어요.");
    }
  });
  const tabBtn = el("button", { class: "btn secondary", text: "새 탭" });
  tabBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openAsTab" }, () => window.close());
  });
  actions.appendChild(panelBtn);
  actions.appendChild(tabBtn);
  root.appendChild(actions);

  if (cached) {
    const time = new Date(cached.syncedAtMs).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    root.appendChild(el("div", { class: "foot", text: `${time} 동기화 · 최근 ${cached.days}일` }));
  }
}

function showMsg(text) {
  const existing = document.querySelector(".msg");
  if (existing) existing.remove();
  const msg = el("div", { class: "msg", text });
  const actions = document.querySelector(".actions");
  if (actions) actions.after(msg);
  else root.appendChild(msg);
  setTimeout(() => msg.remove(), 2600);
}

void render();
