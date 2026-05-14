const axios = require('axios');
const { decryptMediaUrl } = require('../utils/decrypt');
const {
  normalizeSearch, normalizeStream, normalizeAlbum, normalizePlaylist,
  normalizeSuggestions, normalizeCharts, jioSaavnSong,
} = require('../utils/normalize');

const BASE_URL = 'https://www.jiosaavn.com/api.php';

const HTTP = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.jiosaavn.com/',
  },
  params: {
    _format: 'json',
    _marker: 0,
    api_version: 4,
    ctx: 'web6dot0',
  },
});

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

async function callApi(call, params = {}) {
  try {
    const res = await HTTP.get('', {
      params: { __call: call, ...params },
    });
    return parseResponse(res.data);
  } catch (err) {
    if (err.response) {
      const msg = `JioSaavn returned ${err.response.status}`;
      throw new Error(msg);
    }
    if (err.code === 'ECONNABORTED') {
      throw new Error('JioSaavn request timed out');
    }
    throw new Error(`JioSaavn request failed: ${err.message}`);
  }
}

async function search(query) {
  const data = await callApi('search.getResults', { q: query });
  return normalizeSearch('jiosaavn', data, query);
}

async function getStreamUrl(id) {
  const songDetails = await callApi('song.getDetails', { pids: id });
  let songs = [];
  if (songDetails?.songs && Array.isArray(songDetails.songs)) {
    songs = songDetails.songs;
  } else if (Array.isArray(songDetails)) {
    songs = songDetails;
  }
  if (!songs.length) {
    throw new Error('Song not found');
  }
  const song = songs[0];
  const encUrl = song?.more_info?.encrypted_media_url || song?.encrypted_media_url;
  if (!encUrl) {
    throw new Error('No encrypted media URL found for this song');
  }
  const prefersHighQuality = song?.more_info?.['320kbps'] === 'true';

  let streamUrl;
  let quality;
  let format;
  let expiresAt = null;

  try {
    const authData = await callApi('song.generateAuthToken', { url: encUrl, bitrate: prefersHighQuality ? 320 : 128 });
    if (authData?.auth_url && authData.status === 'success') {
      streamUrl = authData.auth_url;
      format = authData.type === 'mp4' ? 'm4a' : authData.type;
      quality = `${prefersHighQuality ? 320 : 128}kbps`;
      const expMatch = streamUrl.match(/Expires=(\d+)/);
      if (expMatch) {
        expiresAt = new Date(parseInt(expMatch[1], 10) * 1000).toISOString();
      }
    } else {
      console.warn(`[jiosaavn] generateAuthToken failed for ${id}: no auth_url in response`);
      throw new Error('generateAuthToken returned no auth_url');
    }
  } catch (authErr) {
    console.warn(`[jiosaavn] Auth token generation failed for ${id}, falling back to decrypt: ${authErr.message}`);
    try {
      streamUrl = decryptMediaUrl(encUrl);
      const qualitySuffix = prefersHighQuality ? '320' : '160';
      streamUrl = streamUrl.replace(/_\d+\.(mp4|m4a|webm)/, `_${qualitySuffix}.$1`);
      quality = extractQuality(streamUrl);
      format = streamUrl?.includes('.webm') ? 'webm' : 'm4a';
    } catch (decryptErr) {
      throw new Error(`Stream URL resolution failed: ${decryptErr.message}`);
    }
  }

  return normalizeStream('jiosaavn', id, streamUrl, format, quality, expiresAt);
}

function extractQuality(url) {
  if (!url) return 'unknown';
  const m = url.match(/_(\d+)\.(mp4|m4a|webm)/);
  if (m) return `${m[1]}kbps`;
  if (url.includes('hls') || url.includes('m3u8')) return '128kbps';
  return 'unknown';
}

async function getAlbum(id) {
  const data = await callApi('content.getAlbumDetails', { albumid: id });
  return normalizeAlbum('jiosaavn', data);
}

async function getPlaylist(id) {
  const data = await callApi('playlist.getDetails', { listid: id });
  return normalizePlaylist('jiosaavn', data);
}

async function getSuggestions(query) {
  try {
    const data = await callApi('search.getSuggestions', { q: query });
    if (data?.error?.code === 'INPUT_INVALID') throw new Error('Deprecated');
    return normalizeSuggestions('jiosaavn', data, query);
  } catch {
    const data = await callApi('search.getResults', { q: query });
    let results = [];
    if (Array.isArray(data)) {
      results = data;
    } else if (data?.results && Array.isArray(data.results)) {
      results = data.results;
    }
    const suggestions = [...new Set(results.slice(0, 10).map(r => r.title || r.song).filter(Boolean))].slice(0, 8);
    return { source: 'jiosaavn', query, suggestions };
  }
}

async function getCharts() {
  const data = await callApi('content.getCharts');
  return normalizeCharts('jiosaavn', data);
}

module.exports = { search, getStreamUrl, getAlbum, getPlaylist, getSuggestions, getCharts };
