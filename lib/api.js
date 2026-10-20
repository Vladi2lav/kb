const crypto = require("crypto");
const { getStore } = require("./store");
const seed = require("./seed");

const DAY = 86400;
const SESSION_TTL = 30 * DAY;
const POW_BITS = Number(process.env.POW_BITS || 18); // ~260k хэшей: ~0.5–2 с в браузере
const MIN_FORM_MS = 3000; // форму создания нельзя отправить быстрее, чем через 3 с

const COLORS = ["", "red", "orange", "yellow", "green", "blue", "purple"];
const LIMITS = { columns: 12, cards: 1000, colTitle: 40, text: 2000, name: 60 };
const DEFAULT_COLUMNS = [
  { id: "todo", title: "Сделать" },
  { id: "doing", title: "В работе" },
  { id: "done", title: "Готово" },
];

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

// ---------- утилиты ----------

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function newId(len = 10) {
  let s = "";
  for (const b of crypto.randomBytes(len)) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64")}$${h.toString("base64")}`;
}
function checkPassword(pw, stored) {
  const [, n, salt, hash] = String(stored).split("$");
  const expected = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: 8, p: 1 });
  return crypto.timingSafeEqual(got, expected);
}

let secretCache;
async function secret(store) {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (secretCache) return secretCache;
  await store.setnx("secret", b64u(crypto.randomBytes(32)));
  return (secretCache = await store.get("secret"));
}

async function signToken(store, board) {
  const payload = b64u(JSON.stringify({ b: board.id, v: board.pwv, e: Date.now() + SESSION_TTL * 1000 }));
  const sig = b64u(crypto.createHmac("sha256", await secret(store)).update(payload).digest());
  return `${payload}.${sig}`;
}
async function verifyToken(store, token, board) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return false;
  const want = crypto.createHmac("sha256", await secret(store)).update(payload).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    return p.b === board.id && p.v === board.pwv && p.e > Date.now();
  } catch { return false; }
}

function clientIp(req) {
  if (process.env.VERCEL || process.env.TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
    if (req.headers["x-real-ip"]) return String(req.headers["x-real-ip"]);
  }
  return req.socket?.remoteAddress || "?";
}

async function limit(store, key, max, windowSec, message) {
  const n = await store.incr(`rl:${key}`, windowSec);
  if (n > max) throw new HttpError(429, message || "Слишком много запросов, попробуй позже");
}
async function count(store, key) {
  return Number((await store.get(`rl:${key}`)) || 0);
}

function readBody(req, max = 600 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, "Слишком большой запрос")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "Некорректный JSON")); }
    });
    req.on("error", reject);
  });
}

function str(v, max, field, min = 1) {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) throw new HttpError(400, `Поле «${field}»: от ${min} до ${max} символов`);
  return s;
}
function password(v) {
  if (typeof v !== "string" || v.length < 6 || v.length > 128) throw new HttpError(400, "Пароль: от 6 до 128 символов");
  return v;
}
const SAFE_ID = /^[a-zA-Z0-9_-]{1,24}$/;

function cleanContent(body) {
  const { columns, cards } = body;
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > LIMITS.columns)
    throw new HttpError(400, `Колонок должно быть от 1 до ${LIMITS.columns}`);
  if (!Array.isArray(cards) || cards.length > LIMITS.cards)
    throw new HttpError(400, `Не больше ${LIMITS.cards} карточек`);
  const colIds = new Set();
  const cols = columns.map((c) => {
    if (!c || !SAFE_ID.test(c.id) || colIds.has(c.id)) throw new HttpError(400, "Некорректная колонка");
    colIds.add(c.id);
    return { id: c.id, title: str(c.title, LIMITS.colTitle, "название колонки") };
  });
  const cardIds = new Set();
  const cds = cards.map((c) => {
    if (!c || !SAFE_ID.test(c.id) || cardIds.has(c.id) || !colIds.has(c.col)) throw new HttpError(400, "Некорректная карточка");
    cardIds.add(c.id);
    return {
      id: c.id,
      col: c.col,
      text: str(c.text, LIMITS.text, "текст карточки"),
      color: COLORS.includes(c.color) ? c.color : "",
    };
  });
  return { columns: cols, cards: cds };
}

function publicBoard(b) {
  return {
    id: b.id, name: b.name, version: b.version, updatedAt: b.updatedAt,
    columns: b.columns, cards: b.cards, importLegacy: !!b.importLegacy,
  };
}

// ---------- доски ----------

let seeded = false;
async function ensureSeed(store) {
  if (seeded) return;
  seeded = true;
  if (!seed || !seed.id) return;
  const now = Date.now();
  await store.setnx(`board:${seed.id}`, {
    id: seed.id, name: seed.name, pw: seed.pw, pwv: 1,
    createdAt: now, updatedAt: now, version: 1,
    columns: DEFAULT_COLUMNS, cards: [], importLegacy: true,
  });
}

async function loadBoard(store, id) {
  if (!SAFE_ID.test(id || "")) return null;
  await ensureSeed(store);
  return store.get(`board:${id}`);
}

async function authBoard(store, req, id) {
  const board = await loadBoard(store, id);
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!board || !(await verifyToken(store, token, board))) throw new HttpError(401, "Нужно войти заново");
  return board;
}

// проверка пароля с защитой от перебора
async function passwordGate(store, ip, board, pw) {
  if ((await count(store, `lf:ip:${ip}`)) >= 10 || (board && (await count(store, `lf:b:${board.id}`)) >= 30))
    throw new HttpError(429, "Слишком много неверных попыток. Подожди 15 минут");
  if (board && typeof pw === "string" && checkPassword(pw, board.pw)) return;
  await store.incr(`rl:lf:ip:${ip}`, 900);
  if (board) await store.incr(`rl:lf:b:${board.id}`, 900);
  throw new HttpError(401, "Неверная доска или пароль");
}

// ---------- обработчики ----------

async function getChallenge(store, ip) {
  await limit(store, `ch:${ip}`, 30, 3600, "Слишком много попыток создать доску, попробуй через час");
  const id = b64u(crypto.randomBytes(12));
  const salt = b64u(crypto.randomBytes(12));
  await store.set(`ch:${id}`, { salt, bits: POW_BITS, at: Date.now() }, 900);
  return { id, salt, bits: POW_BITS };
}

function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

async function createBoard(store, ip, body) {
  // honeypot: скрытое поле, которое люди не видят и не заполняют
  if (body.website) throw new HttpError(400, "Не удалось создать доску");

  const name = str(body.name, LIMITS.name, "название");
  const pw = password(body.password);

  const ch = body.challenge || {};
  const rec = typeof ch.id === "string" ? await store.get(`ch:${ch.id}`) : null;
  if (!rec) throw new HttpError(400, "Проверка устарела — обнови страницу", { retry: true });
  if (Date.now() - rec.at < MIN_FORM_MS) throw new HttpError(400, "Слишком быстро. Подожди пару секунд");
  const digest = crypto.createHash("sha256").update(`${rec.salt}:${ch.nonce}`).digest();
  if (leadingZeroBits(digest) < rec.bits) throw new HttpError(400, "Проверка не пройдена", { retry: true });
  if (!(await store.del(`ch:${ch.id}`))) throw new HttpError(400, "Проверка уже использована", { retry: true });

  await limit(store, `new:h:${ip}`, 3, 3600, "Можно создать не больше 3 досок в час");
  await limit(store, `new:d:${ip}`, 10, DAY, "Можно создать не больше 10 досок в сутки");
  await limit(store, "new:all", Number(process.env.MAX_BOARDS_PER_DAY || 300), DAY, "Сегодня создано слишком много досок, попробуй завтра");

  const now = Date.now();
  let id;
  for (let i = 0; i < 5; i++) {
    id = newId();
    const board = {
      id, name, pw: hashPassword(pw), pwv: 1,
      createdAt: now, updatedAt: now, version: 1,
      columns: DEFAULT_COLUMNS, cards: [],
    };
    if (await store.setnx(`board:${id}`, board)) return { id, name, token: await signToken(store, board) };
  }
  throw new HttpError(500, "Не удалось создать доску");
}

async function route(req, res, path) {
  const store = getStore();
  const ip = clientIp(req);
  const method = req.method;
  const parts = path.split("/").filter(Boolean);

  await limit(store, `req:${ip}`, 600, 60);

  if (parts[0] === "challenge" && parts.length === 1 && method === "GET") return getChallenge(store, ip);

  if (parts[0] !== "boards") throw new HttpError(404, "Не найдено");

  if (parts.length === 1 && method === "POST") return createBoard(store, ip, await readBody(req));

  const id = parts[1];
  const action = parts[2] || "";

  if (action === "login" && method === "POST") {
    const body = await readBody(req, 4096);
    const board = await loadBoard(store, id);
    await passwordGate(store, ip, board, body.password);
    return { id: board.id, name: board.name, token: await signToken(store, board) };
  }

  if (!action && method === "GET") {
    const board = await authBoard(store, req, id);
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("v") === String(board.version)) return { unchanged: true, version: board.version };
    return publicBoard(board);
  }

  if (!action && method === "PUT") {
    const body = await readBody(req);
    const board = await authBoard(store, req, id);
    await limit(store, `w:${id}`, 240, 60, "Слишком частые изменения");
    if (body.version !== board.version) throw new HttpError(409, "Доску изменили в другом окне", { board: publicBoard(board) });
    Object.assign(board, cleanContent(body));
    if (body.importDone) delete board.importLegacy;
    board.version++;
    board.updatedAt = Date.now();
    await store.set(`board:${id}`, board);
    return { version: board.version, updatedAt: board.updatedAt };
  }

  if (action === "settings" && method === "POST") {
    const body = await readBody(req, 4096);
    const board = await authBoard(store, req, id);
    await passwordGate(store, ip, board, body.current);
    if (body.name !== undefined) board.name = str(body.name, LIMITS.name, "название");
    if (body.password !== undefined) {
      board.pw = hashPassword(password(body.password));
      board.pwv++; // старые сессии на других устройствах перестают работать
    }
    board.updatedAt = Date.now();
    board.version++;
    await store.set(`board:${id}`, board);
    return { name: board.name, version: board.version, token: await signToken(store, board) };
  }

  if (action === "delete" && method === "POST") {
    const body = await readBody(req, 4096);
    const board = await authBoard(store, req, id);
    await passwordGate(store, ip, board, body.password);
    await store.del(`board:${id}`);
    return { ok: true };
  }

  throw new HttpError(404, "Не найдено");
}

async function handle(req, res, path) {
  let status = 200;
  let out;
  try {
    out = await route(req, res, path);
  } catch (e) {
    status = e.status || 500;
    if (status === 500) console.error(e);
    out = { error: status === 500 ? "Ошибка сервера" : e.message, ...(e.extra || {}) };
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(out));
}

module.exports = { handle };
