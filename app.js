const STORAGE_KEY = "kanban-v1";

const COLUMNS = [
  { id: "todo", title: "Сделать" },
  { id: "doing", title: "В работе" },
  { id: "done", title: "Готово" },
];

let state = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.cards) return saved;
  } catch {}
  return {
    cards: [
      { id: uid(), col: "todo", text: "Перетащи меня в соседнюю колонку" },
      { id: uid(), col: "todo", text: "Двойной клик — редактировать" },
      { id: uid(), col: "doing", text: "Залить на Vercel" },
    ],
  };
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

const board = document.getElementById("board");
const tpl = document.getElementById("column-tpl");
let draggedId = null;

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

    // добавление
    node.querySelector(".add").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = e.target.text;
      const text = input.value.trim();
      if (!text) return;
      state.cards.push({ id: uid(), col: col.id, text });
      save();
      render();
      board.querySelector(`[data-col="${col.id}"] input`).focus();
    });

    // drop-зона
    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      node.classList.add("over");
      const after = cardAfter(list, e.clientY);
      const dragging = board.querySelector(".dragging");
      if (!dragging) return;
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
    draggedId = card.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    if (draggedId) commitOrder();
  });

  li.append(text, del);
  return li;
}

// карточка, перед которой вставлять (по Y курсора)
function cardAfter(list, y) {
  const items = [...list.querySelectorAll(".card:not(.dragging)")];
  return items.find((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
}

// переносим порядок из DOM обратно в state
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

render();
