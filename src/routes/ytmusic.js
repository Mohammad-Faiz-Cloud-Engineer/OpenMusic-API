const { Router } = require('express');
const axios = require('axios');
const { trim } = require('../../Jio Saavn/utils/normalize');
const { searchCache, metadataCache } = require('../../Jio Saavn/utils/cache');

const router = Router();

const YTMUSIC_BASE = (process.env.YTMUSIC_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const CHART_PLAYLIST_ID = '__chart_top_songs__';
const SOURCE = 'ytmusic';

function toUiTrack(song) {
  if (!song) return null;
  return {
    id: String(song.id ?? ''),
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
    duration_seconds: Number(song.duration) || 0,
    thumbnail: song.cover_xl || song.cover || null,
  };
}

function normalizeSearch(query, songs) {
  return {
    source: SOURCE,
    query,
    results: (Array.isArray(songs) ? songs : []).map(toUiTrack).filter(t => t.id),
  };
}

async function mobileGet(path, params = {}) {
  const { data } = await axios.get(`${YTMUSIC_BASE}${path}`, {
    params,
    timeout: 20_000,
    validateStatus: status => status < 500,
  });
  return data;
}

async function itunesLookup(params) {
  const { data } = await axios.get('https://itunes.apple.com/lookup', {
    params,
    timeout: 15_000,
  });
  return data;
}

function itunesItemToTrack(item, trackNumber) {
  const artUrl = item.artworkUrl100 || '';
  const cover = artUrl ? artUrl.replace('100x100bb', '200x200bb') : '';
  const coverXl = artUrl ? artUrl.replace('100x100bb', '600x600bb') : '';
  return {
    id: String(item.trackId || item.collectionId || ''),
    title: item.trackName || item.collectionName || 'Unknown',
    artist: item.artistName || 'Unknown',
    album: item.collectionName || '',
    duration: Math.floor((item.trackTimeMillis || 0) / 1000),
    cover,
    cover_xl: coverXl,
    track_number: trackNumber,
  };
}

function publicBase(req) {
  return `${req.protocol}://${req.get('host')}/ytmusic`;
}

function rewriteServiceUrl(url, req) {
  if (!url || typeof url !== 'string') return url;
  const base = publicBase(req);
  return url
    .replace(`${YTMUSIC_BASE}/api/mobile/stream_proxy`, `${base}/stream_proxy`)
    .replace(/https?:\/\/[^/]+\/api\/mobile\/stream_proxy/g, `${base}/stream_proxy`)
    .replace(`${YTMUSIC_BASE}/api/mobile/stream_cache/`, `${base}/stream_cache/`)
    .replace(/https?:\/\/[^/]+\/api\/mobile\/stream_cache\//g, `${base}/stream_cache/`);
}

function rewritePlayPayload(payload, req) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    url: rewriteServiceUrl(payload.url, req),
  };
}

function chartPlaylistFromSongs(songs) {
  const tracks = (songs || []).map((s, i) => toUiTrack({ ...s, track_number: i + 1 }));
  const thumb = tracks[0]?.thumbnail || null;
  return {
    source: SOURCE,
    id: CHART_PLAYLIST_ID,
    title: 'Top Songs — India',
    owner: 'iTunes Chart',
    song_count: tracks.length,
    duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
    thumbnail: thumb,
    tracks,
  };
}

// ── Search ────────────────────────────────────────────────────────────────
router.get('/search', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `search:${SOURCE}:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const songs = await mobileGet('/api/mobile/search', { q });
    const result = normalizeSearch(q, songs);
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    const msg = err.code === 'ECONNREFUSED'
      ? 'YouTube Music service is not running (expected on port 8000)'
      : err.message;
    console.error('[ytmusic] search error:', msg);
    res.status(503).json({ error: 'source_unavailable', source: SOURCE, message: msg });
  }
});

// ── Suggestions ───────────────────────────────────────────────────────────
router.get('/suggestions', async (req, res) => {
  const q = trim(req.query.q);
  if (!q) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }

  const cacheKey = `suggestions:${SOURCE}:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const songs = await mobileGet('/api/mobile/search', { q });
    const suggestions = [
      ...new Set(
        (Array.isArray(songs) ? songs : [])
          .map(s => {
            const title = (s.title || '').trim();
            const artist = (s.artist || '').trim();
            if (title && artist) return `${title} — ${artist}`;
            return title;
          })
          .filter(Boolean),
      ),
    ].slice(0, 10);

    const result = { source: SOURCE, query: q, suggestions };
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    const msg = err.code === 'ECONNREFUSED'
      ? 'YouTube Music service is not running (expected on port 8000)'
      : err.message;
    console.error('[ytmusic] suggestions error:', msg);
    res.status(503).json({ error: 'source_unavailable', source: SOURCE, message: msg });
  }
});

// ── Charts ────────────────────────────────────────────────────────────────
router.get('/charts', async (_req, res) => {
  const cacheKey = `charts:${SOURCE}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const songs = await mobileGet('/api/mobile/chart');
    const thumb = songs?.[0]?.cover_xl || songs?.[0]?.cover || null;
    const result = {
      source: SOURCE,
      charts: [{
        id: CHART_PLAYLIST_ID,
        title: 'Top Songs — India',
        description: `${Array.isArray(songs) ? songs.length : 0} tracks · iTunes chart`,
        thumbnail: thumb,
      }],
    };
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    const msg = err.code === 'ECONNREFUSED'
      ? 'YouTube Music service is not running (expected on port 8000)'
      : err.message;
    console.error('[ytmusic] charts error:', msg);
    res.status(503).json({ error: 'source_unavailable', source: SOURCE, message: msg });
  }
});

// ── Playlist (incl. synthetic chart playlist) ─────────────────────────────
router.get('/playlist/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Playlist ID is required' });
  }

  const cacheKey = `playlist:${SOURCE}:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    if (id === CHART_PLAYLIST_ID) {
      const songs = await mobileGet('/api/mobile/chart');
      const result = chartPlaylistFromSongs(songs);
      metadataCache.set(cacheKey, result);
      return res.json(result);
    }

    return res.status(404).json({
      error: 'playlist_not_found',
      source: SOURCE,
      message: 'Only the built-in chart playlist is available for YouTube Music. Use the Charts tab or load chart tracks.',
    });
  } catch (err) {
    const msg = err.code === 'ECONNREFUSED'
      ? 'YouTube Music service is not running (expected on port 8000)'
      : err.message;
    console.error('[ytmusic] playlist error:', msg);
    res.status(503).json({ error: 'source_unavailable', source: SOURCE, message: msg });
  }
});

// ── Album ─────────────────────────────────────────────────────────────────
router.get('/album/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Album ID is required' });
  }

  const cacheKey = `album:${SOURCE}:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await itunesLookup({ id, entity: 'song', limit: 200 });
    const items = data?.results || [];
    if (!items.length) {
      return res.status(404).json({ error: 'album_not_found', source: SOURCE, message: 'Album not found' });
    }

    const albumMeta = items.find(r => r.wrapperType === 'collection') || items[0];
    const songItems = items.filter(r => r.wrapperType === 'track' && r.trackName);
    const tracks = songItems.map((item, i) => ({
      ...toUiTrack(itunesItemToTrack(item)),
      track_number: i + 1,
    }));

    const result = {
      source: SOURCE,
      id: String(albumMeta.collectionId || id),
      title: albumMeta.collectionName || albumMeta.trackName || '',
      artist: albumMeta.artistName || tracks[0]?.artist || 'Unknown',
      year: albumMeta.releaseDate ? new Date(albumMeta.releaseDate).getFullYear() : 0,
      song_count: tracks.length,
      duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
      thumbnail: tracks[0]?.thumbnail || null,
      tracks,
    };

    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[ytmusic] album error:', err.message);
    res.status(500).json({ error: 'album_failed', source: SOURCE, message: err.message });
  }
});

// ── Play (audio resolve via Python / yt-dlp) ──────────────────────────────
router.get('/play', async (req, res) => {
  const id = trim(req.query.id);
  const artist = trim(req.query.artist);
  const title = trim(req.query.title);
  if (!id || !artist || !title) {
    return res.status(400).json({
      error: 'missing_params',
      message: 'Query parameters id, artist, and title are required',
    });
  }

  try {
    const { data, status } = await axios.get(`${YTMUSIC_BASE}/api/mobile/play`, {
      params: { id, artist, title, previous_song_id: trim(req.query.previous_song_id) || undefined },
      timeout: 60_000,
      validateStatus: () => true,
    });
    if (status >= 400) {
      return res.status(status).json(data);
    }
    res.json(rewritePlayPayload(data, req));
  } catch (err) {
    const msg = err.code === 'ECONNREFUSED'
      ? 'YouTube Music service is not running (expected on port 8000)'
      : err.message;
    console.error('[ytmusic] play error:', msg);
    res.status(503).json({ error: 'source_unavailable', source: SOURCE, message: msg });
  }
});

router.get('/stream_proxy', async (req, res) => {
  try {
    const upstream = await axios.get(`${YTMUSIC_BASE}/api/mobile/stream_proxy`, {
      params: req.query,
      responseType: 'stream',
      timeout: 60_000,
      headers: { range: req.headers.range || '' },
      validateStatus: () => true,
    });
    res.status(upstream.status);
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (key.toLowerCase() === 'transfer-encoding') continue;
      res.setHeader(key, value);
    }
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[ytmusic] stream_proxy error:', err.message);
    res.status(502).json({ error: 'stream_failed', source: SOURCE, message: err.message });
  }
});

router.get('/stream_cache/:filename', async (req, res) => {
  try {
    const upstream = await axios.get(
      `${YTMUSIC_BASE}/api/mobile/stream_cache/${encodeURIComponent(req.params.filename)}`,
      { responseType: 'stream', timeout: 60_000, validateStatus: () => true },
    );
    res.status(upstream.status);
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (key.toLowerCase() === 'transfer-encoding') continue;
      res.setHeader(key, value);
    }
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[ytmusic] stream_cache error:', err.message);
    res.status(502).json({ error: 'stream_failed', source: SOURCE, message: err.message });
  }
});

// ── Track metadata ──────────────────────────────────────────────────────────
router.get('/track/:id', async (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID is required' });
  }

  const cacheKey = `track:${SOURCE}:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await itunesLookup({ id });
    const item = (data?.results || []).find(r => r.wrapperType === 'track') || data?.results?.[0];
    if (!item) {
      return res.status(404).json({ error: 'track_not_found', source: SOURCE, message: 'Track not found' });
    }

    const result = { source: SOURCE, ...toUiTrack(itunesItemToTrack(item)) };
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[ytmusic] track error:', err.message);
    res.status(500).json({ error: 'track_failed', source: SOURCE, message: err.message });
  }
});

module.exports = router;
