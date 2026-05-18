const { Router } = require('express');
const axios = require('axios');
const youtube = require('./scraper');
const { searchCache, streamCache, metadataCache } = require('./cache');

const router = Router();

// ── Stream URL expiry helper ──────────────────────────────────────────────
// Mirrors Jio Saavn/routes.js exactly. Returns true when the cached stream
// data has an expires_at within 3 minutes of expiring (or already expired).
// Returns false when expires_at is absent (decrypt fallback path: trust TTL).
const EXPIRY_BUFFER_MS = 3 * 60 * 1000;

function isStreamExpired(streamData) {
  if (!streamData?.expires_at) return false;
  const expiresAt = new Date(streamData.expires_at).getTime();
  if (isNaN(expiresAt)) return true;
  return expiresAt - Date.now() <= EXPIRY_BUFFER_MS;
}

// ── trim helper ───────────────────────────────────────────────────────────
function trim(v) {
  return typeof v === 'string' ? v.trim() : v;
}

// ── Search ────────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `search:youtube:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await youtube.search(q);
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('returned 5')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'youtube', message: err.message });
    }
    console.error('[youtube] search error:', err.message);
    res.status(500).json({ error: 'search_failed', source: 'youtube', message: err.message });
  }
});

// ── Suggestions ───────────────────────────────────────────────────────────
router.get('/suggestions', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `suggestions:youtube:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await youtube.getSuggestions(q);
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'youtube', message: err.message });
    }
    console.error('[youtube] suggestions error:', err.message);
    res.status(500).json({ error: 'suggestions_failed', source: 'youtube', message: err.message });
  }
});

// ── Album ─────────────────────────────────────────────────────────────────
// YTM album details require auth. Return 501 with a clear message rather
// than 500, so clients can distinguish "not implemented" from a real error.
router.get('/album/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Album ID is required' });
  }

  try {
    await youtube.getAlbum(id);
  } catch (err) {
    if (err.message?.includes('not supported') || err.message?.includes('authentication')) {
      return res.status(501).json({ error: 'not_implemented', source: 'youtube', message: err.message });
    }
    console.error('[youtube] album error:', err.message);
    res.status(500).json({ error: 'album_failed', source: 'youtube', message: err.message });
  }
});

// ── Playlist ──────────────────────────────────────────────────────────────
router.get('/playlist/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Playlist ID is required' });
  }

  try {
    await youtube.getPlaylist(id);
  } catch (err) {
    if (err.message?.includes('not supported') || err.message?.includes('authentication')) {
      return res.status(501).json({ error: 'not_implemented', source: 'youtube', message: err.message });
    }
    console.error('[youtube] playlist error:', err.message);
    res.status(500).json({ error: 'playlist_failed', source: 'youtube', message: err.message });
  }
});

// ── Charts ────────────────────────────────────────────────────────────────
// Returns an empty charts array (YTM charts require auth). Cached so the
// client doesn't hammer the endpoint on every page load.
router.get('/charts', async (_req, res) => {
  const cacheKey = 'charts:youtube';
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await youtube.getCharts();
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'youtube', message: err.message });
    }
    console.error('[youtube] charts error:', err.message);
    res.status(500).json({ error: 'charts_failed', source: 'youtube', message: err.message });
  }
});

// ── Track stream URL ──────────────────────────────────────────────────────
// Accepts an optional ?title= and ?artist= query param so callers that
// already have track metadata can skip the YTM /next round-trip inside
// getStreamUrl. This is the same pattern the reference client uses when
// it passes the full Track object.
router.get('/track/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID is required' });
  }

  const cacheKey = `stream:youtube:${id}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    if (isStreamExpired(cached)) {
      streamCache.del(cacheKey);
      cached = null;
    } else {
      return res.json(cached);
    }
  }

  // Build a lightweight track meta object from query params if provided.
  // This avoids the /next round-trip when the caller already has the data.
  const trackMeta =
    req.query.title
      ? {
          id,
          title: trim(req.query.title) || id,
          artist: trim(req.query.artist) || 'Unknown',
          album: '',
          duration_seconds: 0,
        }
      : null;

  try {
    const result = await youtube.getStreamUrl(id, trackMeta);
    streamCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (
      err.message?.includes('no JioSaavn results') ||
      err.message?.includes('not found') ||
      err.message?.includes('Insufficient track metadata')
    ) {
      return res.status(404).json({ error: 'track_not_found', source: 'youtube', message: err.message });
    }
    if (err.message?.includes('Smart Track Replacement failed') || err.message?.includes('decryption')) {
      console.error('[youtube] stream resolution error:', err.message);
      return res.status(500).json({ error: 'stream_resolution_failed', source: 'youtube', message: err.message });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'youtube', message: err.message });
    }
    console.error('[youtube] track error:', err.message);
    res.status(500).json({ error: 'stream_failed', source: 'youtube', message: err.message });
  }
});

// ── Proxy audio stream ────────────────────────────────────────────────────
// Identical in structure to the JioSaavn /play proxy. Resolves the stream
// URL (with cache + expiry logic), then pipes the CDN response through the
// server with range request support. This bypasses CORS and Referer
// restrictions that would block direct browser playback.
router.get('/track/:id/play', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID is required' });
  }

  try {
    const cacheKey = `stream:youtube:${id}`;
    let streamData = streamCache.get(cacheKey);

    if (streamData && isStreamExpired(streamData)) {
      streamCache.del(cacheKey);
      streamData = null;
    }

    if (!streamData) {
      const trackMeta = req.query.title
        ? {
            id,
            title: trim(req.query.title) || id,
            artist: trim(req.query.artist) || 'Unknown',
            album: '',
            duration_seconds: 0,
          }
        : null;

      streamData = await youtube.getStreamUrl(id, trackMeta);
      streamCache.set(cacheKey, streamData);
    }

    if (!streamData.stream_url) {
      return res.status(404).json({ error: 'no_stream', message: 'No playable stream URL found for this track' });
    }

    const range = req.headers.range;
    const axiosConfig = {
      method: 'get',
      url: streamData.stream_url,
      responseType: 'stream',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.jiosaavn.com/',
      },
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    };

    if (range) {
      axiosConfig.headers['Range'] = range;
    }

    const cdnRes = await axios(axiosConfig);

    const contentType = cdnRes.headers['content-type'];
    res.set('Content-Type', contentType || 'audio/mp4');

    if (cdnRes.headers['content-length']) {
      res.set('Content-Length', cdnRes.headers['content-length']);
    }
    if (cdnRes.headers['accept-ranges']) {
      res.set('Accept-Ranges', cdnRes.headers['accept-ranges']);
    } else {
      res.set('Accept-Ranges', 'bytes');
    }
    if (range && cdnRes.headers['content-range']) {
      res.set('Content-Range', cdnRes.headers['content-range']);
    }
    if (cdnRes.status === 206) {
      res.status(206);
    }

    cdnRes.data.on('error', (streamErr) => {
      console.error('[youtube] proxy stream error for', id, streamErr.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'proxy_stream_error', message: `Stream error: ${streamErr.message}` });
      } else {
        res.end();
      }
    });

    req.on('close', () => {
      cdnRes.data.destroy();
    });

    cdnRes.data.pipe(res);
  } catch (err) {
    console.error('[youtube] proxy error:', err.message);
    if (err.response?.status === 403 || err.message?.includes('403')) {
      return res.status(502).json({ error: 'proxy_forbidden', message: 'Stream source rejected the request (403). The CDN may be blocking our server.' });
    }
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'proxy_timeout', message: 'Stream source timed out' });
    }
    res.status(502).json({ error: 'proxy_error', message: `Failed to proxy stream: ${err.message}` });
  }
});

module.exports = router;
