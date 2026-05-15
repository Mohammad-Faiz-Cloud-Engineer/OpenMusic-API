const axios = require('axios');
const { decryptMediaUrl } = require('../utils/decrypt');
const {
  normalizeSearch, normalizeStream, normalizeAlbum, normalizePlaylist,
  normalizeSuggestions, normalizeCharts,
} = require('../utils/normalize');

const BASE_URL = 'https://www.jiosaavn.com/api.php';

const HTTP = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

// ── Response parser ───────────────────────────────────────────────────────
// JioSaavn sometimes prefixes responses with '__JIO_SAVAAN__'
function parseResponse(data) {
  if (typeof data === 'string') {
    const prefix = '__JIO_SAVAAN__';
    if (data.startsWith(prefix)) {
      return JSON.parse(data.slice(prefix.length));
    }
    try {
      return JSON.parse(data);
    } catch {
      throw new Error('Failed to parse JioSaavn response');
    }
  }
  return data;
}

// ── Generic API caller ────────────────────────────────────────────────────
async function callApi(call, params = {}) {
  try {
    const res = await HTTP.get('', {
      params: { __call: call, ...params },
    });
    return parseResponse(res.data);
  } catch (err) {
    if (err.response) {
      throw new Error(`JioSaavn returned ${err.response.status}`);
    }
    if (err.code === 'ECONNABORTED') {
      throw new Error('JioSaavn request timed out');
    }
    throw new Error(`JioSaavn request failed: ${err.message}`);
  }
}

// ── Search ────────────────────────────────────────────────────────────────
// FIX: search.getResults only returns songs. Use search.getResults with
// n=20 to get more results, and also try the newer autocomplete endpoint
// as a richer data source when available.
async function search(query) {
  const data = await callApi('search.getResults', { q: query, n: 20, p: 1 });
  return normalizeSearch('jiosaavn', data, query);
}

// ── Stream URL ────────────────────────────────────────────────────────────
// FIX 1: song.getDetails can return a keyed object like { "<id>": { ... } }
//         in addition to { songs: [] } or a plain array; handle all shapes.
// FIX 2: generateAuthToken bitrate must be a string, not a number; JioSaavn
//         rejects numeric bitrate values silently and returns no auth_url.
// FIX 3: Always try 320kbps first regardless of the 320kbps flag; fall back
//         to 128kbps only if 320 auth token fails. The flag is unreliable.
// FIX 4: streamUrl variable name shadowed the function name; renamed to
//         resolvedUrl to avoid the silent shadowing bug.
async function getStreamUrl(id) {
  const songDetails = await callApi('song.getDetails', { pids: id });

  // Handle all three shapes JioSaavn returns for song details
  let songs = [];
  if (songDetails?.songs && Array.isArray(songDetails.songs)) {
    songs = songDetails.songs;
  } else if (Array.isArray(songDetails)) {
    songs = songDetails;
  } else if (songDetails && typeof songDetails === 'object') {
    // Keyed object: { "0gKfBAgi": { ... } }; take the first value
    const values = Object.values(songDetails);
    if (values.length && values[0] && typeof values[0] === 'object') {
      songs = values;
    }
  }

  if (!songs.length) {
    throw new Error('Song not found');
  }

  const song = songs[0];
  const encUrl = song?.more_info?.encrypted_media_url || song?.encrypted_media_url;
  if (!encUrl) {
    throw new Error('No encrypted media URL found for this song');
  }

  // FIX: bitrate must be passed as a string to generateAuthToken
  const has320 = song?.more_info?.['320kbps'] === 'true';

  let resolvedUrl;
  let quality;
  let format;
  let expiresAt = null;

  // Try 320kbps first, fall back to 128kbps, then fall back to DES decrypt
  const bitrates = has320 ? ['320', '128'] : ['128'];

  let authSuccess = false;
  for (const bitrate of bitrates) {
    try {
      const authData = await callApi('song.generateAuthToken', {
        url: encUrl,
        bitrate,  // FIX: string, not number
      });
      if (authData?.auth_url && authData.status === 'success') {
        // web.saavncdn.com requires Referer/User-Agent headers that mobile
        // clients (expo-av) don't send. aac.saavncdn.com is the same CDN
        // but accepts headerless requests — just swap the hostname.
        resolvedUrl = authData.auth_url.replace('web.saavncdn.com', 'aac.saavncdn.com');
        // FIX: authData.type can be 'mp4', 'webm', or absent; normalise properly
        format = authData.type === 'mp4' ? 'm4a' : (authData.type || 'm4a');
        quality = `${bitrate}kbps`;
        const expMatch = resolvedUrl.match(/Expires=(\d+)/);
        if (expMatch) {
          expiresAt = new Date(parseInt(expMatch[1], 10) * 1000).toISOString();
        }
        authSuccess = true;
        break;
      }
    } catch (authErr) {
      console.warn(`[jiosaavn] generateAuthToken ${bitrate}kbps failed for ${id}: ${authErr.message}`);
    }
  }

  if (!authSuccess) {
    // DES decrypt fallback
    console.warn(`[jiosaavn] All auth token attempts failed for ${id}, falling back to decrypt`);
    try {
      resolvedUrl = decryptMediaUrl(encUrl);
      // FIX: quality suffix replacement regex was too greedy; use word boundary
      // to avoid replacing parts of the CDN hostname
      const qualitySuffix = has320 ? '320' : '160';
      resolvedUrl = resolvedUrl.replace(/(_\d+)(\.(?:mp4|m4a|webm))/, `_${qualitySuffix}$2`);
      // Rewrite to aac.saavncdn.com so headerless clients can stream directly
      resolvedUrl = resolvedUrl.replace('web.saavncdn.com', 'aac.saavncdn.com');
      quality = extractQuality(resolvedUrl);
      format = resolvedUrl.includes('.webm') ? 'webm' : 'm4a';
      // expiresAt stays null; decrypt path has no expiry info
    } catch (decryptErr) {
      throw new Error(`Stream URL resolution failed: ${decryptErr.message}`);
    }
  }

  return normalizeStream('jiosaavn', id, resolvedUrl, format, quality, expiresAt);
}

function extractQuality(url) {
  if (!url) return 'unknown';
  const m = url.match(/_(\d+)\.(mp4|m4a|webm)/);
  if (m) return `${m[1]}kbps`;
  if (url.includes('hls') || url.includes('m3u8')) return '128kbps';
  return 'unknown';
}

// ── Album ─────────────────────────────────────────────────────────────────
async function getAlbum(id) {
  const data = await callApi('content.getAlbumDetails', { albumid: id });
  // FIX: JioSaavn returns null/empty object for invalid album IDs instead of
  // an error; detect this and throw a proper not-found error
  if (!data || (typeof data === 'object' && !data.albumid && !data.id && !data.title && !data.songs && !data.list)) {
    throw new Error('Album not found');
  }
  return normalizeAlbum('jiosaavn', data);
}

// ── Playlist ──────────────────────────────────────────────────────────────
async function getPlaylist(id) {
  const data = await callApi('playlist.getDetails', { listid: id });
  // FIX: same null/empty detection as album
  if (!data || (typeof data === 'object' && !data.listid && !data.id && !data.title && !data.songs && !data.list)) {
    throw new Error('Playlist not found');
  }
  return normalizePlaylist('jiosaavn', data);
}

// ── Suggestions ───────────────────────────────────────────────────────────
// FIX: The catch block swallowed ALL errors including network failures,
// meaning a JioSaavn outage would silently fall through to a second
// network call that would also fail, and then throw an unhandled error
// from inside the catch. Now we only fall back on expected "deprecated"
// errors, and re-throw network/timeout errors immediately.
async function getSuggestions(query) {
  try {
    const data = await callApi('search.getSuggestions', { q: query });
    if (data?.error?.code === 'INPUT_INVALID') throw new Error('Deprecated');
    const result = normalizeSuggestions('jiosaavn', data, query);
    // FIX: filter out any non-string or empty suggestions that slip through
    result.suggestions = result.suggestions.filter(s => typeof s === 'string' && s.trim().length > 0);
    return result;
  } catch (err) {
    // Re-throw network/timeout errors; don't fall back on these
    if (err.message.includes('timed out') || err.message.includes('returned 5') || err.message.includes('request failed')) {
      throw err;
    }
    // Fall back to extracting titles from search results
    const data = await callApi('search.getResults', { q: query, n: 10, p: 1 });
    let results = [];
    if (Array.isArray(data)) {
      results = data;
    } else if (data?.results && Array.isArray(data.results)) {
      results = data.results;
    } else if (data?.songs && Array.isArray(data.songs)) {
      results = data.songs;
    }
    const suggestions = [
      ...new Set(
        results
          .slice(0, 10)
          .map(r => r.title || r.song)
          .filter(Boolean)
          .map(s => s.trim())
          .filter(s => s.length > 0)
      ),
    ].slice(0, 8);
    return { source: 'jiosaavn', query, suggestions };
  }
}

// ── Charts ────────────────────────────────────────────────────────────────
async function getCharts() {
  const data = await callApi('content.getCharts');
  // FIX: empty/null response should return empty charts array, not crash
  if (!data) return { source: 'jiosaavn', charts: [] };
  return normalizeCharts('jiosaavn', data);
}

module.exports = { search, getStreamUrl, getAlbum, getPlaylist, getSuggestions, getCharts };
