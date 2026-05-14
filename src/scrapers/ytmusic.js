const {
  normalizeSearch, normalizeStream, normalizeAlbum, normalizePlaylist,
  normalizeSuggestions, normalizeCharts,
} = require('../utils/normalize');

const TIMEOUT_MS = 15000;

let _ytmusic = null;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms)),
  ]);
}

async function getClient() {
  if (_ytmusic) return _ytmusic;
  try {
    const YTMusic = (await import('ytmusic-api')).default;
    _ytmusic = new YTMusic();
    await withTimeout(_ytmusic.initialize(), TIMEOUT_MS);
  } catch (err) {
    _ytmusic = null;
    throw err;
  }
  return _ytmusic;
}

async function search(query) {
  const client = await getClient();
  const results = await withTimeout(client.search(query), TIMEOUT_MS);
  return normalizeSearch('ytmusic', results, query);
}

async function getStreamUrl(videoId) {
  return normalizeStream('ytmusic', videoId, null, null, null, null);
}

async function getAlbum(albumId) {
  const client = await getClient();
  const data = await withTimeout(client.getAlbum(albumId), TIMEOUT_MS);
  return normalizeAlbum('ytmusic', data);
}

async function getPlaylist(playlistId) {
  const client = await getClient();
  const data = await withTimeout(client.getPlaylist(playlistId), TIMEOUT_MS);
  return normalizePlaylist('ytmusic', data);
}

async function getSuggestions(query) {
  const client = await getClient();
  try {
    const results = await withTimeout(client.getSearchSuggestions(query), TIMEOUT_MS);
    return normalizeSuggestions('ytmusic', results, query);
  } catch {
    const results = await withTimeout(client.search(query), TIMEOUT_MS);
    const songs = Array.isArray(results) ? results.filter(r => r.type === 'SONG') : [];
    const suggestions = [...new Set(songs.slice(0, 8).map(s => s.name || s.title).filter(Boolean))];
    return { source: 'ytmusic', query, suggestions };
  }
}

async function getCharts() {
  const client = await getClient();
  try {
    const results = await withTimeout(client.search('trending music'), TIMEOUT_MS);
    return normalizeCharts('ytmusic', results);
  } catch {
    throw new Error('YouTube Music charts unavailable');
  }
}

module.exports = { search, getStreamUrl, getAlbum, getPlaylist, getSuggestions, getCharts };
