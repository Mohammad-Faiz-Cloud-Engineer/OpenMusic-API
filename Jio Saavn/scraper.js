const axios = require('axios');
const { decryptMediaUrl } = require('./decrypt');
const {
  normalizeSearch, normalizeStream, normalizeAlbum, normalizePlaylist,
  normalizeSuggestions, normalizeCharts,
} = require('./normalize');

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
async function search(query) {
  const data = await callApi('search.getResults', { q: query, n: 20, p: 1 });
  return normalizeSearch('jiosaavn', data, query);
}

// ── Stream URL ────────────────────────────────────────────────────────────
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

  const has320 = song?.more_info?.['320kbps'] === 'true';

  let resolvedUrl;
  let quality;
  let format;
  let expiresAt = null;

  // Always attempt 320kbps first regardless of the has320 flag — the flag is
  // unreliable across API response shapes. Fall back to 160kbps, then 128kbps,
  // then the DES decrypt path as a last resort.
  const bitrates = has320 ? ['320', '160', '128'] : ['320', '160', '128'];

  let authSuccess = false;
  for (const bitrate of bitrates) {
    try {
      const authData = await callApi('song.generateAuthToken', {
        url: encUrl,
        bitrate,  // must be a string, not a number
      });
      if (authData?.auth_url && authData.status === 'success') {
        resolvedUrl = authData.auth_url.replace('web.saavncdn.com', 'aac.saavncdn.com');
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
      // Always target 320kbps in the URL; the CDN will serve the highest
      // available bitrate if 320 isn't present for this track.
      resolvedUrl = resolvedUrl.replace(/(_\d+)(\.(?:mp4|m4a|webm))/, `_320$2`);
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
  if (!data || (typeof data === 'object' && !data.albumid && !data.id && !data.title && !data.songs && !data.list)) {
    throw new Error('Album not found');
  }
  return normalizeAlbum('jiosaavn', data);
}

// ── Playlist ──────────────────────────────────────────────────────────────
async function getPlaylist(id) {
  const data = await callApi('playlist.getDetails', { listid: id });
  if (!data || (typeof data === 'object' && !data.listid && !data.id && !data.title && !data.songs && !data.list)) {
    throw new Error('Playlist not found');
  }
  return normalizePlaylist('jiosaavn', data);
}

// ── Suggestions ───────────────────────────────────────────────────────────
async function getSuggestions(query) {
  try {
    const data = await callApi('search.getSuggestions', { q: query });
    if (data?.error?.code === 'INPUT_INVALID') throw new Error('Deprecated');
    const result = normalizeSuggestions('jiosaavn', data, query);
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
  if (!data) return { source: 'jiosaavn', charts: [] };
  return normalizeCharts('jiosaavn', data);
}

module.exports = { search, getStreamUrl, getAlbum, getPlaylist, getSuggestions, getCharts };
