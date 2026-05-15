const { Router } = require('express');
const ytmusic = require('../scrapers/ytmusic');
const { searchCache, streamCache, metadataCache } = require('../utils/cache');
const { trim } = require('../utils/normalize');

const router = Router();

// ── Search ────────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `search:ytmusic:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await ytmusic.search(q);
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('initialization failed')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'ytmusic', message: err.message });
    }
    console.error('[ytmusic] search error:', err.message);
    res.status(500).json({ error: 'search_failed', source: 'ytmusic', message: err.message });
  }
});

// ── Suggestions ───────────────────────────────────────────────────────────
router.get('/suggestions', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `suggestions:ytmusic:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await ytmusic.getSuggestions(q);
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('initialization failed')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'ytmusic', message: err.message });
    }
    console.error('[ytmusic] suggestions error:', err.message);
    res.status(500).json({ error: 'suggestions_failed', source: 'ytmusic', message: err.message });
  }
});

// ── Album ─────────────────────────────────────────────────────────────────
router.get('/album/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Album ID is required' });
  }

  const cacheKey = `album:ytmusic:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await ytmusic.getAlbum(id);
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('not found') || err.message?.includes('not_found')) {
      return res.status(404).json({ error: 'album_not_found', source: 'ytmusic', message: err.message });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('initialization failed')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'ytmusic', message: err.message });
    }
    console.error('[ytmusic] album error:', err.message);
    res.status(500).json({ error: 'album_failed', source: 'ytmusic', message: err.message });
  }
});

// ── Playlist ──────────────────────────────────────────────────────────────
router.get('/playlist/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Playlist ID is required' });
  }

  const cacheKey = `playlist:ytmusic:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await ytmusic.getPlaylist(id);
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('not found') || err.message?.includes('not_found')) {
      return res.status(404).json({ error: 'playlist_not_found', source: 'ytmusic', message: err.message });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('initialization failed')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'ytmusic', message: err.message });
    }
    console.error('[ytmusic] playlist error:', err.message);
    res.status(500).json({ error: 'playlist_failed', source: 'ytmusic', message: err.message });
  }
});

// ── Charts ────────────────────────────────────────────────────────────────
router.get('/charts', async (_req, res) => {
  const cacheKey = 'charts:ytmusic';
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await ytmusic.getCharts();
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('initialization failed')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'ytmusic', message: err.message });
    }
    console.error('[ytmusic] charts error:', err.message);
    res.status(500).json({ error: 'charts_failed', source: 'ytmusic', message: err.message });
  }
});

// ── Track metadata ────────────────────────────────────────────────────────
// FIX: was caching a useless all-null object. Now returns real track metadata
// including title, artist, duration, thumbnail, and youtube_url.
// stream_url is always null — YT Music does not provide direct audio URLs.
// Use youtube_url to open the track in YouTube / YouTube Music.
router.get('/track/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID (YouTube video ID) is required' });
  }

  const cacheKey = `stream:ytmusic:${id}`;
  const cached = streamCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await ytmusic.getStreamUrl(id);
    streamCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('not found') || err.message?.includes('not_found')) {
      return res.status(404).json({ error: 'track_not_found', source: 'ytmusic', message: err.message });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('initialization failed')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'ytmusic', message: err.message });
    }
    console.error('[ytmusic] track error:', err.message);
    res.status(500).json({ error: 'track_failed', source: 'ytmusic', message: err.message });
  }
});

module.exports = router;
