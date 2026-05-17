const fs = require('fs');
const path = require('path');

/** Load .env for local dev (HF Space secrets inject env vars at runtime). */
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const express = require('express');
const rateLimit = require('express-rate-limit');
const jiosaavnRoutes = require('../Jio Saavn/routes/jiosaavn');
const ytmusicRoutes = require('./routes/ytmusic');

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

app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Range');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    sources: ['jiosaavn', 'ytmusic'],
    ytmusic_youtube_cookies: Boolean(
      process.env.YTMUSIC_YOUTUBE_COOKIES?.trim()
      || process.env.YTMUSIC_YOUTUBE_COOKIES_FILE?.trim(),
    ),
    ytmusic_ytdlp: process.env.YTMUSIC_ENABLE_YTDLP === 'true'
      || Boolean(process.env.YTMUSIC_YOUTUBE_COOKIES?.trim())
      || Boolean(process.env.YTMUSIC_YOUTUBE_COOKIES_FILE?.trim()),
  });
});

app.use('/jiosaavn', jiosaavnRoutes);
app.use('/ytmusic', ytmusicRoutes);

app.use((_req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: 'Endpoint not found. Available: /health, /jiosaavn/*, /ytmusic/search, /ytmusic/play/stream, /ytmusic/play, ...',
  });
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
  console.log('Sources: /jiosaavn, /ytmusic');
  if (process.env.YTMUSIC_YOUTUBE_COOKIES?.trim() || process.env.YTMUSIC_YOUTUBE_COOKIES_FILE?.trim()) {
    console.log('[ytmusic] YouTube cookies configured — full playback via yt-dlp enabled');
  }
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
