const express = require('express');
const rateLimit = require('express-rate-limit');
const searchRoutes = require('./routes/search');
const streamRoutes = require('./routes/stream');
const albumRoutes = require('./routes/album');
const playlistRoutes = require('./routes/playlist');
const suggestionsRoutes = require('./routes/suggestions');
const chartsRoutes = require('./routes/charts');

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

app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sources: ['jiosaavn', 'ytmusic'] });
});

app.use('/search', searchRoutes);
app.use('/track', streamRoutes);
app.use('/album', albumRoutes);
app.use('/playlist', playlistRoutes);
app.use('/suggestions', suggestionsRoutes);
app.use('/charts', chartsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Endpoint not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

app.listen(PORT, () => {
  console.log(`Music Scraper API running on http://localhost:${PORT}`);
  console.log(`Sources: jiosaavn, ytmusic`);
});
