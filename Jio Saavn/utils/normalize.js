function trim(v) {
  return typeof v === 'string' ? v.trim() : v;
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
function extractJioSaavnArtist(item) {
  const mi = item.more_info;

  // Primary artists first (cleanest)
  if (mi?.artistMap?.primary_artists?.length) {
    const names = [...new Set(mi.artistMap.primary_artists.map(a => decodeHtmlEntities(a.name)).filter(Boolean))];
    if (names.length) return names.join(', ');
  }

  // All artists fallback
  if (mi?.artistMap?.artists?.length) {
    const names = [...new Set(mi.artistMap.artists.map(a => decodeHtmlEntities(a.name)).filter(Boolean))];
    if (names.length) return names.join(', ');
  }

  // subtitle field: "Artist Name - Album Name" format
  if (item.subtitle) {
    const parts = item.subtitle.split(' - ');
    if (parts.length > 1) return decodeHtmlEntities(parts[0].trim());
    return decodeHtmlEntities(item.subtitle.trim());
  }

  // music field (older API)
  if (mi?.music) return decodeHtmlEntities(mi.music);

  // Top-level artist_map (some endpoints)
  if (item.artist_map?.primary_artists?.length) {
    const names = [...new Set(item.artist_map.primary_artists.map(a => decodeHtmlEntities(a.name)).filter(Boolean))];
    if (names.length) return names.join(', ');
  }

  return 'Unknown';
}

// ── HTML entity decoder ───────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&amp;/g, '&');
}

// ── JioSaavn song normalizer ──────────────────────────────────────────────
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
    stream_url: null,  // always null; caller must hit /track/:id
  };
}

// ── JioSaavn search results parser ───────────────────────────────────────
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

// ── Exported normalizers ──────────────────────────────────────────────────

function normalizeSearch(source, data, query) {
  return { source, query, results: jioSaavnSearchResults(data) };
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
    const names = [...new Set(pa.map(a => decodeHtmlEntities(a.name.trim())).filter(Boolean))];
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

function normalizePlaylist(source, data) {
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
    owner: decodeHtmlEntities(data.more_info?.username || data.more_info?.firstname || data.username || data.owner || 'JioSaavn'),
    song_count: parseInt(data.song_count || tracks.length, 10) || tracks.length,
    duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
    thumbnail: tn,
    tracks,
  };
}

function normalizeSuggestions(source, data, query) {
  let suggestions = [];
  if (Array.isArray(data)) {
    suggestions = data.map(s => (typeof s === 'string' ? s : s.text || s.title || '')).filter(Boolean);
  } else if (data?.suggestions && Array.isArray(data.suggestions)) {
    suggestions = data.suggestions.map(s => (typeof s === 'string' ? s : s.text || s.title || '')).filter(Boolean);
  }
  suggestions = [...new Set(suggestions.map(s => s.trim()).filter(s => s.length > 0))];
  return { source, query, suggestions };
}

function normalizeCharts(source, data) {
  let charts = [];

  const mapChart = c => ({
    id: c.id || c.chart_id || c.listid || c.tab_id || '',
    title: decodeHtmlEntities(c.title || c.name || ''),
    description: decodeHtmlEntities(c.subtitle || c.description || (c.song_count ? `${c.song_count} songs` : '')),
    thumbnail: extractJioSaavnThumbnail(c),
  });

  if (data?.charts && Array.isArray(data.charts)) {
    charts = data.charts.map(mapChart);
  } else if (data?.tabs && Array.isArray(data.tabs)) {
    charts = data.tabs.map(mapChart);
  } else if (Array.isArray(data)) {
    charts = data.map(mapChart);
  }

  // Filter out charts with no id; they can't be loaded
  charts = charts.filter(c => c.id);

  return { source, charts };
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
  extractJioSaavnThumbnail,
  extractJioSaavnArtist,
};
