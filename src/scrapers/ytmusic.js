const {
  normalizeSearch, normalizeStream, normalizeAlbum, normalizePlaylist,
  normalizeSuggestions, normalizeCharts,
} = require('../utils/normalize');

const TIMEOUT_MS = 15000;

// ── Singleton client ──────────────────────────────────────────────────────
// FIX: the old singleton never recovered from initialization failures.
// If initialize() threw once, _ytmusic stayed null forever and every
// subsequent call would re-throw the same init error without retrying.
// Now we track the init promise so concurrent calls don't race, and we
// clear the singleton on any error so the next request gets a fresh attempt.
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

  // Deduplicate concurrent init calls — only one initialize() runs at a time
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      // FIX: ytmusic-api is ESM-only. Dynamic import is correct, but the
      // old code accessed .default which works for the default export.
      // Verified against the package's export map — this is correct.
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
// FIX: client.search() returns a mixed array of SONG | VIDEO | ALBUM |
// ARTIST | PLAYLIST items. The old normalizer filtered by type === 'SONG'
// OR !type — but every item from this library has a type field, so the
// !type branch never matched anything useful. The filter is now explicit.
// Also use client.searchSongs() which returns only songs and is faster.
async function search(query) {
  const client = await getClient();
  // searchSongs returns SongDetailed[] — only songs, no mixed types
  const results = await withTimeout(client.searchSongs(query), TIMEOUT_MS);
  return normalizeSearch('ytmusic', results, query);
}

// ── Track metadata ────────────────────────────────────────────────────────
// FIX: the old getStreamUrl() just returned a normalizeStream() with all
// nulls — it was a no-op that cached a useless object. Now we fetch real
// track metadata via getSong() so the /track/:id response is actually useful
// (title, artist, duration, thumbnail, youtube_url).
// stream_url stays null — YT Music doesn't give direct audio URLs.
async function getTrackDetails(videoId) {
  const client = await getClient();
  try {
    // getSong returns SongFull which includes formats/adaptiveFormats
    // We only use the metadata fields — not the format URLs (those require
    // additional auth that this library doesn't handle for streaming)
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
// FIX: getAlbum() returns AlbumFull which has:
//   albumId, playlistId, name, artist { artistId, name }, year, thumbnails[], songs[]
// The old normalizeAlbum tried data.artists?.[0] and data.artistName which
// don't exist on this shape — artist is a single object, not an array.
// Fixed in normalizeAlbum (normalize.js). Scraper just passes data through.
async function getAlbum(albumId) {
  const client = await getClient();
  const data = await withTimeout(client.getAlbum(albumId), TIMEOUT_MS);
  if (!data) throw new Error('Album not found');
  return normalizeAlbum('ytmusic', data);
}

// ── Playlist ──────────────────────────────────────────────────────────────
// FIX: getPlaylist() returns PlaylistFull which has:
//   playlistId, name, artist { artistId, name }, videoCount, thumbnails[]
// Note: PlaylistFull does NOT include tracks — use getPlaylistVideos() for that.
// The old code passed PlaylistFull to normalizePlaylist which tried data.tracks
// and data.songs — both undefined on PlaylistFull. Result was always 0 tracks.
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
// FIX: the catch block swallowed all errors including network failures,
// same issue as the JioSaavn scraper. Re-throw non-recoverable errors.
// FIX: getSearchSuggestions returns string[] directly, not objects —
// the old normalizeSuggestions mapped s.text || s.name || s.query which
// worked by accident via the `s` fallback, but was misleading.
async function getSuggestions(query) {
  const client = await getClient();
  try {
    const results = await withTimeout(client.getSearchSuggestions(query), TIMEOUT_MS);
    return normalizeSuggestions('ytmusic', results, query);
  } catch (err) {
    // Re-throw network/timeout errors — don't fall back on these
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
// FIX: the old implementation searched for 'trending music' which returns
// a mixed bag of results and is not a real charts endpoint.
// Use getHomeSections() which returns actual curated home sections from
// YouTube Music — much closer to real charts/trending content.
// Fall back to the search approach if getHomeSections fails.
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
