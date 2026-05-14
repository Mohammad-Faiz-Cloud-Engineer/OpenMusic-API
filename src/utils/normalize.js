function trim(v) {
  return typeof v === 'string' ? v.trim() : v;
}

function pickThumbnail(thumbnails) {
  if (!thumbnails || !Array.isArray(thumbnails)) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || sorted[0] || null;
}

function extractJioSaavnThumbnail(item) {
  if (!item) return null;
  const img = item.image;
  if (!img) return null;
  return img.replace('150x150', '500x500').replace('50x50', '500x500');
}

function extractJioSaavnArtist(item) {
  const mi = item.more_info;
  if (mi?.artistMap?.artists) {
    const names = [...new Set(mi.artistMap.artists.map(a => a.name))];
    if (names.length) return names.join(', ');
  }
  if (mi?.artistMap?.primary_artists) {
    const names = [...new Set(mi.artistMap.primary_artists.map(a => a.name))];
    if (names.length) return names.join(', ');
  }
  if (item.subtitle) {
    const parts = item.subtitle.split(' - ');
    if (parts.length > 1) return parts[0].trim();
    return item.subtitle;
  }
  if (mi?.music) return mi.music;
  return 'Unknown';
}

function jioSaavnSong(item) {
  return {
    id: item.id || item.encrypted_media_url,
    title: item.title || '',
    artist: extractJioSaavnArtist(item),
    album: item.more_info?.album || item.album || '',
    duration_seconds: parseInt(item.duration || item.more_info?.duration || '0', 10) || 0,
    thumbnail: extractJioSaavnThumbnail(item),
    stream_url: item.stream_url || null,
  };
}

function jioSaavnSearchResults(data, query) {
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
  return results.map(jioSaavnSong);
}

function ytmusicSong(item) {
  const tn = item.thumbnails || item.thumbnail;
  const artist = item.artist?.name || item.artists?.[0]?.name || item.artistName || 'Unknown';
  const album = item.album?.name || item.albumName || null;
  return {
    id: item.videoId || item.id,
    title: item.name || item.title || '',
    artist,
    album,
    duration_seconds: parseInt(item.duration?.totalSeconds || item.duration || item.duration_seconds || '0', 10) || 0,
    thumbnail: pickThumbnail(tn),
    stream_url: null,
  };
}

function ytmusicSearchResults(data) {
  if (!data || !Array.isArray(data)) return [];
  return data.filter(d => d.type === 'SONG' || !d.type).map(ytmusicSong);
}

function normalizeSearch(source, data, query) {
  if (source === 'jiosaavn') {
    return { source, query, results: jioSaavnSearchResults(data, query) };
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
    const pa = data.more_info?.artistMap?.primary_artists;
    if (pa && Array.isArray(pa) && pa.length) {
      const names = [...new Set(pa.map(a => a.name.trim()))];
      artist = names.join(', ');
    } else if (tracks.length) {
      const unique = [...new Set(tracks.map(t => t.artist))].filter(a => a && a !== 'Unknown');
      if (unique.length) artist = unique.join(', ');
    }
    return {
      source,
      id: data.albumid || data.id || '',
      title: data.title || data.name || '',
      artist,
      year: parseInt(data.year || '0', 10) || 0,
      song_count: parseInt(data.song_count || tracks.length, 10) || tracks.length,
      duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
      thumbnail: tn,
      tracks,
    };
  }

  const tn = pickThumbnail(data.thumbnails || data.thumbnail);
  const artist = data.artists?.[0]?.name || data.artist?.name || data.artistName || 'Unknown';
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
    return {
      source,
      id: data.listid || data.id || '',
      title: data.title || data.listname || '',
      owner: data.more_info?.username || data.more_info?.firstname || data.username || data.owner || 'JioSaavn',
      song_count: parseInt(data.song_count || tracks.length, 10) || tracks.length,
      duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
      thumbnail: tn,
      tracks,
    };
  }

  const tn = pickThumbnail(data.thumbnails || data.thumbnail);
  const owner = data.owner || data.ownerName || data.artists?.[0]?.name || 'Unknown';
  let tracks = [];
  const plSongs = data.tracks || data.songs || [];
  if (Array.isArray(plSongs)) {
    tracks = plSongs.map(ytmusicSong);
  }
  return {
    source,
    id: data.playlistId || data.browseId || data.id || '',
    title: data.name || data.title || '',
    owner,
    song_count: data.trackCount || tracks.length || 0,
    duration_seconds: tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0),
    thumbnail: tn,
    tracks,
  };
}

function normalizeSuggestions(source, data, query) {
  if (source === 'jiosaavn') {
    let suggestions = [];
    if (Array.isArray(data)) {
      suggestions = data.map(s => s.text || s);
    } else if (data?.suggestions && Array.isArray(data.suggestions)) {
      suggestions = data.suggestions.map(s => s.text || s);
    }
    return { source, query, suggestions };
  }

  let suggestions = [];
  if (Array.isArray(data)) {
    suggestions = data.map(s => (typeof s === 'string' ? s : s.text || s.name || s.query)).filter(Boolean);
  }
  return { source, query, suggestions };
}

function normalizeCharts(source, data) {
  if (source === 'jiosaavn') {
    let charts = [];
    if (data?.charts && Array.isArray(data.charts)) {
      charts = data.charts.map(c => ({
        id: c.id || c.chart_id || '',
        title: c.title || c.name || '',
        description: c.subtitle || c.description || '',
        thumbnail: extractJioSaavnThumbnail(c),
      }));
    } else if (data?.tabs && Array.isArray(data.tabs)) {
      charts = data.tabs.map(c => ({
        id: c.id || c.tab_id || '',
        title: c.title || c.name || '',
        description: c.subtitle || '',
        thumbnail: extractJioSaavnThumbnail(c),
      }));
    } else if (Array.isArray(data)) {
      charts = data.map(c => ({
        id: c.id || c.chart_id || '',
        title: c.title || c.name || '',
        description: c.subtitle || c.description || '',
        thumbnail: extractJioSaavnThumbnail(c),
      }));
    }
    return { source, charts };
  }

  let tracks = [];
  if (Array.isArray(data)) {
    tracks = data.filter(d => d.type === 'SONG' || !d.type).map(ytmusicSong);
  }
  return { source, charts: [{ id: 'trending', title: 'Trending', tracks }] };
}

module.exports = {
  trim,
  normalizeSearch,
  normalizeStream,
  normalizeAlbum,
  normalizePlaylist,
  normalizeSuggestions,
  normalizeCharts,
  jioSaavnSong,
  ytmusicSong,
  extractJioSaavnThumbnail,
};
