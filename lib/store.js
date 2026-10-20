// Хранилище ключ-значение. Локально — JSON-файл в data/,
// на Vercel — Upstash Redis / Vercel KV через REST (переменные KV_REST_API_* или UPSTASH_REDIS_REST_*).
const fs = require("fs");
const path = require("path");

function fileStore(dir) {
  const file = path.join(dir, "db.json");
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const mem = new Map(); // эфемерные ключи (лимиты, челленджи) — не пишем на диск

  let timer = null;
  function persist() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    }, 50);
  }
  function live(k) {
    const e = mem.get(k);
    if (e && e.exp && e.exp < Date.now()) { mem.delete(k); return undefined; }
    return e;
  }

  return {
    kind: "file",
    async get(k) {
      if (k in db) return db[k];
      const e = live(k);
      return e ? e.v : null;
    },
    async set(k, v, ttl) {
      if (ttl) mem.set(k, { v, exp: Date.now() + ttl * 1000 });
      else { db[k] = v; persist(); }
    },
    async del(k) {
      if (k in db) { delete db[k]; persist(); return true; }
      const had = !!live(k);
      mem.delete(k);
      return had;
    },
    async setnx(k, v, ttl) {
      if (k in db || live(k)) return false;
      await this.set(k, v, ttl);
      return true;
    },
    async incr(k, ttl) {
      const e = live(k);
      if (e) { e.v++; return e.v; }
      mem.set(k, { v: 1, exp: Date.now() + ttl * 1000 });
      return 1;
    },
    flush() {
      clearTimeout(timer);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(db));
    },
  };
}

function redisStore(url, token) {
  async function cmd(...args) {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const j = await r.json();
    if (j.error) throw new Error("redis: " + j.error);
    return j.result;
  }
  return {
    kind: "redis",
    async get(k) {
      const v = await cmd("GET", k);
      return v == null ? null : JSON.parse(v);
    },
    async set(k, v, ttl) {
      if (ttl) await cmd("SET", k, JSON.stringify(v), "EX", ttl);
      else await cmd("SET", k, JSON.stringify(v));
    },
    async del(k) {
      return (await cmd("DEL", k)) > 0;
    },
    async setnx(k, v, ttl) {
      const args = ["SET", k, JSON.stringify(v), "NX"];
      if (ttl) args.push("EX", ttl);
      return (await cmd(...args)) === "OK";
    },
    async incr(k, ttl) {
      const n = await cmd("INCR", k);
      if (n === 1) await cmd("EXPIRE", k, ttl);
      return n;
    },
  };
}

let instance;
function getStore() {
  if (instance) return instance;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) instance = redisStore(url, token);
  else if (process.env.VERCEL) throw new Error("На Vercel нужно подключить Redis (Upstash / Vercel KV)");
  else {
    if (process.env.RENDER && !process.env.DATA_DIR)
      console.warn("Внимание: на Render файловая система стирается при каждом деплое. Подключи Redis (UPSTASH_REDIS_REST_URL/TOKEN) или диск (DATA_DIR)");
    instance = fileStore(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  }
  return instance;
}

module.exports = { getStore };
