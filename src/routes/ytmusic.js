const { Router } = require('express');
const axios = require('axios');
const { trim } = require('../../Jio Saavn/utils/normalize');
const { searchCache, streamCache, metadataCache } = require('../../Jio Saavn/utils/cache');

const router = Router();

const YTMUSIC_BASE = (process.env.YTMUSIC_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const CHART_PLAYLIST_ID = '__chart_top_songs__';
const SOURCE = 'ytmusic';
const PLAY_TIMEOUT_MS = 120_000;

/** Piped API mirrors — try several; public instances go down often. */
const PIPED_INSTANCES = [
  'https://pipedapi.in.projectsegfau.lt',
  'https://pipedapi.leptons.xyz',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.kavin.rocks',
];

/** Invidious API mirrors (often work when Piped/yt-dlp fail on cloud IPs). */
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://inv.tux.pizza',
  'https://vid.puffyan.us',
];

function hasYoutubeCookies() {
  return Boolean(
    process.env.YTMUSIC_YOUTUBE_COOKIES?.trim()
    || process.env.YTMUSIC_YOUTUBE_COOKIES_FILE?.trim(),
  );
}

/** Full yt-dlp when cookies are set (HF secret), or when explicitly enabled locally. */
const YTDLP_WITH_COOKIES = hasYoutubeCookies();
const YTDLP_PLAY_ENABLED = process.env.YTMUSIC_ENABLE_YTDLP === 'true' || YTDLP_WITH_COOKIES;

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
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}/ytmusic`;
}

function proxyHeaders(req) {
  return {
    'X-Forwarded-Proto': (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim(),
    'X-Forwarded-Host': (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim(),
  };
}

function playStreamUrl(req, id, artist, title) {
  const params = new URLSearchParams({ id, artist, title });
  return `${publicBase(req)}/play/stream?${params}`;
}

function playErrorMessage(data, status) {
  return data?.message || data?.error || `Playback failed (HTTP ${status})`;
}

/** Stream audio from an external CDN (same pattern as JioSaavn /track/:id/play). */
async function pipeExternalStream(streamUrl, extraHeaders, req, res) {
  const range = req.headers.range;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-us,en;q=0.5',
    Referer: 'https://www.youtube.com/',
    ...extraHeaders,
  };
  if (range) headers.Range = range;

  const upstream = await axios({
    method: 'get',
    url: streamUrl,
    responseType: 'stream',
    headers,
    timeout: 60_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  if (upstream.status >= 400) {
    if (!res.headersSent) {
      res.status(upstream.status).json({
        error: 'stream_failed',
        source: SOURCE,
        message: `Audio CDN returned HTTP ${upstream.status}`,
      });
    }
    upstream.data.destroy();
    return;
  }

  const skip = new Set(['transfer-encoding', 'connection', 'content-encoding']);
  res.status(upstream.status === 206 ? 206 : upstream.status);
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
  }
  if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'audio/mp4');
  if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');

  upstream.data.on('error', (err) => {
    console.error('[ytmusic] CDN stream error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'stream_failed', source: SOURCE, message: err.message });
    } else {
      res.end();
    }
  });
  req.on('close', () => upstream.data.destroy());
  upstream.data.pipe(res);
}

async function pipePythonCache(filename, req, res) {
  const range = req.headers.range;
  const upstream = await axios.get(
    `${YTMUSIC_BASE}/api/mobile/stream_cache/${encodeURIComponent(filename)}`,
    {
      responseType: 'stream',
      timeout: 60_000,
      headers: range ? { Range: range } : {},
      validateStatus: () => true,
    },
  );
  if (upstream.status >= 400) {
    if (!res.headersSent) {
      res.status(upstream.status).json({ error: 'stream_failed', source: SOURCE, message: 'Cached file not found' });
    }
    upstream.data.destroy();
    return;
  }
  const skip = new Set(['transfer-encoding', 'connection', 'content-encoding']);
  res.status(upstream.status === 206 ? 206 : upstream.status);
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
  }
  if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'audio/mp4');
  upstream.data.pipe(res);
}

function youtubeSearchUrl(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ').trim();
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

async function resolveLocalCache(id) {
  const filename = `${id}.m4a`;
  try {
    const { status } = await axios.get(
      `${YTMUSIC_BASE}/api/mobile/stream_cache/${encodeURIComponent(filename)}`,
      { timeout: 8_000, headers: { Range: 'bytes=0-0' }, validateStatus: () => true },
    );
    if (status === 200 || status === 206) {
      return { source: 'local', local_cache: true, cache_filename: filename };
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveViaInvidious(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) return null;

  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const { data: results } = await axios.get(`${base}/api/v1/search`, {
        params: { q, type: 'video', sort_by: 'relevance' },
        timeout: 18_000,
        headers: { 'User-Agent': 'OpenMusic-API/1.0' },
        validateStatus: status => status < 500,
      });
      const video = Array.isArray(results)
        ? results.find(r => r.type === 'video' && r.videoId)
        : null;
      if (!video?.videoId) continue;

      const { data: info } = await axios.get(`${base}/api/v1/videos/${video.videoId}`, {
        timeout: 18_000,
        params: { local: 'true' },
        headers: { 'User-Agent': 'OpenMusic-API/1.0' },
        validateStatus: status => status < 500,
      });
      const audio = (info?.adaptiveFormats || [])
        .filter(f => f.url && (f.type || '').startsWith('audio/'))
        .sort((a, b) => (parseInt(b.bitrate, 10) || 0) - (parseInt(a.bitrate, 10) || 0))[0];
      if (!audio?.url) continue;

      console.info('[ytmusic] resolved via invidious (%s) videoId=%s', base, video.videoId);
      return {
        source: 'invidious',
        stream_url: audio.url,
        headers: { Referer: `${base}/` },
        local_cache: false,
      };
    } catch (err) {
      console.warn('[ytmusic] invidious resolve failed (%s): %s', base, err.message);
    }
  }
  return null;
}

async function resolveViaPiped(title, artist) {
  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) return null;

  for (const base of PIPED_INSTANCES) {
    try {
      const { data: search } = await axios.get(`${base}/search`, {
        params: { q, filter: 'music_songs' },
        timeout: 18_000,
        validateStatus: status => status < 500,
      });
      const item = search?.items?.[0];
      const videoId = item?.url?.match(/[?&]v=([^&]+)/)?.[1];
      if (!videoId) continue;

      const { data: streams } = await axios.get(`${base}/streams/${videoId}`, {
        timeout: 18_000,
        validateStatus: status => status < 500,
      });
      const audio = (streams?.audioStreams || [])
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      const streamUrl = audio?.proxyUrl || audio?.url;
      if (!streamUrl) continue;

      console.info('[ytmusic] resolved via piped (%s) videoId=%s', base, videoId);
      return {
        source: 'piped',
        stream_url: streamUrl,
        headers: { Referer: 'https://piped.video/' },
        local_cache: false,
      };
    } catch (err) {
      console.warn('[ytmusic] piped resolve failed (%s): %s', base, err.message);
    }
  }
  return null;
}

async function resolveViaItunesPreview(trackId) {
  try {
    const data = await itunesLookup({ id: trackId });
    const item = (data?.results || []).find(r => r.previewUrl && r.wrapperType === 'track')
      || (data?.results || []).find(r => r.previewUrl);
    if (!item?.previewUrl) return null;

    console.info('[ytmusic] resolved via iTunes preview for id=%s', trackId);
    return {
      source: 'itunes_preview',
      stream_url: item.previewUrl,
      headers: { Referer: 'https://music.apple.com/' },
      local_cache: false,
      preview_only: true,
    };
  } catch (err) {
    console.warn('[ytmusic] iTunes preview lookup failed: %s', err.message);
    return null;
  }
}

async function resolveViaPython(id, artist, title, req) {
  const { data, status } = await axios.get(`${YTMUSIC_BASE}/api/mobile/play`, {
    params: { id, artist, title },
    headers: proxyHeaders(req),
    timeout: PLAY_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (status >= 400 || !data) return null;

  if (data.source === 'local' && data.url) {
    const filename = `${id}.m4a`;
    return { source: 'local', stream_url: null, headers: {}, local_cache: true, cache_filename: filename };
  }

  if (data.direct_url) {
    return {
      source: data.source || 'youtube',
      stream_url: data.direct_url,
      headers: data.headers || {},
      local_cache: false,
    };
  }

  return null;
}

async function resolveStreamTarget(id, artist, title, req) {
  const cached = await resolveLocalCache(id);
  if (cached) return cached;

  if (YTDLP_WITH_COOKIES) {
    try {
      const py = await resolveViaPython(id, artist, title, req);
      if (py?.stream_url || py?.local_cache) return py;
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') throw err;
      console.warn('[ytmusic] Python play unavailable (cookies configured)');
    }
  }

  const invidious = await resolveViaInvidious(title, artist);
  if (invidious?.stream_url) return invidious;

  const piped = await resolveViaPiped(title, artist);
  if (piped?.stream_url) return piped;

  const preview = await resolveViaItunesPreview(id);
  if (preview?.stream_url) return preview;

  if (YTDLP_PLAY_ENABLED && !YTDLP_WITH_COOKIES) {
    try {
      const py = await resolveViaPython(id, artist, title, req);
      if (py?.stream_url || py?.local_cache) return py;
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') throw err;
      console.warn('[ytmusic] Python play unavailable');
    }
  }

  return null;
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

// ── Play stream (proxy audio — use this URL in <audio src>) ─────────────
router.get('/play/stream', async (req, res) => {
  const id = trim(req.query.id);
  const artist = trim(req.query.artist);
  const title = trim(req.query.title);
  if (!id || !artist || !title) {
    return res.status(400).json({
      error: 'missing_params',
      message: 'Query parameters id, artist, and title are required',
    });
  }

  const cacheKey = `stream:ytmusic:${id}:${artist}:${title}`.toLowerCase();
  let target = streamCache.get(cacheKey);

  try {
    if (!target) {
      target = await resolveStreamTarget(id, artist, title, req);
      if (target) streamCache.set(cacheKey, target);
    }

    if (!target) {
      return res.status(404).json({
        error: 'play_failed',
        source: SOURCE,
        message: 'Could not resolve audio for this track. YouTube blocks server playback on free cloud hosting — use JioSaavn or open the YouTube link.',
        youtube_open_url: youtubeSearchUrl(title, artist),
      });
    }

    if (target.local_cache && target.cache_filename) {
      return pipePythonCache(target.cache_filename, req, res);
    }

    if (!target.stream_url) {
      return res.status(404).json({
        error: 'play_failed',
        source: SOURCE,
        message: 'No stream URL available for this track',
        youtube_open_url: youtubeSearchUrl(title, artist),
      });
    }

    if (target.preview_only) {
      res.setHeader('X-Ytmusic-Preview', '1');
    }

    await pipeExternalStream(target.stream_url, target.headers || {}, req, res);
  } catch (err) {
    console.error('[ytmusic] play/stream error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'stream_failed', source: SOURCE, message: err.message });
    }
  }
});

// ── Play metadata (JSON — url points at /play/stream for browsers) ───────
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
    const target = await resolveStreamTarget(id, artist, title, req);
    if (!target || (!target.stream_url && !target.local_cache)) {
      return res.status(404).json({
        error: 'play_failed',
        source: SOURCE,
        message: 'Could not resolve audio for this track',
        youtube_open_url: youtubeSearchUrl(title, artist),
      });
    }

    res.json({
      source: target.source,
      url: playStreamUrl(req, id, artist, title),
      stream_url: target.stream_url,
      headers: target.headers,
      preview_only: Boolean(target.preview_only),
    });
  } catch (err) {
    const msg = err.code === 'ECONNREFUSED'
      ? 'YouTube Music service is not running (expected on port 8000)'
      : err.message;
    console.error('[ytmusic] play error:', msg);
    res.status(503).json({ error: 'source_unavailable', source: SOURCE, message: msg });
  }
});

router.get('/stream_proxy', async (req, res) => {
  const targetUrl = trim(req.query.url);
  if (!targetUrl) {
    return res.status(400).json({ error: 'missing_url', message: 'url query parameter is required' });
  }

  let extraHeaders = {};
  try {
    extraHeaders = JSON.parse(req.query.headers || '{}');
  } catch {
    extraHeaders = {};
  }

  try {
    await pipeExternalStream(targetUrl, extraHeaders, req, res);
  } catch (err) {
    console.error('[ytmusic] stream_proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'stream_failed', source: SOURCE, message: err.message });
    }
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
