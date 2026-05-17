const { Router } = require('express');
const axios = require('axios');
const jiosaavn = require('../scrapers/jiosaavn');
const { searchCache, streamCache, metadataCache } = require('../utils/cache');
const { trim } = require('../utils/normalize');
const { getRecommendations, getUpNext, updateTransition, getSongsByIds } = require('../recommendation');

const router = Router();

// ── Stream URL expiry helper ──────────────────────────────────────────────
// Returns true if the cached stream data has an expires_at field that is
// within 3 minutes of expiring (or already expired). Returns false if the
// data has no expiry info (DES fallback path: trust the cache TTL).
const EXPIRY_BUFFER_MS = 3 * 60 * 1000; // 3 min safety buffer

function isStreamExpired(streamData) {
  if (!streamData?.expires_at) return false; // no expiry info: trust cache TTL
  const expiresAt = new Date(streamData.expires_at).getTime();
  if (isNaN(expiresAt)) return true; // invalid date: treat as expired
  return expiresAt - Date.now() <= EXPIRY_BUFFER_MS;
}

// ── Search ────────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `search:jiosaavn:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await jiosaavn.search(q);
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out') || err.message?.includes('returned 5')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'jiosaavn', message: err.message });
    }
    console.error('[jiosaavn] search error:', err.message);
    res.status(500).json({ error: 'search_failed', source: 'jiosaavn', message: err.message });
  }
});

// ── Suggestions ───────────────────────────────────────────────────────────
router.get('/suggestions', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `suggestions:jiosaavn:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await jiosaavn.getSuggestions(q);
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'jiosaavn', message: err.message });
    }
    console.error('[jiosaavn] suggestions error:', err.message);
    res.status(500).json({ error: 'suggestions_failed', source: 'jiosaavn', message: err.message });
  }
});

// ── Album ─────────────────────────────────────────────────────────────────
router.get('/album/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Album ID is required' });
  }

  const cacheKey = `album:jiosaavn:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await jiosaavn.getAlbum(id);
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('not found') || err.message?.includes('not_found')) {
      return res.status(404).json({ error: 'album_not_found', source: 'jiosaavn', message: err.message });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'jiosaavn', message: err.message });
    }
    console.error('[jiosaavn] album error:', err.message);
    res.status(500).json({ error: 'album_failed', source: 'jiosaavn', message: err.message });
  }
});

// ── Playlist ──────────────────────────────────────────────────────────────
router.get('/playlist/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Playlist ID is required' });
  }

  const cacheKey = `playlist:jiosaavn:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await jiosaavn.getPlaylist(id);
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('not found') || err.message?.includes('not_found')) {
      return res.status(404).json({ error: 'playlist_not_found', source: 'jiosaavn', message: err.message });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'jiosaavn', message: err.message });
    }
    console.error('[jiosaavn] playlist error:', err.message);
    res.status(500).json({ error: 'playlist_failed', source: 'jiosaavn', message: err.message });
  }
});

// ── Charts ────────────────────────────────────────────────────────────────
router.get('/charts', async (_req, res) => {
  const cacheKey = 'charts:jiosaavn';
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = await jiosaavn.getCharts();
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'jiosaavn', message: err.message });
    }
    console.error('[jiosaavn] charts error:', err.message);
    res.status(500).json({ error: 'charts_failed', source: 'jiosaavn', message: err.message });
  }
});

// ── Track stream URL ──────────────────────────────────────────────────────
router.get('/track/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID is required' });
  }

  // Record the transition for the recommendation engine
  const previousId = trim(req.query.previous_song_id);
  if (previousId && previousId !== id) {
    updateTransition(previousId, id).catch(() => {});
  }

  const cacheKey = `stream:jiosaavn:${id}`;
  let cached = streamCache.get(cacheKey);

  if (cached) {
    if (isStreamExpired(cached)) {
      // Expired: evict from cache and re-fetch
      streamCache.del(cacheKey);
      cached = null;
    } else {
      return res.json(cached);
    }
  }

  try {
    const result = await jiosaavn.getStreamUrl(id);
    streamCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('No encrypted media') || err.message?.includes('not found') || err.message?.includes('Song not found')) {
      return res.status(404).json({ error: 'track_not_found', source: 'jiosaavn', message: err.message });
    }
    if (err.message?.includes('Failed to decrypt') || err.message?.includes('decryption')) {
      console.error('[jiosaavn] decrypt error:', err.message);
      return res.status(500).json({ error: 'decryption_failed', source: 'jiosaavn', message: 'Failed to decrypt stream URL' });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source: 'jiosaavn', message: err.message });
    }
    console.error('[jiosaavn] track error:', err.message);
    res.status(500).json({ error: 'stream_failed', source: 'jiosaavn', message: err.message });
  }
});

// ── Proxy audio stream ────────────────────────────────────────────────────
router.get('/track/:id/play', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID is required' });
  }

  try {
    const cacheKey = `stream:jiosaavn:${id}`;
    let streamData = streamCache.get(cacheKey);

    if (streamData && isStreamExpired(streamData)) {
      streamCache.del(cacheKey);
      streamData = null;
    }

    if (!streamData) {
      streamData = await jiosaavn.getStreamUrl(id);
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.jiosaavn.com/',
      },
      timeout: 30000,
      // Disable axios response size limit so large audio files don't get cut off.
      // responseType: 'stream' means data is piped, not buffered in memory.
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
      // Always advertise byte range support so players can seek
      res.set('Accept-Ranges', 'bytes');
    }
    if (range && cdnRes.headers['content-range']) {
      res.set('Content-Range', cdnRes.headers['content-range']);
    }
    if (cdnRes.status === 206) {
      res.status(206);
    }

    cdnRes.data.on('error', (streamErr) => {
      console.error('[jiosaavn] proxy stream error for', id, streamErr.message);
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
    console.error('[jiosaavn] proxy error:', err.message);
    if (err.response?.status === 403 || err.message?.includes('403')) {
      return res.status(502).json({ error: 'proxy_forbidden', message: 'Stream source rejected the request (403). The CDN may be blocking our server.' });
    }
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'proxy_timeout', message: 'Stream source timed out' });
    }
    res.status(502).json({ error: 'proxy_error', message: `Failed to proxy stream: ${err.message}` });
  }
});

// ── Recommendations ───────────────────────────────────────────────────────
// GET /jiosaavn/recommend?song_id=<id>
// Returns behavior_based and content_based song lists, hydrated with
// full song metadata from the local catalog.
router.get('/recommend', async (req, res) => {
  const songId = trim(req.query.song_id);
  if (!songId) {
    return res.status(400).json({ error: 'missing_song_id', message: 'Query parameter "song_id" is required' });
  }

  try {
    const { behavior_based, content_based } = await getRecommendations(songId);
    const allIds = [...new Set([...behavior_based, ...content_based])];
    const songsById = Object.fromEntries(getSongsByIds(allIds).map(s => [s.id, s]));

    res.json({
      source: 'jiosaavn',
      song_id: songId,
      behavior_based: behavior_based.map(id => songsById[id]).filter(Boolean),
      content_based:  content_based.map(id => songsById[id]).filter(Boolean),
    });
  } catch (err) {
    console.error('[jiosaavn] recommend error:', err.message);
    res.status(500).json({ error: 'recommend_failed', source: 'jiosaavn', message: err.message });
  }
});

// ── Up Next ───────────────────────────────────────────────────────────────
// GET /jiosaavn/up_next?song_id=<id>&limit=<n>  (limit default 10, max 50)
// Returns an ordered queue of songs to play next, each tagged with the
// reason it was chosen ('behavior' or 'content').
const UP_NEXT_MAX = 50;

router.get('/up_next', async (req, res) => {
  const songId = trim(req.query.song_id);
  if (!songId) {
    return res.status(400).json({ error: 'missing_song_id', message: 'Query parameter "song_id" is required' });
  }

  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 10), UP_NEXT_MAX);

  try {
    const entries = await getUpNext(songId, limit);
    const songsById = Object.fromEntries(
      getSongsByIds(entries.map(e => e.song_id)).map(s => [s.id, s])
    );

    const queue = entries
      .map(e => {
        const song = songsById[e.song_id];
        if (!song) return null;
        return { ...song, reason: e.reason };
      })
      .filter(Boolean);

    res.json({ source: 'jiosaavn', song_id: songId, queue });
  } catch (err) {
    console.error('[jiosaavn] up_next error:', err.message);
    res.status(500).json({ error: 'up_next_failed', source: 'jiosaavn', message: err.message });
  }
});

module.exports = router;
