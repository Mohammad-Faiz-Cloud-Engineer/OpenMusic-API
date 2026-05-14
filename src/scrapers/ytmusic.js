const {
  normalizeSearch, normalizeStream, normalizeAlbum, normalizePlaylist,
  normalizeSuggestions, normalizeCharts,
} = require('../utils/normalize');

let _ytmusic = null;

async function getClient() {
  if (!_ytmusic) {
    const YTMusic = (await import('ytmusic-api')).default;
    _ytmusic = new YTMusic();
    await _ytmusic.initialize();
  }
  return _ytmusic;
}

async function search(query) {
  const client = await getClient();
  const results = await client.search(query);
  return normalizeSearch('ytmusic', results, query);
}

async function getStreamUrl(videoId) {
  return normalizeStream('ytmusic', videoId, null, null, null, null);
}

async function getAlbum(albumId) {
  const client = await getClient();
  const data = await client.getAlbum(albumId);
  return normalizeAlbum('ytmusic', data);
}

async function getPlaylist(playlistId) {
  const client = await getClient();
  const data = await client.getPlaylist(playlistId);
  return normalizePlaylist('ytmusic', data);
}

async function getSuggestions(query) {
  const client = await getClient();
  try {
    const results = await client.getSearchSuggestions(query);
    return normalizeSuggestions('ytmusic', results, query);
  } catch {
    const results = await client.search(query);
    const songs = Array.isArray(results) ? results.filter(r => r.type === 'SONG') : [];
    const suggestions = [...new Set(songs.slice(0, 8).map(s => s.name || s.title).filter(Boolean))];
    return { source: 'ytmusic', query, suggestions };
  }
}

async function getCharts() {
  const client = await getClient();
  try {
    const results = await client.search('trending music');
    return normalizeCharts('ytmusic', results);
  } catch {
    throw new Error('YouTube Music charts unavailable');
  }
}

module.exports = { search, getStreamUrl, getAlbum, getPlaylist, getSuggestions, getCharts };
