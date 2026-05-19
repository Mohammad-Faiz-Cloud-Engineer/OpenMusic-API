const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const jiosaavnRoutes = require('../Jio Saavn/routes');
const recommendationRoutes = require('../recommendation/routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many requests. Try again in a minute.' },
});
app.use(limiter);

app.use(express.json());

app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Range');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sources: ['jiosaavn'] });
});

app.use('/jiosaavn', jiosaavnRoutes);
app.use('/jiosaavn', recommendationRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Endpoint not found. Available: /health, /jiosaavn/*' });
});

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdown('UNCAUGHT_EXCEPTION');
});

const server = app.listen(PORT, () => {
  console.log(`OpenMusic API running on http://localhost:${PORT}`);
  console.log('Sources: /jiosaavn');
});

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
