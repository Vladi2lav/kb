const STORAGE_KEY = "kanban-v1";

const COLUMNS = [
  { id: "todo", title: "Сделать" },
  { id: "doing", title: "В работе" },
  { id: "done", title: "Готово" },
];

const COLORS = ["#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

let state = load();

function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch {}
  if (!s || !s.cards) {
    s = {
      cards: [
        { id: uid(), col: "todo", text: "Перетащи меня в соседнюю колонку" },
        { id: uid(), col: "todo", text: "Двойной клик — редактировать" },
        { id: uid(), col: "doing", text: "Залить на Vercel" },
      ],
    };
  }
  // миграция старых данных
  s.people = s.people || [];
  for (const c of s.cards) {
    c.members = c.members || [];
    c.lead = c.lead || null;
  }
  return s;
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function person(id) {
  return state.people.find((p) => p.id === id);
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function avatar(p, { lead = false, size = "" } = {}) {
  const el = document.createElement("span");
  el.className = `avatar ${size} ${lead ? "lead" : ""}`;
  el.style.background = p.color;
  el.textContent = initials(p.name);
  el.title = p.name + (lead ? " — главный" : "");
  return el;
}

const board = document.getElementById("board");
const tpl = document.getElementById("column-tpl");
const peopleEl = document.getElementById("people");
const picker = document.getElementById("picker");
let draggedId = null;
let pickerFor = null; // id карточки, для которой открыт выбор людей

/* ---------- команда ---------- */

function renderPeople() {
  peopleEl.innerHTML = "";
  for (const p of state.people) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(avatar(p, { size: "sm" }), document.createTextNode(p.name));

    const del = document.createElement("button");
    del.className = "chip-del";
    del.textContent = "×";
    del.title = "Убрать из команды";
    del.addEventListener("click", () => {
      if (!confirm(`Убрать ${p.name} из команды?`)) return;
      state.people = state.people.filter((x) => x.id !== p.id);
      for (const c of state.cards) {
        c.members = c.members.filter((m) => m !== p.id);
        if (c.lead === p.id) c.lead = null;
      }
      save();
      renderAll();
    });

    chip.append(del);
    peopleEl.append(chip);
  }
}

document.getElementById("add-person").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = e.target.name;
  const name = input.value.trim();
  if (!name) return;
  state.people.push({ id: uid(), name, color: COLORS[state.people.length % COLORS.length] });
  input.value = "";
  save();
  renderAll();
});

/* ---------- доска ---------- */

function render() {
  board.innerHTML = "";
  for (const col of COLUMNS) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const list = node.querySelector(".cards");
    const cards = state.cards.filter((c) => c.col === col.id);

    node.dataset.col = col.id;
    node.querySelector(".title").textContent = col.title;
    node.querySelector(".count").textContent = cards.length || "";

    for (const card of cards) list.appendChild(renderCard(card));

    node.querySelector(".add").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = e.target.text.value.trim();
      if (!text) return;
      state.cards.push({ id: uid(), col: col.id, text, members: [], lead: null });
      save();
      render();
      board.querySelector(`[data-col="${col.id}"] input`).focus();
    });

    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      node.classList.add("over");
      const dragging = board.querySelector(".dragging");
      if (!dragging) return;
      const after = cardAfter(list, e.clientY);
      if (after) list.insertBefore(dragging, after);
      else list.appendChild(dragging);
    });
    node.addEventListener("dragleave", (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove("over");
    });
    node.addEventListener("drop", (e) => {
      e.preventDefault();
      node.classList.remove("over");
      commitOrder();
    });

    board.appendChild(node);
  }
}

function renderCard(card) {
  const li = document.createElement("li");
  li.className = "card";
  li.draggable = true;
  li.dataset.id = card.id;

  const top = document.createElement("div");
  top.className = "card-top";

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = card.text;

  const del = document.createElement("button");
  del.className = "del";
  del.title = "Удалить";
  del.textContent = "×";
  del.addEventListener("click", () => {
    state.cards = state.cards.filter((c) => c.id !== card.id);
    save();
    render();
  });

  top.append(text, del);

  // люди на карточке: главный первым
  const foot = document.createElement("div");
  foot.className = "card-foot";
  const ids = [...card.members].sort((a, b) => (b === card.lead) - (a === card.lead));
  for (const id of ids) {
    const p = person(id);
    if (p) foot.append(avatar(p, { lead: id === card.lead }));
  }
  const assign = document.createElement("button");
  assign.className = "assign";
  assign.title = "Назначить людей";
  assign.textContent = card.members.length ? "✎" : "+ люди";
  assign.addEventListener("click", (e) => {
    e.stopPropagation();
    openPicker(card.id, assign);
  });
  foot.append(assign);

  // редактирование по двойному клику
  text.addEventListener("dblclick", () => {
    li.draggable = false;
    text.contentEditable = "true";
    text.focus();
    document.getSelection().selectAllChildren(text);
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); text.blur(); }
    if (e.key === "Escape") { text.textContent = card.text; text.blur(); }
  });
  text.addEventListener("blur", () => {
    text.contentEditable = "false";
    li.draggable = true;
    const v = text.textContent.trim();
    if (v) card.text = v;
    else state.cards = state.cards.filter((c) => c.id !== card.id);
    save();
    render();
  });

  li.addEventListener("dragstart", (e) => {
    closePicker();
    draggedId = card.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    if (draggedId) commitOrder();
  });

  li.append(top, foot);
  return li;
}

/* ---------- выбор людей для карточки ---------- */

function openPicker(cardId, anchor) {
  pickerFor = cardId;
  renderPicker();
  picker.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = picker.offsetWidth;
  picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  picker.style.top = r.bottom + 6 + "px";
}

function closePicker() {
  pickerFor = null;
  picker.hidden = true;
}

function renderPicker() {
  const card = state.cards.find((c) => c.id === pickerFor);
  if (!card) return closePicker();
  picker.innerHTML = "";

  if (!state.people.length) {
    const empty = document.createElement("p");
    empty.className = "picker-empty";
    empty.textContent = "Сначала добавьте участников в шапке.";
    picker.append(empty);
    return;
  }

  const hint = document.createElement("p");
  hint.className = "picker-hint";
  hint.textContent = "Отметьте участников, ★ — главный";
  picker.append(hint);

  for (const p of state.people) {
    const on = card.members.includes(p.id);
    const isLead = card.lead === p.id;

    const row = document.createElement("div");
    row.className = "picker-row";

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.addEventListener("change", () => {
      if (cb.checked) card.members.push(p.id);
      else {
        card.members = card.members.filter((m) => m !== p.id);
        if (card.lead === p.id) card.lead = null;
      }
      update();
    });
    label.append(cb, avatar(p, { size: "sm" }), document.createTextNode(p.name));

    const star = document.createElement("button");
    star.className = "star" + (isLead ? " on" : "");
    star.textContent = isLead ? "★" : "☆";
    star.title = isLead ? "Снять главного" : "Сделать главным";
    star.addEventListener("click", () => {
      if (isLead) card.lead = null;
      else {
        card.lead = p.id;
        if (!card.members.includes(p.id)) card.members.push(p.id);
      }
      update();
    });

    row.append(label, star);
    picker.append(row);
  }
}

function update() {
  save();
  render();
  renderPicker();
}

document.addEventListener("mousedown", (e) => {
  if (!picker.hidden && !picker.contains(e.target) && !e.target.closest(".assign")) closePicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePicker();
});
window.addEventListener("resize", closePicker);
window.addEventListener("scroll", closePicker, true);

/* ---------- drag & drop ---------- */

function cardAfter(list, y) {
  const items = [...list.querySelectorAll(".card:not(.dragging)")];
  return items.find((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
}

function commitOrder() {
  draggedId = null;
  const byId = Object.fromEntries(state.cards.map((c) => [c.id, c]));
  const next = [];
  board.querySelectorAll(".column").forEach((colEl) => {
    colEl.querySelectorAll(".card").forEach((li) => {
      const c = byId[li.dataset.id];
      if (c) { c.col = colEl.dataset.col; next.push(c); }
    });
  });
  state.cards = next;
  save();
  render();
}

document.getElementById("reset").addEventListener("click", () => {
  if (confirm("Удалить все карточки?")) {
    state.cards = [];
    save();
    render();
  }
});

function renderAll() {
  renderPeople();
  render();
}

renderAll();
