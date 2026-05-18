const axios = require('axios');
const {
  normalizeSearch,
  normalizeStream,
  normalizeAlbum,
  normalizePlaylist,
  normalizeSuggestions,
  normalizeCharts,
  decodeHtmlEntities,
} = require('./normalize');

// ── YTM internal API base ─────────────────────────────────────────────────
// The youtubei/v1 endpoint is the same internal API the YTM web client uses.
// No API key is required for search and suggestions; the client context
// object is sufficient for anonymous requests.
const YTM_BASE = 'https://music.youtube.com/youtubei/v1';

// ── JioSaavn base (Smart Track Replacement) ───────────────────────────────
// YTM audio streams are protected by rotating signature ciphers. Instead of
// attempting to crack them, we resolve the stream by searching JioSaavn for
// the same song and streaming from their CDN. The caller sees YTM metadata;
// the audio comes from JioSaavn's robust, publicly accessible CDN.
const JIOSAAVN_BASE = 'https://www.jiosaavn.com/api.php';

// ── Client context ────────────────────────────────────────────────────────
// YTM requires a client context block in every POST body. WEB_REMIX is the
// standard web client identity. Pinning a specific clientVersion avoids
// unexpected breakage when YTM rolls out new API shapes.
function buildContext() {
  return {
    context: {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20230522.01.00',
        hl: 'en',
        gl: 'US',
      },
    },
  };
}

// ── HTTP clients ──────────────────────────────────────────────────────────
const YTM_HTTP = axios.create({
  baseURL: YTM_BASE,
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://music.youtube.com/',
    'Origin': 'https://music.youtube.com',
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-YouTube-Client-Name': '67',
    'X-YouTube-Client-Version': '1.20230522.01.00',
  },
});

const SAAVN_HTTP = axios.create({
  baseURL: JIOSAAVN_BASE,
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.jiosaavn.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  params: {
    _format: 'json',
    _marker: 0,
    api_version: 4,
    ctx: 'web6dot0',
  },
});

// ── Generic YTM POST caller ───────────────────────────────────────────────
async function ytmPost(path, body = {}) {
  try {
    const res = await YTM_HTTP.post(path, { ...buildContext(), ...body });
    return res.data;
  } catch (err) {
    if (err.response) {
      throw new Error(`YouTube Music returned ${err.response.status}`);
    }
    if (err.code === 'ECONNABORTED') {
      throw new Error('YouTube Music request timed out');
    }
    throw new Error(`YouTube Music request failed: ${err.message}`);
  }
}

// ── Generic JioSaavn GET caller (for Smart Track Replacement) ─────────────
async function saavnGet(call, params = {}) {
  try {
    const res = await SAAVN_HTTP.get('', {
      params: { __call: call, ...params },
    });
    // JioSaavn sometimes prefixes responses with '__JIO_SAVAAN__'
    const raw = res.data;
    if (typeof raw === 'string') {
      const prefix = '__JIO_SAVAAN__';
      if (raw.startsWith(prefix)) return JSON.parse(raw.slice(prefix.length));
      try { return JSON.parse(raw); } catch { throw new Error('Failed to parse JioSaavn response'); }
    }
    return raw;
  } catch (err) {
    if (err.response) throw new Error(`JioSaavn returned ${err.response.status}`);
    if (err.code === 'ECONNABORTED') throw new Error('JioSaavn request timed out');
    throw new Error(`JioSaavn request failed: ${err.message}`);
  }
}

// ── Search ────────────────────────────────────────────────────────────────
async function search(query) {
  const data = await ytmPost('/search', { query });
  return normalizeSearch(data, query);
}

// ── Suggestions ───────────────────────────────────────────────────────────
async function getSuggestions(query) {
  try {
    const data = await ytmPost('/music/get_search_suggestions', { input: query });
    const result = normalizeSuggestions(data, query);

    // If YTM returned nothing useful, fall back to extracting titles from search
    if (!result.suggestions.length) {
      const searchData = await ytmPost('/search', { query });
      const normalized = normalizeSearch(searchData, query);
      const suggestions = [
        ...new Set(
          normalized.results
            .slice(0, 10)
            .map(r => r.title)
            .filter(Boolean)
            .map(s => s.trim())
            .filter(s => s.length > 0)
        ),
      ].slice(0, 8);
      return { source: 'youtube', query, suggestions };
    }

    return result;
  } catch (err) {
    // Re-throw network/timeout errors; don't swallow infrastructure failures
    if (
      err.message.includes('timed out') ||
      err.message.includes('returned 5') ||
      err.message.includes('request failed')
    ) {
      throw err;
    }
    // Suggestions are non-critical; fall back to search titles
    const searchData = await ytmPost('/search', { query });
    const normalized = normalizeSearch(searchData, query);
    const suggestions = [
      ...new Set(
        normalized.results
          .slice(0, 10)
          .map(r => r.title)
          .filter(Boolean)
          .map(s => s.trim())
          .filter(s => s.length > 0)
      ),
    ].slice(0, 8);
    return { source: 'youtube', query, suggestions };
  }
}

// ── Smart Track Replacement ───────────────────────────────────────────────
// Resolves a playable stream URL for a YTM track by searching JioSaavn.
// Strategy (in order):
//   1. song.generateAuthToken at 320kbps on the first JioSaavn match
//   2. song.generateAuthToken at 128kbps
//   3. DES-decrypt fallback via the JioSaavn scraper (imported lazily to
//      avoid a circular dependency at module load time)
//
// Returns a normalizeStream-shaped object with source='youtube' so the
// caller always sees a consistent shape regardless of which path succeeded.
async function resolveStreamViaSaavn(ytmTrack) {
  // Build a clean search query: "Title Artist" with "Unknown" stripped out
  const queryParts = [ytmTrack.title, ytmTrack.artist]
    .map(s => (s && s !== 'Unknown' ? s.trim() : ''))
    .filter(Boolean);

  if (!queryParts.length) {
    throw new Error('Insufficient track metadata for Smart Track Replacement');
  }

  const query = queryParts.join(' ');

  // Step 1: search JioSaavn for the track
  const searchData = await saavnGet('search.getResults', { q: query, n: 5, p: 1 });

  let songs = [];
  if (Array.isArray(searchData)) songs = searchData;
  else if (searchData?.results && Array.isArray(searchData.results)) songs = searchData.results;
  else if (searchData?.songs && Array.isArray(searchData.songs)) songs = searchData.songs;

  if (!songs.length) {
    throw new Error(`Smart Track Replacement: no JioSaavn results for "${query}"`);
  }

  const match = songs[0];
  const encUrl = match?.more_info?.encrypted_media_url || match?.encrypted_media_url;

  if (!encUrl) {
    throw new Error('Smart Track Replacement: JioSaavn match has no encrypted_media_url');
  }

  const has320 = match?.more_info?.['320kbps'] === 'true';
  const bitrates = has320 ? ['320', '128'] : ['128'];

  // Step 2: try auth token generation at each bitrate
  for (const bitrate of bitrates) {
    try {
      const authData = await saavnGet('song.generateAuthToken', { url: encUrl, bitrate });
      if (authData?.auth_url && authData.status === 'success') {
        const streamUrl = authData.auth_url.replace('web.saavncdn.com', 'aac.saavncdn.com');
        const format = authData.type === 'mp4' ? 'm4a' : (authData.type || 'm4a');
        const quality = `${bitrate}kbps`;

        let expiresAt = null;
        const expMatch = streamUrl.match(/Expires=(\d+)/);
        if (expMatch) {
          expiresAt = new Date(parseInt(expMatch[1], 10) * 1000).toISOString();
        }

        return normalizeStream(ytmTrack.id, streamUrl, format, quality, expiresAt);
      }
    } catch (authErr) {
      console.warn(
        `[youtube] generateAuthToken ${bitrate}kbps failed for "${query}": ${authErr.message}`
      );
    }
  }

  // Step 3: DES decrypt fallback — lazy-require to avoid circular deps
  console.warn(`[youtube] All auth token attempts failed for "${query}", falling back to decrypt`);
  try {
    const { decryptMediaUrl } = require('../Jio Saavn/decrypt');
    let resolvedUrl = decryptMediaUrl(encUrl);
    const qualitySuffix = has320 ? '320' : '160';
    resolvedUrl = resolvedUrl.replace(/(_\d+)(\.(?:mp4|m4a|webm))/, `_${qualitySuffix}$2`);
    resolvedUrl = resolvedUrl.replace('web.saavncdn.com', 'aac.saavncdn.com');

    const format = resolvedUrl.includes('.webm') ? 'webm' : 'm4a';
    const qualityMatch = resolvedUrl.match(/_(\d+)\.(mp4|m4a|webm)/);
    const quality = qualityMatch ? `${qualityMatch[1]}kbps` : 'unknown';

    return normalizeStream(ytmTrack.id, resolvedUrl, format, quality, null);
  } catch (decryptErr) {
    throw new Error(`Smart Track Replacement failed: ${decryptErr.message}`);
  }
}

// ── Stream URL (public entry point) ──────────────────────────────────────
async function getStreamUrl(id, trackMeta) {
  // trackMeta is the Track object from a prior search result. It carries
  // title + artist which are needed for Smart Track Replacement. When it is
  // absent (e.g. a direct /track/:id call with no prior search), we do a
  // YTM search for the video ID to recover the metadata first.
  let track = trackMeta;

  if (!track || !track.title || track.title === 'Unknown') {
    // Recover metadata by searching YTM for the video ID directly.
    // YTM doesn't have a song.getDetails equivalent for anonymous clients,
    // so we use the watch endpoint to get the title from the player response.
    track = await fetchTrackMetaById(id);
  }

  return resolveStreamViaSaavn(track);
}

// ── Metadata recovery via YTM next endpoint ───────────────────────────────
// When we only have a videoId (e.g. direct /track/:id call), we hit the
// /next endpoint which returns the queue context including the track title
// and artist without requiring auth.
async function fetchTrackMetaById(id) {
  try {
    const data = await ytmPost('/next', {
      videoId: id,
      isAudioOnly: true,
    });

    // Walk the response to find the first musicResponsiveListItemRenderer
    const tabs =
      data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs || [];

    for (const tab of tabs) {
      const items =
        tab?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer?.contents || [];

      for (const item of items) {
        const renderer = item?.playlistPanelVideoRenderer;
        if (!renderer) continue;

        const titleRuns = renderer.title?.runs || [];
        const title = decodeHtmlEntities(
          titleRuns.map(r => r.text || '').join('').trim()
        );

        const longBylineRuns = renderer.longBylineText?.runs || [];
        const artist = longBylineRuns
          .filter(r => r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
            ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST')
          .map(r => decodeHtmlEntities(r.text || ''))
          .filter(Boolean)
          .join(', ') || 'Unknown';

        if (title) {
          return { id, title, artist, album: '', duration_seconds: 0 };
        }
      }
    }
  } catch (err) {
    console.warn(`[youtube] fetchTrackMetaById failed for ${id}: ${err.message}`);
  }

  // Last resort: use the ID itself as a minimal track object
  return { id, title: id, artist: 'Unknown', album: '', duration_seconds: 0 };
}

// ── Album ─────────────────────────────────────────────────────────────────
// YTM album/playlist detail APIs require auth for anonymous clients.
// Return a clear not-implemented error rather than silently returning empty.
async function getAlbum(id) {
  throw new Error('YouTube Music album details require authentication and are not supported');
}

// ── Playlist ──────────────────────────────────────────────────────────────
async function getPlaylist(id) {
  throw new Error('YouTube Music playlist details require authentication and are not supported');
}

// ── Charts ────────────────────────────────────────────────────────────────
// YTM charts (Hotlist, etc.) require a logged-in session. Return a
// consistent empty shape rather than an error so the UI degrades gracefully.
async function getCharts() {
  return normalizeCharts(null);
}

module.exports = {
  search,
  getStreamUrl,
  getAlbum,
  getPlaylist,
  getSuggestions,
  getCharts,
};
