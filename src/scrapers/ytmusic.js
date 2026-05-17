const {
  normalizeSearch, normalizeAlbum, normalizePlaylist,
  normalizeSuggestions, normalizeCharts,
} = require('../utils/normalize');

const TIMEOUT_MS = 15000;

// ── Singleton client ──────────────────────────────────────────────────────
// The singleton tracks an init promise so concurrent calls don't race.
// On any initialization error, both _ytmusic and _initPromise are cleared
// so the next request triggers a fresh attempt rather than hanging forever.
let _ytmusic = null;
let _initPromise = null;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out')), ms)
    ),
  ]);
}

async function getClient() {
  if (_ytmusic) return _ytmusic;

  // Deduplicate concurrent init calls; only one initialize() runs at a time
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      // ytmusic-api is ESM-only; dynamic import is required here.
      // .default accesses the default export from the ESM module.
      const { default: YTMusic } = await import('ytmusic-api');
      const client = new YTMusic();
      await withTimeout(client.initialize(), TIMEOUT_MS);
      _ytmusic = client;
      return _ytmusic;
    } catch (err) {
      // Clear both so the next request triggers a fresh init attempt
      _ytmusic = null;
      _initPromise = null;
      throw new Error(`YouTube Music client initialization failed: ${err.message}`);
    } finally {
      // Always clear the promise so future calls don't wait on a resolved one
      _initPromise = null;
    }
  })();

  return _initPromise;
}

// ── Search ────────────────────────────────────────────────────────────────
// searchSongs() returns SongDetailed[]: only songs, no mixed types.
async function search(query) {
  const client = await getClient();
  const results = await withTimeout(client.searchSongs(query), TIMEOUT_MS);
  return normalizeSearch('ytmusic', results, query);
}

// ── Track metadata ────────────────────────────────────────────────────────
// Fetches real track metadata via getSong() so the /track/:id response
// includes title, artist, duration, thumbnail, and youtube_url.
// stream_url stays null; YT Music does not provide direct audio URLs.
async function getTrackDetails(videoId) {
  const client = await getClient();
  try {
    const data = await withTimeout(client.getSong(videoId), TIMEOUT_MS);
    return {
      id: data.videoId,
      source: 'ytmusic',
      title: data.name || '',
      artist: data.artist?.name || 'Unknown',
      duration_seconds: typeof data.duration === 'number' ? data.duration : 0,
      thumbnail: pickBestThumbnail(data.thumbnails),
      youtube_url: `https://www.youtube.com/watch?v=${data.videoId}`,
      stream_url: null,
    };
  } catch (err) {
    // If getSong fails (e.g. video unavailable), return minimal metadata
    // so the endpoint still responds with something useful
    return {
      id: videoId,
      source: 'ytmusic',
      title: null,
      artist: null,
      duration_seconds: 0,
      thumbnail: null,
      youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
      stream_url: null,
    };
  }
}

// Keep the old name for route compatibility
async function getStreamUrl(videoId) {
  return getTrackDetails(videoId);
}

// ── Album ─────────────────────────────────────────────────────────────────
// getAlbum() returns AlbumFull:
//   { albumId, playlistId, name, artist { artistId, name }, year, thumbnails[], songs[] }
async function getAlbum(albumId) {
  const client = await getClient();
  const data = await withTimeout(client.getAlbum(albumId), TIMEOUT_MS);
  if (!data) throw new Error('Album not found');
  return normalizeAlbum('ytmusic', data);
}

// ── Playlist ──────────────────────────────────────────────────────────────
// getPlaylist() returns PlaylistFull which does NOT include tracks.
// getPlaylistVideos() is called separately and merged in.
async function getPlaylist(playlistId) {
  const client = await getClient();

  // Fetch playlist metadata and its videos in parallel
  const [playlistData, videosData] = await Promise.all([
    withTimeout(client.getPlaylist(playlistId), TIMEOUT_MS),
    withTimeout(client.getPlaylistVideos(playlistId), TIMEOUT_MS),
  ]);

  if (!playlistData) throw new Error('Playlist not found');

  // Merge videos into the playlist object so normalizePlaylist can find them
  const merged = { ...playlistData, tracks: videosData || [] };
  return normalizePlaylist('ytmusic', merged);
}

// ── Suggestions ───────────────────────────────────────────────────────────
// Re-throws network/timeout errors rather than silently falling back.
// Falls back to song name extraction only for expected library errors.
async function getSuggestions(query) {
  const client = await getClient();
  try {
    const results = await withTimeout(client.getSearchSuggestions(query), TIMEOUT_MS);
    return normalizeSuggestions('ytmusic', results, query);
  } catch (err) {
    // Re-throw network/timeout errors; don't fall back on these
    if (err.message.includes('timed out') || err.message.includes('initialization failed')) {
      throw err;
    }
    // Fall back to extracting song names from search results
    const results = await withTimeout(client.searchSongs(query), TIMEOUT_MS);
    const songs = Array.isArray(results) ? results : [];
    const suggestions = [
      ...new Set(
        songs
          .slice(0, 8)
          .map(s => s.name || s.title)
          .filter(Boolean)
      ),
    ];
    return { source: 'ytmusic', query, suggestions };
  }
}

// ── Charts ────────────────────────────────────────────────────────────────
// Uses getHomeSections() for actual curated home sections from YT Music.
// Falls back to a trending search if getHomeSections fails.
async function getCharts() {
  const client = await getClient();
  try {
    const sections = await withTimeout(client.getHomeSections(), TIMEOUT_MS);
    return normalizeCharts('ytmusic', sections);
  } catch {
    // Fall back to trending search
    try {
      const results = await withTimeout(client.searchSongs('trending music india'), TIMEOUT_MS);
      return normalizeCharts('ytmusic', results);
    } catch {
      throw new Error('YouTube Music charts unavailable');
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function pickBestThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

module.exports = { search, getStreamUrl, getAlbum, getPlaylist, getSuggestions, getCharts };
