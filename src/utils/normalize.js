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
// FIX: JioSaavn image field can be an array of objects (newer API responses)
// in addition to a plain string. Handle both shapes and always return 500x500.
function extractJioSaavnThumbnail(item) {
  if (!item) return null;
  const img = item.image;
  if (!img) return null;

  // Array of { quality, link } objects (newer JioSaavn API shape)
  if (Array.isArray(img)) {
    // Prefer the highest quality entry — last item is usually the largest
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
// FIX: artistMap.artists includes featured artists, backing vocalists, etc.
// Use primary_artists first for a cleaner display name, fall back to all artists.
// Also handle the newer `featured_artists` field.
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

// ── JioSaavn song normalizer ──────────────────────────────────────────────
// FIX: id fallback was using encrypted_media_url as an ID which is wrong —
// it's a base64 blob, not a usable track ID. Fall back to perma_url slug instead.
// FIX: title can have HTML entities from JioSaavn — decode them.
// FIX: language field is available in more_info — expose it.
// FIX: explicit/has_lyrics flags are available — expose them.
function jioSaavnSong(item) {
  // Extract a clean ID — prefer item.id, then perma_url slug, never the encrypted blob
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
    stream_url: null,  // always null here — caller must hit /track/:id
  };
}

// ── HTML entity decoder ───────────────────────────────────────────────────
// FIX: JioSaavn returns titles like "Tere Naal &amp; More" — decode them
// without a DOM (Node.js safe).
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

// ── JioSaavn search results parser ───────────────────────────────────────
// FIX: filter out non-song results (albums, artists, playlists) that can
// appear in search results — only keep items with a duration field.
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
      // Keep only song-type items — they have a duration field
      if (!item) return false;
      const hasDuration = item.duration || item.more_info?.duration;
      const type = item.type || item.more_info?.type;
      // Exclude albums, artists, playlists explicitly
      if (type && ['album', 'artist', 'playlist', 'show', 'episode'].includes(type)) return false;
      return hasDuration || !type; // keep if has duration or no type field
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
// FIX: the old normalizer used item.artists?.[0] (array) but SongDetailed
// has item.artist (single object). PlaylistVideo uses item.artists (single
// object too, not an array — confusingly named). Handle both.
function ytmusicSong(item) {
  const tn = item.thumbnails || item.thumbnail;

  // artist: SongDetailed uses item.artist (object), PlaylistVideo uses item.artists (object)
  const artistObj = item.artist || item.artists || null;
  const artist = artistObj?.name || 'Unknown';

  // album: SongDetailed has item.album?.name, PlaylistVideo has no album field
  const album = item.album?.name || null;

  // duration: the library returns seconds as a plain number (not totalSeconds object)
  // FIX: old code tried item.duration?.totalSeconds which is always undefined here
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

// FIX: searchSongs() returns SongDetailed[] — all items have type === 'SONG'.
// The old filter `d.type === 'SONG' || !d.type` was fine for search() (mixed)
// but now we use searchSongs() so every item is a song. Keep the filter
// as a safety net in case the mixed search() result is ever passed here.
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

    // FIX: primary_artists extraction was only on data.more_info but some
    // album responses put it directly on data.artist_map
    let artist = 'Unknown';
    const pa =
      data.more_info?.artistMap?.primary_artists ||
      data.artist_map?.primary_artists;
    if (pa && Array.isArray(pa) && pa.length) {
      const names = [...new Set(pa.map(a => a.name.trim()).filter(Boolean))];
      if (names.length) artist = names.join(', ');
    } else if (tracks.length) {
      const unique = [...new Set(tracks.map(t => t.artist))].filter(a => a && a !== 'Unknown');
      if (unique.length) artist = unique[0]; // use first track's artist, not all of them joined
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
      // FIX: expose language at album level too
      language: data.more_info?.language || data.language || null,
      tracks,
    };
  }

  // YT Music album — AlbumFull shape:
  // { type:'ALBUM', albumId, playlistId, name, artist:{artistId,name},
  //   year: number|null, thumbnails[], songs: SongDetailed[] }
  // FIX: old code tried data.artists?.[0]?.name and data.artistName —
  // neither exists. AlbumFull has a single data.artist object.
  const tn = pickThumbnail(data.thumbnails || data.thumbnail);
  const artist = data.artist?.name || 'Unknown';
  let tracks = [];
  // AlbumFull uses data.songs (not data.tracks)
  const songList = data.songs || data.tracks || [];
  if (Array.isArray(songList)) {
    tracks = songList.map((t, i) => ({
      ...ytmusicSong(t),
      track_number: i + 1,
    }));
  }
  return {
    source,
    // FIX: AlbumFull uses albumId (not browseId or id)
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

    // FIX: add track_number to playlist tracks too — it's useful for display
    // and was inconsistently absent vs album tracks
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
  // FIX: old code tried data.owner / data.ownerName / data.artists?.[0]?.name —
  // none of these exist on PlaylistFull. The owner is data.artist.name.
  // FIX: old code tried data.tracks || data.songs — PlaylistFull has neither.
  //   The scraper now merges getPlaylistVideos() result as data.tracks.
  const tn = pickThumbnail(data.thumbnails || data.thumbnail);
  const owner = data.artist?.name || data.owner || data.ownerName || 'Unknown';
  let tracks = [];
  const plSongs = data.tracks || data.songs || [];
  if (Array.isArray(plSongs)) {
    tracks = plSongs.map((t, i) => ({ ...ytmusicSong(t), track_number: i + 1 }));
  }
  return {
    source,
    // FIX: PlaylistFull uses playlistId (not browseId or id)
    id: data.playlistId || data.browseId || data.id || '',
    title: data.name || data.title || '',
    owner,
    // FIX: PlaylistFull uses videoCount (not trackCount or song_count)
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
    // FIX: deduplicate and trim
    suggestions = [...new Set(suggestions.map(s => s.trim()).filter(s => s.length > 0))];
    return { source, query, suggestions };
  }

  // YT Music suggestions — getSearchSuggestions() returns string[] directly
  // FIX: old code mapped s.text || s.name || s.query — these fields don't
  // exist on strings. The array IS the suggestions list already.
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
      // FIX: ternary precedence bug — wrap the song_count branch properly
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

    // FIX: filter out charts with no id — they can't be loaded
    charts = charts.filter(c => c.id);

    return { source, charts };
  }

  // YT Music charts — two possible inputs:
  // 1. getHomeSections() → HomeSection[]: [{ title, contents: (AlbumDetailed|PlaylistDetailed|SongDetailed)[] }]
  // 2. searchSongs() fallback → SongDetailed[]
  // FIX: old code only handled SongDetailed[] and wrapped everything in a
  // single 'trending' chart. Now we map each HomeSection to a chart entry.
  if (Array.isArray(data)) {
    // Check if it's HomeSection[] (objects with title + contents)
    if (data.length > 0 && data[0]?.contents !== undefined) {
      // HomeSection[] shape
      const charts = data
        .filter(section => section.title && Array.isArray(section.contents) && section.contents.length > 0)
        .map(section => {
          // Use the first PLAYLIST or ALBUM in the section as the chart entry
          const playlist = section.contents.find(c => c.type === 'PLAYLIST');
          const album = section.contents.find(c => c.type === 'ALBUM');
          const representative = playlist || album || section.contents[0];
          return {
            id: representative?.playlistId || representative?.albumId || representative?.videoId || '',
            title: section.title,
            description: `${section.contents.length} items`,
            thumbnail: pickThumbnail(representative?.thumbnails),
          };
        })
        .filter(c => c.id); // drop sections with no usable ID
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
  jioSaavnSong,
  ytmusicSong,
  extractJioSaavnThumbnail,
  decodeHtmlEntities,
};
