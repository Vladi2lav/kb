// Локальный сервер без зависимостей: статика из public/ + API из lib/api.js
//   node server.js            → http://localhost:3000
//   PORT=8080 node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const { handle } = require("./lib/api");
const { getStore } = require("./lib/store");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) return handle(req, res, url.pathname.slice(5));

  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Kanban: http://localhost:${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    const s = getStore();
    if (s.flush) s.flush();
    process.exit(0);
  });
}
