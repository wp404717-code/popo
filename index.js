'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xvideos = require('xvideos-lib');

const PORT = Number(process.env.PORT) || 3000;
// Orígenes permitidos separados por coma. Vacío = mismo origen (cuando sirves el HTML desde este servidor).
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const CACHE_TTL = (Number(process.env.CACHE_TTL_SECONDS) || 300) * 1000;

// Términos relacionados con menores: se bloquean siempre en el servidor.
const BLOCKED = /\b(child|children|kid|kids|minor|underage|under\s?age|preteen|pre-teen|loli\w*|jailbait|toddler|infant|cp|pedo\w*|niñ[oa]s?|menor(es)?)\b/i;

const app = express();
app.set('trust proxy', 1); // detrás de Nginx / Caddy / Cloudflare
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      frameAncestors: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors(ALLOWED.length ? { origin: ALLOWED } : { origin: false }));

app.use('/videos', rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MIN) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' }
}));

/* ---------- Caché en memoria ---------- */
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + CACHE_TTL });
  if (cache.size > 500) cache.delete(cache.keys().next().value); // descarta la más antigua
  return val;
}

/* ---------- Helpers ---------- */
const toPage = v => Math.min(Math.max(parseInt(v, 10) || 1, 1), 500);

function wrap(list) {
  return {
    videos: (list.videos || []).filter(v => !BLOCKED.test(v.title || '')),
    pagination: list.pagination || { current: 1, pages: [] },
    hasNext: typeof list.hasNext === 'function' ? list.hasNext() : false
  };
}

const handler = fn => async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await fn(req));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ${req.path}:`, err.message);
    res.status(502).json({ error: 'No se pudo obtener datos del origen.' });
  }
};

/* ---------- Rutas (mismas que usa el frontend) ---------- */
app.get('/videos/fresh', handler(req => {
  const page = toPage(req.query.page);
  return cached(`fresh:${page}`, async () => wrap(await xvideos.videos.fresh({ page })));
}));

app.get('/videos/dashboard', handler(req => {
  const page = toPage(req.query.page);
  const key = String(req.query.key || '').trim().slice(0, 80);
  if (key && BLOCKED.test(key)) { const e = new Error('blocked'); e.status = 400; throw e; }
  return cached(`dash:${key}:${page}`, async () =>
    wrap(await xvideos.videos.dashboard(key ? { key, page } : { page })));
}));

app.get('/videos/best', handler(req => {
  const page = toPage(req.query.page);
  const year = /^\d{4}$/.test(req.query.year) ? req.query.year : String(new Date().getFullYear());
  const month = /^(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : '01';
  return cached(`best:${year}:${month}:${page}`, async () =>
    wrap(await xvideos.videos.best({ year, month, page })));
}));

app.get('/videos/verified', handler(req => {
  const page = toPage(req.query.page);
  return cached(`ver:${page}`, async () => wrap(await xvideos.videos.verified({ page })));
}));

app.get('/videos/details', handler(req => {
  const url = String(req.query.url || '');
  let u;
  try { u = new URL(url); } catch { const e = new Error('bad url'); e.status = 400; throw e; }
  // Solo URLs del dominio esperado: evita que el servidor sea usado como proxy abierto (SSRF).
  if (!/^(www\.)?xvideos\.com$/i.test(u.hostname) || u.protocol !== 'https:') {
    const e = new Error('bad host'); e.status = 400; throw e;
  }
  return cached(`det:${u.href}`, () => xvideos.videos.details({ url: u.href }));
}));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.status === 400 ? 'Solicitud inválida.' : 'Error interno.' });
});

// En Vercel se exporta la app (función serverless); en local se puede ejecutar con `node api/index.js`.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Nocturno escuchando en http://localhost:${PORT}`));
}
module.exports = app;
