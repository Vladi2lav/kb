// ---------- константы и хранилище браузера ----------

const LEGACY_KEY = "kanban-v1"; // доска из прежней (локальной) версии
const LEGACY_DONE = "kanban-v1-imported";
const SESS_KEY = "kb-sessions"; // { [boardId]: { name, token, at } }
const COLORS = ["", "red", "orange", "yellow", "green", "blue", "purple"];
const COLOR_NAMES = { "": "Без цвета", red: "Красный", orange: "Оранжевый", yellow: "Жёлтый", green: "Зелёный", blue: "Синий", purple: "Фиолетовый" };
const MAX = { cards: 1000, columns: 12, text: 2000, colTitle: 40, name: 60, people: 50, personName: 40 };
const PEOPLE_COLORS = ["#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];
const POLL_MS = 5000;

const ls = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const sessions = () => ls.get(SESS_KEY, {});
function saveSession(id, name, token) {
  const s = sessions();
  s[id] = { name, token: token ?? s[id]?.token ?? null, at: Date.now() };
  ls.set(SESS_KEY, s);
}
function clearToken(id) {
  const s = sessions();
  if (s[id]) { s[id].token = null; ls.set(SESS_KEY, s); }
}
function forgetBoard(id) {
  const s = sessions();
  delete s[id];
  ls.set(SESS_KEY, s);
}

function legacy() {
  if (ls.get(LEGACY_DONE, null)) return null;
  const d = ls.get(LEGACY_KEY, null);
  return d && Array.isArray(d.cards) && d.cards.length ? d : null;
}

// ---------- утилиты ----------

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const clone = (x) => JSON.parse(JSON.stringify(x));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const cardsWord = (n) => `${n} ${plural(n, "карточка", "карточки", "карточек")}`;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value") el.value = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

// текст карточки со ссылками
function linkify(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    let url = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

async function api(method, path, body, token) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let r;
  try {
    r = await fetch(`/api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error("Нет связи с сервером");
    e.status = 0;
    throw e;
  }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(data.error || `Ошибка ${r.status}`);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

// ---------- тосты, поповеры ----------

function toast(text, action, ms = 5000) {
  const box = $("#toasts");
  const t = h("div", { class: "toast" }, h("span", {}, text));
  if (action) {
    t.append(h("button", { onclick: () => { action.fn(); t.remove(); } }, action.label));
  }
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

let popoverEl = null;
function closePopover() {
  if (popoverEl) { popoverEl.remove(); popoverEl = null; }
}
function popover(anchor, content) {
  closePopover();
  const p = h("div", { class: "popover" }, content);
  document.body.append(p);
  const r = anchor.getBoundingClientRect();
  const pw = p.offsetWidth;
  const left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
  p.style.left = left + window.scrollX + "px";
  p.style.top = r.bottom + 6 + window.scrollY + "px";
  popoverEl = p;
  return p;
}
function menu(anchor, items) {
  popover(anchor, items.filter(Boolean).map((it) =>
    h("button", { class: "menu-item" + (it.danger ? " danger" : ""), onclick: () => { closePopover(); it.fn(); } }, it.label)
  ));
}
document.addEventListener("pointerdown", (e) => {
  if (popoverEl && !popoverEl.contains(e.target) && !e.target.closest("[data-popover-anchor]")) closePopover();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopover(); });

// ---------- роутинг ----------

const app = $("#app");

function route() {
  closeBoard();
  closePopover();
  if (location.protocol === "file:") return renderFileMode();
  const m = location.hash.match(/^#\/b\/([a-zA-Z0-9_-]+)/);
  if (m) openBoard(m[1]);
  else renderHome();
}
window.addEventListener("hashchange", route);

function screen(...children) {
  app.replaceChildren(...children);
  window.scrollTo(0, 0);
}

// ---------- главная ----------

function renderHome() {
  document.title = "Kanban";
  const list = Object.entries(sessions()).sort((a, b) => b[1].at - a[1].at);
  const lg = legacy();
  screen(
    h("header", { class: "topbar" }, h("h1", {}, "Kanban")),
    h("main", { class: "home" },
      lg && h("div", { class: "notice" },
        `В этом браузере осталась доска из прошлой версии (${cardsWord(lg.cards.length)}). `,
        "Открой свою доску — карточки перенесутся."),
      list.length > 0 && h("section", { class: "panel" },
        h("h2", {}, "Мои доски"),
        h("ul", { class: "boards" }, list.map(([id, b]) =>
          h("li", {},
            h("a", { href: `#/b/${id}` },
              h("span", { class: "bn" }, b.name || id),
              !b.token && h("span", { class: "lock", title: "Нужен пароль" }, "🔒")),
            h("button", { class: "icon", title: "Убрать из списка", onclick: () => { forgetBoard(id); renderHome(); } }, "×"))
        ))),
      h("div", { class: "home-grid" }, openPanel(), createPanel())
    )
  );
}

function field(label, input) {
  return h("label", { class: "field" }, h("span", {}, label), input);
}

function openPanel() {
  const idInput = h("input", { name: "board", required: true, placeholder: "Ссылка или ID", autocomplete: "off" });
  const pwInput = h("input", { name: "password", type: "password", required: true, autocomplete: "current-password" });
  const err = h("p", { class: "error" });
  const btn = h("button", { class: "btn primary", type: "submit" }, "Открыть");
  return h("section", { class: "panel" },
    h("h2", {}, "Открыть доску"),
    h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const raw = idInput.value.trim();
        const id = (raw.match(/#\/b\/([a-zA-Z0-9_-]+)/) || [])[1] || raw;
        if (!/^[a-zA-Z0-9_-]{1,24}$/.test(id)) { err.textContent = "Не похоже на ссылку или ID доски"; return; }
        btn.disabled = true;
        try {
          const r = await api("POST", `boards/${id}/login`, { password: pwInput.value });
          saveSession(r.id, r.name, r.token);
          location.hash = `#/b/${r.id}`;
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      },
    },
      field("Доска", idInput),
      field("Пароль", pwInput),
      err, btn)
  );
}

// proof-of-work: запускается, когда человек начинает заполнять форму создания
let pow = null;
function startPow() {
  if (pow) return pow;
  const p = (async () => {
    const ch = await api("GET", "challenge");
    const startedAt = Date.now();
    const nonce = await new Promise((resolve, reject) => {
      const w = new Worker("pow-worker.js");
      w.onmessage = (e) => { w.terminate(); resolve(e.data); };
      w.onerror = () => { w.terminate(); reject(new Error("Не удалось пройти проверку")); };
      w.postMessage({ salt: ch.salt, bits: ch.bits });
    });
    return { id: ch.id, nonce, startedAt };
  })();
  pow = p;
  p.catch(() => { if (pow === p) pow = null; });
  return p;
}

function createPanel() {
  const name = h("input", { name: "name", required: true, maxlength: MAX.name, placeholder: "Например, «Ремонт»", autocomplete: "off" });
  const pw = h("input", { name: "password", type: "password", required: true, minlength: 6, autocomplete: "new-password" });
  const pw2 = h("input", { name: "password2", type: "password", required: true, minlength: 6, autocomplete: "new-password" });
  // honeypot — невидимое поле, его заполняют только боты
  const trap = h("input", { name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
  const status = h("p", { class: "muted small" }, "Пароль понадобится, чтобы открыть доску с другого устройства.");
  const err = h("p", { class: "error" });
  const btn = h("button", { class: "btn primary", type: "submit" }, "Создать");

  const warm = () => {
    startPow().then(() => { status.textContent = "Проверка «не бот» пройдена ✓"; })
      .catch((e) => { status.textContent = e.message; });
  };

  const form = h("form", {
    onfocusin: warm,
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (pw.value !== pw2.value) { err.textContent = "Пароли не совпадают"; return; }
      btn.disabled = true;
      btn.textContent = "Проверка…";
      try {
        const ch = await startPow();
        pow = null; // челлендж одноразовый
        const wait = 3200 - (Date.now() - ch.startedAt);
        if (wait > 0) await sleep(wait);
        btn.textContent = "Создаю…";
        const r = await api("POST", "boards", {
          name: name.value, password: pw.value, website: trap.value,
          challenge: { id: ch.id, nonce: ch.nonce },
        });
        saveSession(r.id, r.name, r.token);
        location.hash = `#/b/${r.id}`;
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = "Создать";
        pow = null;
        if (ex.status !== 429) warm();
      }
    },
  },
    field("Название", name),
    field("Пароль", pw),
    field("Пароль ещё раз", pw2),
    h("label", { class: "trap" }, "Не заполняйте", trap),
    status, err, btn);

  return h("section", { class: "panel" }, h("h2", {}, "Новая доска"), form);
}

function renderLogin(id, name, message) {
  document.title = "Вход · Kanban";
  const pwInput = h("input", { type: "password", required: true, autocomplete: "current-password", autofocus: true });
  const err = h("p", { class: "error" }, message || "");
  const btn = h("button", { class: "btn primary", type: "submit" }, "Войти");
  screen(
    h("header", { class: "topbar" }, h("a", { class: "back", href: "#/", title: "Все доски" }, "←"), h("h1", {}, "Kanban")),
    h("main", { class: "home narrow" },
      h("section", { class: "panel" },
        h("h2", {}, name ? `Доска «${name}»` : "Вход на доску"),
        h("p", { class: "muted small" }, `ID: ${id}`),
        h("form", {
          onsubmit: async (e) => {
            e.preventDefault();
            btn.disabled = true;
            err.textContent = "";
            try {
              const r = await api("POST", `boards/${id}/login`, { password: pwInput.value });
              saveSession(r.id, r.name, r.token);
              openBoard(id);
            } catch (ex) {
              err.textContent = ex.message;
              btn.disabled = false;
            }
          },
        }, field("Пароль", pwInput), err, btn)))
  );
  pwInput.focus();
}

function renderFileMode() {
  const lg = ls.get(LEGACY_KEY, null);
  const n = lg?.cards?.length || 0;
  screen(
    h("header", { class: "topbar" }, h("h1", {}, "Kanban")),
    h("main", { class: "home narrow" },
      h("section", { class: "panel" },
        h("h2", {}, "Доске теперь нужен сервер"),
        h("p", {}, "Доски хранятся на сервере и защищены паролем. Запусти в папке проекта:"),
        h("pre", {}, "npm start"),
        h("p", {}, "и открой ", h("a", { href: "http://localhost:3000" }, "http://localhost:3000"), "."),
        n > 0 && h("div", { class: "notice" },
          h("p", {}, `В этом браузере лежит старая доска (${cardsWord(n)}). Скачай её и загрузи на новую доску через меню ⋯ → «Импорт из JSON».`),
          h("button", { class: "btn primary", onclick: () => download("kanban-old.json", lg) }, "Скачать старую доску")))
    )
  );
}

// ---------- доска ----------

let B = null; // текущая открытая доска

async function openBoard(id) {
  const sess = sessions()[id];
  if (!sess?.token) return renderLogin(id, sess?.name);
  screen(h("main", { class: "home narrow" }, h("p", { class: "muted" }, "Загрузка…")));
  let data;
  try {
    data = await api("GET", `boards/${id}`, null, sess.token);
  } catch (e) {
    if (e.status === 401) { clearToken(id); return renderLogin(id, sess.name); }
    return screen(
      h("header", { class: "topbar" }, h("a", { class: "back", href: "#/" }, "←"), h("h1", {}, "Kanban")),
      h("main", { class: "home narrow" }, h("p", { class: "error" }, e.message),
        h("button", { class: "btn", onclick: () => openBoard(id) }, "Повторить")));
  }
  if (location.hash !== `#/b/${id}`) return; // пока грузили, ушли на другую страницу

  saveSession(id, data.name, sess.token);
  B = {
    id, token: sess.token, name: data.name, version: data.version,
    columns: data.columns, people: data.people || [], cards: data.cards,
    base: clone({ columns: data.columns, people: data.people || [], cards: data.cards }),
    dirty: false, saving: false, failures: 0, importDone: false,
    editing: 0, dragging: false, needsRender: false, query: "",
    timer: null, poll: setInterval(poll, POLL_MS),
  };
  renderBoardShell();

  const lg = legacy();
  if (lg && data.importLegacy) {
    const n = importCards(lg.cards, lg.people);
    B.importDone = true;
    ls.set(LEGACY_DONE, id);
    toast(`Перенёс ${cardsWord(n)} из старой доски`);
  } else if (lg) {
    showLegacyBanner(lg);
  }
}

function closeBoard() {
  if (!B) return;
  if (B.dirty) flush();
  clearInterval(B.poll);
  clearTimeout(B.timer);
  B = null;
}

function kick() {
  const { id, name } = B;
  closeBoard();
  clearToken(id);
  renderLogin(id, name, "Сессия закончилась или пароль изменили — войди снова");
}

function renderBoardShell() {
  document.title = `${B.name} · Kanban`;
  const search = h("input", {
    class: "search", type: "search", placeholder: "Поиск", value: B.query,
    oninput: (e) => { B.query = e.target.value; applyFilter(); },
  });
  screen(
    h("header", { class: "topbar" },
      h("a", { class: "back", href: "#/", title: "Все доски" }, "←"),
      h("h1", { class: "bname", title: "Настройки доски", onclick: openSettings }, B.name),
      h("span", { id: "sync", class: "sync" }),
      h("div", { class: "spacer" }),
      search,
      h("button", { class: "btn share-btn", onclick: share }, "Поделиться"),
      h("button", { class: "icon big", title: "Меню", "data-popover-anchor": true, onclick: (e) => boardMenu(e.currentTarget) }, "⋯")),
    h("div", { id: "team", class: "team" }),
    h("div", { id: "banner" }),
    h("main", { id: "board" })
  );
  setSync("saved");
  renderBoard();
}

function setSync(state) {
  const el = $("#sync");
  if (!el) return;
  const text = { saved: "Сохранено", pending: "Сохранение…", saving: "Сохранение…", offline: "Нет связи — повторю" }[state];
  el.textContent = text;
  el.dataset.state = state;
}

function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.dataset?.focusKey) return null;
  return { key: a.dataset.focusKey, value: a.value, start: a.selectionStart, end: a.selectionEnd };
}
function restoreFocus(f) {
  if (!f) return;
  const el = $(`[data-focus-key="${CSS.escape(f.key)}"]`);
  if (!el) return;
  el.value = f.value;
  el.focus();
  try { el.setSelectionRange(f.start, f.end); } catch {}
  autoGrow(el);
}

function renderBoard() {
  if (!B) return;
  if (B.editing) { B.needsRender = true; return; }
  B.needsRender = false;
  closePopover();
  const board = $("#board");
  if (!board) return;
  const focus = captureFocus();
  const scroll = board.scrollLeft;
  const title = $(".topbar .bname");
  if (title) title.textContent = B.name;
  document.title = `${B.name} · Kanban`;
  renderTeam();
  board.replaceChildren(
    ...B.columns.map(renderColumn),
    B.columns.length < MAX.columns && h("button", { class: "add-col", onclick: addColumn }, "+ Колонка")
  );
  board.scrollLeft = scroll;
  applyFilter();
  restoreFocus(focus);
}

function renderColumn(col) {
  const cards = B.cards.filter((c) => c.col === col.id);
  const title = h("span", { class: "title", title: "Двойной клик — переименовать" }, col.title);
  title.addEventListener("dblclick", () => renameColumn(col.id));

  const ta = h("textarea", {
    rows: 1, placeholder: "+ Новая задача", maxlength: MAX.text,
    dataset: { focusKey: `add:${col.id}` },
    oninput: () => autoGrow(ta),
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { ta.value = ""; autoGrow(ta); ta.blur(); }
    },
  });
  function submit() {
    const text = ta.value.trim();
    if (!text) return;
    if (B.cards.length >= MAX.cards) return toast(`На доске не больше ${MAX.cards} карточек`);
    B.cards.push({ id: uid(), col: col.id, text, color: "", members: [], lead: null });
    ta.value = "";
    mutate();
  }

  return h("section", { class: "column", dataset: { col: col.id } },
    h("div", { class: "col-head" },
      title,
      h("span", { class: "count" }, cards.length || ""),
      h("button", { class: "icon", title: "Действия с колонкой", "data-popover-anchor": true, onclick: (e) => columnMenu(col.id, e.currentTarget) }, "⋯")),
    h("ul", { class: "cards" }, cards.map(renderCard)),
    h("div", { class: "add" }, ta)
  );
}

function renderCard(card) {
  const li = h("li", { class: "card" + (card.color ? ` c-${card.color}` : ""), dataset: { id: card.id } });
  const text = h("div", { class: "text" }, linkify(card.text));
  text.addEventListener("dblclick", (e) => { if (!e.target.closest("a")) editCard(card.id); });
  const top = h("div", { class: "card-top" },
    text,
    h("div", { class: "actions" },
      h("button", { class: "icon swatch-btn", title: "Цвет", "data-popover-anchor": true, onclick: (e) => colorMenu(card.id, e.currentTarget) }, h("span", { class: "dot" })),
      h("button", { class: "icon people-btn", title: "Назначить людей", "data-popover-anchor": true, onclick: () => peoplePicker(card.id) }, "👤"),
      h("button", { class: "icon", title: "Изменить", onclick: () => editCard(card.id) }, "✎"),
      h("button", { class: "icon", title: "Удалить", onclick: () => deleteCard(card.id) }, "×")));
  li.append(top);
  // люди на карточке: главный первым
  const ids = [...card.members].sort((a, b) => (b === card.lead) - (a === card.lead));
  const people = ids.map(findPerson).filter(Boolean);
  if (people.length) {
    li.append(h("div", { class: "card-foot", title: "Назначить людей", onclick: () => peoplePicker(card.id) },
      people.map((p) => avatar(p, { lead: p.id === card.lead }))));
  }
  li.addEventListener("pointerdown", (e) => dragStart(e, li));
  li.addEventListener("contextmenu", (e) => { if (drag) e.preventDefault(); });
  return li;
}

function applyFilter() {
  if (!B) return;
  const q = B.query.trim().toLowerCase();
  const text = new Map(B.cards.map((c) => [c.id, [c.text, ...c.members.map((id) => findPerson(id)?.name || "")].join(" ").toLowerCase()]));
  $("#board")?.classList.toggle("filtering", !!q);
  for (const li of $$("#board .card")) li.hidden = !!q && !text.get(li.dataset.id)?.includes(q);
}

// ---------- изменения ----------

function mutate() {
  renderBoard();
  scheduleSave();
}

const findCard = (id) => B.cards.find((c) => c.id === id);
const findCol = (id) => B.columns.find((c) => c.id === id);
const findPerson = (id) => B.people.find((p) => p.id === id);

// ---------- команда ----------

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function avatar(p, { lead = false, small = false } = {}) {
  return h("span", {
    class: "avatar" + (small ? " sm" : "") + (lead ? " lead" : ""),
    style: `background:${p.color}`,
    title: p.name + (lead ? " — главный" : ""),
  }, initials(p.name));
}

function nextColor() {
  const used = new Set(B.people.map((p) => p.color));
  return PEOPLE_COLORS.find((c) => !used.has(c)) || PEOPLE_COLORS[B.people.length % PEOPLE_COLORS.length];
}

function addPerson(name) {
  name = name.trim().slice(0, MAX.personName);
  if (!name) return null;
  if (B.people.length >= MAX.people) { toast(`Не больше ${MAX.people} участников`); return null; }
  const p = { id: uid(), name, color: nextColor() };
  B.people.push(p);
  return p;
}

function removePerson(id) {
  const p = findPerson(id);
  if (!p || !confirm(`Убрать ${p.name} из команды?`)) return;
  B.people = B.people.filter((x) => x.id !== id);
  for (const c of B.cards) {
    c.members = c.members.filter((m) => m !== id);
    if (c.lead === id) c.lead = null;
  }
  mutate();
}

function renderTeam() {
  const team = $("#team");
  if (!team) return;
  const input = h("input", {
    placeholder: "+ Участник", maxlength: MAX.personName, autocomplete: "off",
    dataset: { focusKey: "add-person" },
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        if (addPerson(input.value)) { input.value = ""; mutate(); }
      }
      if (e.key === "Escape") { input.value = ""; input.blur(); }
    },
  });
  team.replaceChildren(
    ...B.people.map((p) => h("span", { class: "chip" },
      avatar(p, { small: true }), p.name,
      h("button", { class: "chip-del", title: "Убрать из команды", onclick: () => removePerson(p.id) }, "×"))),
    input
  );
}

// выбор людей для карточки, ★ — главный
function peoplePicker(cardId) {
  const card = findCard(cardId);
  const anchor = $(`#board .card[data-id="${CSS.escape(cardId)}"] .people-btn`);
  if (!card || !anchor) return;
  const reopen = () => { mutate(); peoplePicker(cardId); };

  const rows = B.people.map((p) => {
    const on = card.members.includes(p.id);
    const isLead = card.lead === p.id;
    return h("div", { class: "picker-row" },
      h("label", {},
        h("input", {
          type: "checkbox", checked: on,
          onchange: (e) => {
            if (e.target.checked) card.members.push(p.id);
            else {
              card.members = card.members.filter((m) => m !== p.id);
              if (card.lead === p.id) card.lead = null;
            }
            reopen();
          },
        }),
        avatar(p, { small: true }), p.name),
      h("button", {
        class: "star" + (isLead ? " on" : ""), title: isLead ? "Снять главного" : "Сделать главным",
        onclick: () => {
          if (isLead) card.lead = null;
          else {
            card.lead = p.id;
            if (!card.members.includes(p.id)) card.members.push(p.id);
          }
          reopen();
        },
      }, isLead ? "★" : "☆"));
  });

  const input = h("input", {
    class: "picker-add", placeholder: "+ Новый участник", maxlength: MAX.personName, autocomplete: "off",
    onkeydown: (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const p = addPerson(input.value);
      if (!p) return;
      card.members.push(p.id);
      reopen();
      $(".popover .picker-add")?.focus();
    },
  });

  popover(anchor, h("div", { class: "picker" },
    h("p", { class: "picker-hint" }, B.people.length ? "Отметь участников, ★ — главный" : "В команде пока никого нет"),
    rows, input));
}

function editCard(id) {
  const card = findCard(id);
  const li = $(`#board .card[data-id="${CSS.escape(id)}"]`);
  if (!card || !li || li.classList.contains("editing")) return;
  B.editing++;
  const b = B;
  const ta = h("textarea", { class: "edit", value: card.text, maxlength: MAX.text });
  li.classList.add("editing");
  li.replaceChildren(ta, h("p", { class: "hint" }, "Enter — сохранить, Shift+Enter — новая строка, Esc — отмена"));
  autoGrow(ta);
  ta.focus();
  ta.select();
  let done = false;
  const finish = (save) => {
    if (done || B !== b) return;
    done = true;
    b.editing--;
    const c = findCard(id);
    const v = ta.value.trim();
    if (save && c && !v) return deleteCard(id);
    if (save && c && v !== c.text) { c.text = v; mutate(); }
    else renderBoard();
  };
  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.stopPropagation(); finish(false); }
  });
  ta.addEventListener("blur", () => finish(true));
}

function deleteCard(id) {
  const b = B;
  const idx = b.cards.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const [removed] = b.cards.splice(idx, 1);
  mutate();
  toast("Карточка удалена", {
    label: "Отменить",
    fn: () => {
      if (B !== b || findCard(removed.id)) return;
      const col = findCol(removed.col) ? removed.col : b.columns[0].id;
      b.cards.splice(Math.min(idx, b.cards.length), 0, { ...removed, col });
      mutate();
    },
  });
}

function colorMenu(id, anchor) {
  const card = findCard(id);
  if (!card) return;
  popover(anchor, h("div", { class: "swatches" }, COLORS.map((c) =>
    h("button", {
      class: `swatch c-${c || "none"}` + (card.color === c ? " active" : ""), title: COLOR_NAMES[c],
      onclick: () => { closePopover(); card.color = c; mutate(); },
    })
  )));
}

function renameColumn(colId, selectAll) {
  const col = findCol(colId);
  const el = $(`#board .column[data-col="${CSS.escape(colId)}"] .title`);
  if (!col || !el) return;
  B.editing++;
  const b = B;
  const input = h("input", { class: "col-edit", value: col.title, maxlength: MAX.colTitle });
  el.replaceWith(input);
  input.focus();
  if (selectAll !== false) input.select();
  let done = false;
  const finish = (save) => {
    if (done || B !== b) return;
    done = true;
    b.editing--;
    const v = input.value.trim();
    const c = findCol(colId);
    if (save && c && v && v !== c.title) { c.title = v; mutate(); }
    else renderBoard();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function addColumn() {
  if (B.columns.length >= MAX.columns) return toast(`Не больше ${MAX.columns} колонок`);
  const id = uid();
  B.columns.push({ id, title: "Новая колонка" });
  mutate();
  renameColumn(id);
}

function columnMenu(colId, anchor) {
  const i = B.columns.findIndex((c) => c.id === colId);
  const col = B.columns[i];
  const n = B.cards.filter((c) => c.col === colId).length;
  const move = (d) => {
    const [c] = B.columns.splice(i, 1);
    B.columns.splice(i + d, 0, c);
    mutate();
  };
  menu(anchor, [
    { label: "Переименовать", fn: () => renameColumn(colId) },
    i > 0 && { label: "← Сдвинуть влево", fn: () => move(-1) },
    i < B.columns.length - 1 && { label: "Сдвинуть вправо →", fn: () => move(1) },
    n > 0 && {
      label: "Удалить все карточки", danger: true,
      fn: () => { if (confirm(`Удалить ${cardsWord(n)} из «${col.title}»?`)) { B.cards = B.cards.filter((c) => c.col !== colId); mutate(); } },
    },
    B.columns.length > 1 && {
      label: "Удалить колонку", danger: true,
      fn: () => {
        if (n && !confirm(`Удалить колонку «${col.title}» вместе с ${cardsWord(n)}?`)) return;
        B.columns = B.columns.filter((c) => c.id !== colId);
        B.cards = B.cards.filter((c) => c.col !== colId);
        mutate();
      },
    },
  ]);
}

function importCards(list, people = []) {
  // участники из источника: по id, иначе по имени
  const personMap = new Map();
  for (const p of Array.isArray(people) ? people : []) {
    const name = String(p?.name ?? "").trim().slice(0, MAX.personName);
    if (!name || typeof p.id !== "string") continue;
    let existing = findPerson(p.id) || B.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!existing && B.people.length < MAX.people) {
      existing = { id: /^[a-zA-Z0-9_-]{1,24}$/.test(p.id) ? p.id : uid(), name, color: /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : nextColor() };
      B.people.push(existing);
    }
    if (existing) personMap.set(p.id, existing.id);
  }
  const known = new Set(B.cards.map((c) => c.id));
  let n = 0;
  for (const c of list) {
    if (B.cards.length >= MAX.cards) break;
    const text = String(c?.text ?? "").trim().slice(0, MAX.text);
    if (!text) continue;
    let id = typeof c.id === "string" && /^[a-zA-Z0-9_-]{1,24}$/.test(c.id) ? c.id : uid();
    if (known.has(id)) id = uid();
    known.add(id);
    const col = findCol(c.col) ? c.col : B.columns[0].id;
    const members = [...new Set((Array.isArray(c.members) ? c.members : []).map((m) => personMap.get(m)).filter(Boolean))];
    const lead = personMap.get(c.lead);
    B.cards.push({ id, col, text, color: COLORS.includes(c.color) ? c.color : "", members, lead: members.includes(lead) ? lead : null });
    n++;
  }
  if (n || personMap.size) mutate();
  return n;
}

function showLegacyBanner(lg) {
  const banner = $("#banner");
  banner.replaceChildren(h("div", { class: "notice row" },
    h("span", {}, `В этом браузере осталась доска из прошлой версии (${cardsWord(lg.cards.length)}).`),
    h("button", { class: "btn primary", onclick: () => {
      const n = importCards(lg.cards, lg.people);
      ls.set(LEGACY_DONE, B.id);
      banner.replaceChildren();
      toast(`Перенёс ${cardsWord(n)}`);
    } }, "Перенести сюда"),
    h("button", { class: "btn", onclick: () => { ls.set(LEGACY_DONE, "dismissed"); banner.replaceChildren(); } }, "Не нужно")));
}

// ---------- синхронизация ----------

function scheduleSave(delay = 400) {
  B.dirty = true;
  setSync("pending");
  clearTimeout(B.timer);
  B.timer = setTimeout(flush, delay);
}

async function flush() {
  const b = B;
  if (!b || b.saving || !b.dirty) return;
  b.saving = true;
  b.dirty = false;
  setSync("saving");
  const snap = clone({ columns: b.columns, people: b.people, cards: b.cards });
  let retry = 50;
  try {
    const r = await api("PUT", `boards/${b.id}`, { version: b.version, ...snap, importDone: b.importDone || undefined }, b.token);
    b.version = r.version;
    b.base = snap;
    b.importDone = false;
    b.failures = 0;
  } catch (e) {
    if (B !== b) return;
    if (e.status === 409 && e.data?.board) {
      mergeRemote(e.data.board);
      b.dirty = true;
    } else if (e.status === 401) {
      b.saving = false;
      return kick();
    } else if (e.status === 400 || e.status === 413) {
      toast(`Не сохранилось: ${e.message}`);
      b.columns = clone(b.base.columns);
      b.people = clone(b.base.people);
      b.cards = clone(b.base.cards);
      renderBoard();
    } else {
      b.dirty = true;
      b.failures++;
      retry = Math.min(30000, 1000 * 2 ** b.failures);
    }
  } finally {
    b.saving = false;
  }
  if (B !== b) return;
  if (b.dirty) {
    setSync(b.failures ? "offline" : "pending");
    clearTimeout(b.timer);
    b.timer = setTimeout(flush, retry);
  } else {
    setSync("saved");
  }
}

// трёхсторонний merge: base — последняя общая версия, local — наши правки, remote — сервер
function mergeList(base, local, remote) {
  const key = (x) => JSON.stringify(x);
  const B0 = new Map(base.map((x) => [x.id, x]));
  const L = new Map(local.map((x) => [x.id, x]));
  const R = new Map(remote.map((x) => [x.id, x]));
  const out = [];
  for (const l of local) {
    const b = B0.get(l.id), r = R.get(l.id);
    if (!b) out.push(l); // добавлено у нас
    else if (!r) { if (key(l) !== key(b)) out.push(l); } // удалено там; оставим, если мы правили
    else out.push(key(l) === key(b) ? r : l);
  }
  for (const r of remote) if (!B0.has(r.id) && !L.has(r.id)) out.push(r); // добавлено там
  return out;
}

function mergeRemote(remote) {
  const b = B;
  const columns = mergeList(b.base.columns, b.columns, remote.columns);
  if (!columns.length) columns.push(...remote.columns);
  const colIds = new Set(columns.map((c) => c.id));
  b.columns = columns;
  const people = mergeList(b.base.people, b.people, remote.people || []);
  const personIds = new Set(people.map((p) => p.id));
  b.people = people;
  b.cards = mergeList(b.base.cards, b.cards, remote.cards).map((c) => {
    const members = c.members.filter((id) => personIds.has(id));
    return {
      ...c,
      col: colIds.has(c.col) ? c.col : columns[0].id,
      members,
      lead: members.includes(c.lead) ? c.lead : null,
    };
  });
  b.base = clone({ columns: remote.columns, people: remote.people || [], cards: remote.cards });
  b.version = remote.version;
  b.name = remote.name;
  renderBoard();
}

async function poll() {
  const b = B;
  if (!b || document.hidden || b.dirty || b.saving || b.editing || b.dragging) return;
  try {
    const r = await api("GET", `boards/${b.id}?v=${b.version}`, null, b.token);
    if (B !== b || r.unchanged || b.dirty || b.saving || b.editing || b.dragging) return;
    Object.assign(b, { version: r.version, name: r.name, columns: r.columns, people: r.people || [], cards: r.cards });
    b.base = clone({ columns: r.columns, people: b.people, cards: r.cards });
    saveSession(b.id, b.name);
    renderBoard();
    setSync("saved");
  } catch (e) {
    if (B !== b) return;
    if (e.status === 401) kick();
    else if (e.status === 0) setSync("offline");
  }
}

document.addEventListener("visibilitychange", () => {
  if (!B) return;
  if (document.hidden) flush();
  else poll();
});
window.addEventListener("beforeunload", (e) => {
  if (B && (B.dirty || B.saving)) { flush(); e.preventDefault(); e.returnValue = ""; }
});

// ---------- перетаскивание (мышь и тач) ----------

let drag = null;

function dragStart(e, li) {
  if (e.button !== 0 || !B || B.editing || drag) return;
  if (e.target.closest(".actions, a, textarea, input")) return;
  const touch = e.pointerType !== "mouse";
  drag = { li, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, touch, active: false };
  if (touch) drag.timer = setTimeout(activateDrag, 280); // на телефоне — долгое нажатие
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragEnd);
}

function activateDrag() {
  if (!drag || !B) return;
  const r = drag.li.getBoundingClientRect();
  drag.dx = drag.x0 - r.left;
  drag.dy = drag.y0 - r.top;
  const g = drag.li.cloneNode(true);
  g.classList.add("ghost");
  g.style.width = r.width + "px";
  document.body.append(g);
  drag.ghost = g;
  drag.li.classList.add("placeholder");
  document.body.classList.add("is-dragging");
  drag.active = true;
  B.dragging = true;
  closePopover();
  window.getSelection()?.removeAllRanges();
  if (drag.touch && navigator.vibrate) navigator.vibrate(10);
  moveGhost();
  autoScroll();
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.active) {
    const dist = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
    if (drag.touch) { if (dist > 10) endDrag(); return; } // это скролл, а не перетаскивание
    if (dist < 5) return;
    activateDrag();
  }
  e.preventDefault();
  moveGhost();
  placeAt(drag.x, drag.y);
}

function moveGhost() {
  drag.ghost.style.transform = `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px) rotate(2deg)`;
}

function placeAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const col = el?.closest(".column");
  $$("#board .column.over").forEach((c) => c !== col && c.classList.remove("over"));
  if (!col) return;
  col.classList.add("over");
  const list = $(".cards", col);
  const after = $$(".card:not(.placeholder)", list)
    .filter((c) => !c.hidden)
    .find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  if (after) { if (after.previousElementSibling !== drag.li) list.insertBefore(drag.li, after); }
  else if (list.lastElementChild !== drag.li) list.append(drag.li);
}

function autoScroll() {
  if (!drag?.active) return;
  const board = $("#board");
  const edge = 60;
  let moved = false;
  if (drag.y < edge) { window.scrollBy(0, -12); moved = true; }
  else if (drag.y > innerHeight - edge) { window.scrollBy(0, 12); moved = true; }
  if (board) {
    const r = board.getBoundingClientRect();
    if (drag.x < r.left + edge && board.scrollLeft > 0) { board.scrollLeft -= 14; moved = true; }
    else if (drag.x > r.right - edge) { board.scrollLeft += 14; moved = true; }
  }
  if (moved) placeAt(drag.x, drag.y);
  requestAnimationFrame(autoScroll);
}

function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  endDrag();
}

function endDrag() {
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
  if (!d.active) return;
  d.ghost.remove();
  d.li.classList.remove("placeholder");
  document.body.classList.remove("is-dragging");
  $$("#board .column.over").forEach((c) => c.classList.remove("over"));
  if (!B) return;
  B.dragging = false;
  commitOrder();
}

// не даём странице скроллиться, пока тащим карточку пальцем
document.addEventListener("touchmove", (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });

// порядок из DOM обратно в состояние
function commitOrder() {
  const byId = new Map(B.cards.map((c) => [c.id, c]));
  const next = [];
  for (const colEl of $$("#board .column")) {
    for (const li of $$(".card", colEl)) {
      const c = byId.get(li.dataset.id);
      if (!c) continue;
      next.push(c.col === colEl.dataset.col ? c : { ...c, col: colEl.dataset.col });
      byId.delete(c.id);
    }
  }
  next.push(...byId.values());
  const changed = next.some((c, i) => c !== B.cards[i]);
  B.cards = next;
  if (changed) mutate();
  else renderBoard();
}

// ---------- меню доски, настройки ----------

function boardLink(id) {
  return `${location.origin}${location.pathname}#/b/${id}`;
}

async function share() {
  const link = boardLink(B.id);
  try {
    await navigator.clipboard.writeText(link);
    toast("Ссылка скопирована. Пароль передай отдельно");
  } catch {
    prompt("Ссылка на доску (пароль передай отдельно):", link);
  }
}

function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importFromFile() {
  const input = h("input", { type: "file", accept: "application/json,.json" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      // колонки из файла сопоставляем по названию
      const titleById = new Map((data.columns || []).map((c) => [c.id, String(c.title).toLowerCase()]));
      const colByTitle = new Map(B.columns.map((c) => [c.title.toLowerCase(), c.id]));
      const cards = (data.cards || []).map((c) => ({ ...c, col: findCol(c.col) ? c.col : colByTitle.get(titleById.get(c.col)) }));
      toast(`Импортировано: ${cardsWord(importCards(cards, data.people))}`);
    } catch {
      toast("Не получилось прочитать файл");
    }
  });
  input.click();
}

function boardMenu(anchor) {
  menu(anchor, [
    { label: "Скопировать ссылку", fn: share },
    { label: "Настройки доски", fn: openSettings },
    { label: "Экспорт в JSON", fn: () => download(`${B.name}.json`, { name: B.name, columns: B.columns, people: B.people, cards: B.cards, exportedAt: new Date().toISOString() }) },
    { label: "Импорт из JSON", fn: importFromFile },
    { label: "Выйти с этой доски", fn: () => { const id = B.id; closeBoard(); clearToken(id); location.hash = "#/"; } },
  ]);
}

function openSettings() {
  const b = B;
  const name = h("input", { value: b.name, required: true, maxlength: MAX.name });
  const pw = h("input", { type: "password", minlength: 6, autocomplete: "new-password", placeholder: "Оставь пустым, чтобы не менять" });
  const pw2 = h("input", { type: "password", minlength: 6, autocomplete: "new-password" });
  const current = h("input", { type: "password", required: true, autocomplete: "current-password" });
  const err = h("p", { class: "error" });
  const dlg = h("dialog", { class: "dlg" });
  const close = () => dlg.close();

  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (pw.value && pw.value !== pw2.value) { err.textContent = "Новые пароли не совпадают"; return; }
      const body = { current: current.value };
      if (name.value.trim() !== b.name) body.name = name.value;
      if (pw.value) body.password = pw.value;
      try {
        const r = await api("POST", `boards/${b.id}/settings`, body, b.token);
        b.token = r.token;
        b.name = r.name;
        saveSession(b.id, r.name, r.token);
        renderBoard();
        close();
        toast(body.password ? "Пароль изменён. На других устройствах нужно войти заново" : "Сохранено");
        poll();
      } catch (ex) {
        if (ex.status === 401 && /войти/.test(ex.message)) { close(); return kick(); }
        err.textContent = ex.message;
      }
    },
  },
    h("h2", {}, "Настройки доски"),
    field("Название", name),
    field("Новый пароль", pw),
    field("Новый пароль ещё раз", pw2),
    field("Текущий пароль", current),
    err,
    h("div", { class: "row end" },
      h("button", { class: "btn", type: "button", onclick: close }, "Отмена"),
      h("button", { class: "btn primary", type: "submit" }, "Сохранить")),
    h("hr"),
    h("div", { class: "row" },
      h("span", { class: "muted small grow" }, "Удаление нельзя отменить. Нужен текущий пароль."),
      h("button", {
        class: "btn danger", type: "button",
        onclick: async () => {
          err.textContent = "";
          if (!current.value) { err.textContent = "Введи текущий пароль"; current.focus(); return; }
          if (!confirm(`Удалить доску «${b.name}» навсегда?`)) return;
          try {
            await api("POST", `boards/${b.id}/delete`, { password: current.value }, b.token);
            close();
            closeBoard();
            forgetBoard(b.id);
            location.hash = "#/";
            toast("Доска удалена");
          } catch (ex) {
            err.textContent = ex.message;
          }
        },
      }, "Удалить доску"))
  );
  dlg.append(form);
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// горячая клавиша: / — поиск
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && B && !e.target.closest("input, textarea, [contenteditable]")) {
    e.preventDefault();
    $(".search")?.focus();
  }
});

route();
