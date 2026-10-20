// Точка входа для Vercel: vercel.json переписывает /api/* сюда с ?route=...
const { handle } = require("../lib/api");

module.exports = (req, res) => {
  const route = new URL(req.url, "http://x").searchParams.get("route") || "";
  return handle(req, res, route);
};
