function trim(v) {
  return typeof v === 'string' ? v.trim() : v;
}

// ── YT Music thumbnail picker ─────────────────────────────────────────────
function pickThumbnail(thumbnails) {
  if (!thumbnails) return null;
  // Handle both array and single object
  const arr = Array.isArray(thumbnails) ? thumbnails : [thumbnails];
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

// ── JioSaavn thumbnail extractor ──────────────────────────────────────────
// JioSaavn image field can be an array of { quality, link } objects (newer
// API responses) or a plain string (original shape). Always return 500x500.
function extractJioSaavnThumbnail(item) {
  if (!item) return null;
  const img = item.image;
  if (!img) return null;

  // Array of { quality, link } objects (newer JioSaavn API shape)
  if (Array.isArray(img)) {
    // Last item is usually the largest quality
    const best = img[img.length - 1];
    const url = best?.link || best?.url || best;
    if (typeof url === 'string') {
      return url.replace('150x150', '500x500').replace('50x50', '500x500');
    }
    return null;
  }

  // Plain string (original shape)
  if (typeof img === 'string') {
    return img.replace('150x150', '500x500').replace('50x50', '500x500');
  }

  return null;
}

// ── JioSaavn artist extractor ─────────────────────────────────────────────
// Use primary_artists first for a cleaner display name, fall back through
// all artists, subtitle, music field, and top-level artist_map.
function extractJioSaavnArtist(item) {
  const mi = item.more_info;

  // Primary artists first (cleanest)
  if (mi?.artistMap?.primary_artists?.length) {
    const names = [...new Set(mi.artistMap.primary_artists.map(a => a.name).filter(Boolean))];
    if (names.length) return names.join(', ');
  }

  // All artists fallback
  if (mi?.artistMap?.artists?.length) {
    const names = [...new Set(mi.artistMap.artists.map(a => a.name).filter(Boolean))];
    if (names.length) return names.join(', ');
  }

  // subtitle field: "Artist Name - Album Name" format
  if (item.subtitle) {
    const parts = item.subtitle.split(' - ');
    if (parts.length > 1) return parts[0].trim();
    return item.subtitle.trim();
  }

  // music field (older API)
  if (mi?.music) return mi.music;

  // Top-level artist_map (some endpoints)
  if (item.artist_map?.primary_artists?.length) {
    const names = [...new Set(item.artist_map.primary_artists.map(a => a.name).filter(Boolean))];
    if (names.length) return names.join(', ');
  }

  return 'Unknown';
}

// ── HTML entity decoder ───────────────────────────────────────────────────
// JioSaavn returns titles with HTML entities — decode them without a DOM
// (Node.js safe). Handles both decimal NCRs (&#39;) and hex NCRs (&#x2019;).
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  // Decode &amp; last so double-encoded sequences (e.g. &amp;lt;) are not
  // fully unescaped into meta-characters like '<'.
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    // Hex numeric character references (e.g. &#x2019; / &#X2019; → ')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Decimal numeric character references (e.g. &#8217; → ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&amp;/g, '&');
}

// ── JioSaavn song normalizer ──────────────────────────────────────────────
// id fallback uses perma_url slug — never the encrypted_media_url blob.
// title can have HTML entities — decoded here.
function jioSaavnSong(item) {
  let id = item.id || '';
  if (!id && item.perma_url) {
    const parts = item.perma_url.split('/');
    id = parts[parts.length - 1] || '';
  }

  return {
    id,
    title: decodeHtmlEntities(item.title || ''),
    artist: extractJioSaavnArtist(item),
    album: decodeHtmlEntities(item.more_info?.album || item.album || ''),
    duration_seconds: parseInt(item.duration || item.more_info?.duration || '0', 10) || 0,
    thumbnail: extractJioSaavnThumbnail(item),
    language: item.more_info?.language || item.language || null,
    has_lyrics: item.more_info?.has_lyrics === 'true' || item.has_lyrics === 'true' || false,
    explicit: item.explicit_content === '1' || item.explicit_content === 1 || false,
    stream_url: null,  // always null — caller must hit /track/:id
  };
}

// ── JioSaavn search results parser ───────────────────────────────────────
// Filter out non-song results (albums, artists, playlists) — only keep
// items with a duration field.
function jioSaavnSearchResults(data) {
  let results = [];
  if (Array.isArray(data)) {
    results = data;
  } else if (data?.results && Array.isArray(data.results)) {
    results = data.results;
  } else if (data?.entities && Array.isArray(data.entities)) {
    results = data.entities;
  } else if (data?.songs && Array.isArray(data.songs)) {
    results = data.songs;
  }

  return results
    .filter(item => {
      if (!item) return false;
      const hasDuration = item.duration || item.more_info?.duration;
      const type = item.type || item.more_info?.type;
      if (type && ['album', 'artist', 'playlist', 'show', 'episode'].includes(type)) return false;
      return hasDuration || !type;
    })
    .map(jioSaavnSong);
}

// ── YT Music song normalizer ──────────────────────────────────────────────
// Handles SongDetailed shape from searchSongs() / getAlbum().songs:
//   { type: 'SONG', videoId, name, artist: { artistId, name },
//     album: { albumId, name } | null, duration: number | null, thumbnails[] }
// Also handles PlaylistVideo shape from getPlaylistVideos():
//   { type: 'SONG', videoId, title, artists: { artistId, name },
//     duration: number, thumbnails[] }
// SongDetailed uses item.artist (single object).
// PlaylistVideo uses item.artists (single object, confusingly named).
function ytmusicSong(item) {
  const tn = item.thumbnails || item.thumbnail;

  const artistObj = item.artist || item.artists || null;
  const artist = artistObj?.name || 'Unknown';

  const album = item.album?.name || null;

  // duration is a plain number (seconds), not a totalSeconds object
  const duration = typeof item.duration === 'number'
    ? item.duration
    : parseInt(item.duration || '0', 10) || 0;

  return {
    id: item.videoId || item.id || '',
    title: item.name || item.title || '',
    artist,
    album,
    duration_seconds: duration,
    thumbnail: pickThumbnail(tn),
    language: null,
    has_lyrics: false,
    explicit: false,
    stream_url: null,
  };
}

function ytmusicSearchResults(data) {
  if (!data || !Array.isArray(data)) return [];
  return data
    .filter(d => d.type === 'SONG' || d.type === 'VIDEO' || !d.type)
    .map(ytmusicSong);
}

// ── Exported normalizers ──────────────────────────────────────────────────

function normalizeSearch(source, data, query) {
  if (source === 'jiosaavn') {
    return { source, query, results: jioSaavnSearchResults(data) };
  }
  return { source, query, results: ytmusicSearchResults(data) };
}

function normalizeStream(source, id, streamUrl, format, quality, expiresAt) {
  return {
    id,
    source,
    quality: quality || 'unknown',
    format: format || 'm4a',
    stream_url: streamUrl,
    expires_at: expiresAt || null,
  };
}

function normalizeAlbum(source, data) {
  if (source === 'jiosaavn') {
    const tn = extractJioSaavnThumbnail(data);
    let tracks = [];
    if (data.songs && Array.isArray(data.songs)) {
      tracks = data.songs.map((s, i) => ({ ...jioSaavnSong(s), track_number: i + 1 }));
    } else if (data.list && Array.isArray(data.list)) {
      tracks = data.list.map((s, i) => ({ ...jioSaavnSong(s), track_number: i + 1 }));
    }

    let artist = 'Unknown';
    const pa =
      data.more_info?.artistMap?.primary_artists ||
      data.artist_map?.primary_artists;
    if (pa && Array.isArray(pa) && pa.length) {
      const names = [...new Set(pa.map(a => a.name.trim()).filter(Boolean))];
      if (names.length) artist = names.join(', ');
    } else if (tracks.length) {
      const unique = [...new Set(tracks.map(t => t.artist))].filter(a => a && a !== 'Unknown');
      if (unique.length) artist = unique[0];
    }

    return {
      source,
      id: data.albumid || data.id || '',
      title: decodeHtmlEntities(data.title || data.name || ''),
      artist,
      year: parseInt(data.year || '0', 10) || 0,
      song_count: parseInt(data.song_count || tracks.length, 10) || tracks.length,
      duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
      thumbnail: tn,
      language: data.more_info?.language || data.language || null,
      tracks,
    };
  }

  // YT Music album — AlbumFull shape:
  // { type:'ALBUM', albumId, playlistId, name, artist:{artistId,name},
  //   year: number|null, thumbnails[], songs: SongDetailed[] }
  const tn = pickThumbnail(data.thumbnails || data.thumbnail);
  const artist = data.artist?.name || 'Unknown';
  let tracks = [];
  const songList = data.songs || data.tracks || [];
  if (Array.isArray(songList)) {
    tracks = songList.map((t, i) => ({
      ...ytmusicSong(t),
      track_number: i + 1,
    }));
  }
  return {
    source,
    id: data.albumId || data.browseId || data.id || '',
    title: data.name || data.title || '',
    artist,
    year: data.year || 0,
    song_count: data.trackCount || tracks.length || 0,
    duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
    thumbnail: tn,
    language: null,
    tracks,
  };
}

function normalizePlaylist(source, data) {
  if (source === 'jiosaavn') {
    const tn = extractJioSaavnThumbnail(data);
    let tracks = [];
    if (data.songs && Array.isArray(data.songs)) {
      tracks = data.songs.map(jioSaavnSong);
    } else if (data.list && Array.isArray(data.list)) {
      tracks = data.list.map(jioSaavnSong);
    }

    tracks = tracks.map((t, i) => ({ ...t, track_number: i + 1 }));

    return {
      source,
      id: data.listid || data.id || '',
      title: decodeHtmlEntities(data.title || data.listname || ''),
      owner: data.more_info?.username || data.more_info?.firstname || data.username || data.owner || 'JioSaavn',
      song_count: parseInt(data.song_count || tracks.length, 10) || tracks.length,
      duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
      thumbnail: tn,
      tracks,
    };
  }

  // YT Music playlist — merged shape from scraper:
  // PlaylistFull: { type:'PLAYLIST', playlistId, name, artist:{artistId,name},
  //                 videoCount, thumbnails[] }
  // + tracks: PlaylistVideo[] injected by the scraper via getPlaylistVideos()
  const tn = pickThumbnail(data.thumbnails || data.thumbnail);
  const owner = data.artist?.name || data.owner || data.ownerName || 'Unknown';
  let tracks = [];
  const plSongs = data.tracks || data.songs || [];
  if (Array.isArray(plSongs)) {
    tracks = plSongs.map((t, i) => ({ ...ytmusicSong(t), track_number: i + 1 }));
  }
  return {
    source,
    id: data.playlistId || data.browseId || data.id || '',
    title: data.name || data.title || '',
    owner,
    song_count: data.videoCount || data.trackCount || tracks.length || 0,
    duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
    thumbnail: tn,
    tracks,
  };
}

function normalizeSuggestions(source, data, query) {
  if (source === 'jiosaavn') {
    let suggestions = [];
    if (Array.isArray(data)) {
      suggestions = data.map(s => (typeof s === 'string' ? s : s.text || s.title || '')).filter(Boolean);
    } else if (data?.suggestions && Array.isArray(data.suggestions)) {
      suggestions = data.suggestions.map(s => (typeof s === 'string' ? s : s.text || s.title || '')).filter(Boolean);
    }
    suggestions = [...new Set(suggestions.map(s => s.trim()).filter(s => s.length > 0))];
    return { source, query, suggestions };
  }

  // YT Music suggestions — getSearchSuggestions() returns string[] directly
  let suggestions = [];
  if (Array.isArray(data)) {
    suggestions = data
      .map(s => (typeof s === 'string' ? s : s.text || s.name || s.query || ''))
      .filter(Boolean);
  }
  return { source, query, suggestions };
}

function normalizeCharts(source, data) {
  if (source === 'jiosaavn') {
    let charts = [];

    const mapChart = c => ({
      id: c.id || c.chart_id || c.listid || c.tab_id || '',
      title: decodeHtmlEntities(c.title || c.name || ''),
      description: c.subtitle || c.description || (c.song_count ? `${c.song_count} songs` : ''),
      thumbnail: extractJioSaavnThumbnail(c),
    });

    if (data?.charts && Array.isArray(data.charts)) {
      charts = data.charts.map(mapChart);
    } else if (data?.tabs && Array.isArray(data.tabs)) {
      charts = data.tabs.map(mapChart);
    } else if (Array.isArray(data)) {
      charts = data.map(mapChart);
    }

    // Filter out charts with no id — they can't be loaded
    charts = charts.filter(c => c.id);

    return { source, charts };
  }

  // YT Music charts — two possible inputs:
  // 1. getHomeSections() → HomeSection[]: [{ title, contents: (AlbumDetailed|PlaylistDetailed|SongDetailed)[] }]
  // 2. searchSongs() fallback → SongDetailed[]
  if (Array.isArray(data)) {
    // Check if it's HomeSection[] (objects with title + contents array)
    if (data.length > 0 && data[0]?.contents !== undefined) {
      const charts = data
        .filter(section => section.title && Array.isArray(section.contents) && section.contents.length > 0)
        .map(section => {
          // Only use PLAYLIST or ALBUM entries as chart IDs — SongDetailed
          // videoIds cannot be loaded as a playlist/chart, so skip them.
          const playlist = section.contents.find(c => c.type === 'PLAYLIST');
          const album = section.contents.find(c => c.type === 'ALBUM');
          const representative = playlist || album;
          if (!representative) return null;
          return {
            id: representative.playlistId || representative.albumId || '',
            title: section.title,
            description: `${section.contents.length} items`,
            thumbnail: pickThumbnail(representative.thumbnails),
          };
        })
        .filter(c => c && c.id); // drop sections with no usable playlist/album ID
      return { source, charts };
    }

    // SongDetailed[] fallback shape
    const tracks = data
      .filter(d => d.type === 'SONG' || d.type === 'VIDEO' || !d.type)
      .map(ytmusicSong);
    return { source, charts: [{ id: 'trending', title: 'Trending', description: '', thumbnail: null, tracks }] };
  }

  return { source, charts: [] };
}

module.exports = {
  trim,
  normalizeSearch,
  normalizeStream,
  normalizeAlbum,
  normalizePlaylist,
  normalizeSuggestions,
  normalizeCharts,
  decodeHtmlEntities,
  pickThumbnail,
  extractJioSaavnThumbnail,
  extractJioSaavnArtist,
};
