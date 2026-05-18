// ── YouTube Music response normalizer ────────────────────────────────────
// Mirrors the structure of Jio Saavn/normalize.js exactly.
// All functions are pure and throw-safe; callers never need to guard.

// ── Bullet separator regex ────────────────────────────────────────────────
// YTM subtitle runs use U+2022 (•) as a visual separator between fields.
// Also guard against U+00B7 (·) and U+2219 (∙) which appear in some locales.
const BULLET_RE = /^\s*[\u2022\u00B7\u2219]\s*$/;

// ── Known type-indicator strings YTM injects as the first subtitle part ──
const TYPE_INDICATORS = new Set(['Song', 'Video', 'EP', 'Single', 'Album', 'Playlist', 'Artist']);

// ── HTML entity decoder ───────────────────────────────────────────────────
// YTM generally returns clean UTF-8, but some locales and older API shapes
// do include HTML entities in title/artist/album strings. Decode them here
// at the normalizer boundary so every caller always receives clean text.
// Mirrors Jio Saavn/normalize.js decodeHtmlEntities exactly.
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
    // Hex numeric character references (e.g. &#x2019; → ')
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Decimal numeric character references (e.g. &#8217; → ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&amp;/g, '&');
}

// ── Duration string parser ────────────────────────────────────────────────
// Handles M:SS, MM:SS, H:MM:SS, HH:MM:SS.
function parseDuration(str) {
  if (!str || typeof str !== 'string') return 0;
  const trimmed = str.trim();
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) return 0;
  const segments = trimmed.split(':').map(Number);
  if (segments.some(isNaN)) return 0;
  if (segments.length === 3) return segments[0] * 3600 + segments[1] * 60 + segments[2];
  return segments[0] * 60 + segments[1];
}

// ── YTM thumbnail extractor ───────────────────────────────────────────────
// YTM thumbnails are always an array of { url, width, height } objects.
// Pick the largest by width; fall back to the last entry.
function extractYtmThumbnail(item) {
  if (!item) return null;

  // musicThumbnailRenderer path (search results, shelf items)
  const thumbs =
    item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
    item.thumbnail?.thumbnails ||
    item.thumbnails ||
    null;

  if (!Array.isArray(thumbs) || !thumbs.length) return null;

  // Sort descending by width; fall back to last entry when width is absent
  const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || thumbs[thumbs.length - 1]?.url || null;
}

// ── YTM subtitle run parser ───────────────────────────────────────────────
// Returns { artist, album, duration_seconds } extracted from the flex-column
// subtitle runs. Handles all known YTM subtitle shapes:
//   ["Song", "•", "Artist"]
//   ["Song", "•", "Artist", "•", "Album"]
//   ["Song", "•", "Artist", "•", "Album", "•", "3:45"]
//   ["Artist", "•", "3:45"]
//   ["Artist", "•", "Album", "•", "3:45"]
function parseSubtitleRuns(runs) {
  if (!Array.isArray(runs) || !runs.length) {
    return { artist: 'Unknown', album: '', duration_seconds: 0 };
  }

  // Strip bullet separators; decode entities on each text run
  const parts = runs
    .map(r => (typeof r?.text === 'string' ? decodeHtmlEntities(r.text) : ''))
    .filter(t => !BULLET_RE.test(t) && t.trim().length > 0);

  // Drop leading type indicator
  const meaningful = parts.length > 0 && TYPE_INDICATORS.has(parts[0])
    ? parts.slice(1)
    : parts;

  let artist = 'Unknown';
  let album = '';
  let duration_seconds = 0;

  for (const part of meaningful) {
    if (parseDuration(part) > 0) {
      duration_seconds = parseDuration(part);
    }
  }

  // Non-duration parts in order: artist, then album
  const nonDuration = meaningful.filter(p => parseDuration(p) === 0);
  if (nonDuration.length >= 1) artist = nonDuration[0];
  if (nonDuration.length >= 2) {
    const candidate = nonDuration[1];
    // Skip play-count strings like "1.2M plays"
    if (!/\d+[KMB]?\s*(plays|listeners)/i.test(candidate)) {
      album = candidate;
    }
  }

  return { artist, album, duration_seconds };
}

// ── YTM musicResponsiveListItemRenderer → track ───────────────────────────
function parseListItemRenderer(item) {
  const data = item?.musicResponsiveListItemRenderer;
  if (!data) return null;

  // videoId lives in playlistItemData or overlay
  const id =
    data.playlistItemData?.videoId ||
    data.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint
      ?.watchEndpoint?.videoId ||
    null;
  if (!id) return null;

  const flexColumns = data.flexColumns || [];

  // Title from first flex column — decode entities
  const titleRuns =
    flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const title = decodeHtmlEntities(
    titleRuns.map(r => r.text || '').join('').trim()
  ) || 'Unknown';

  // Subtitle from second flex column — parseSubtitleRuns decodes internally
  const subtitleRuns =
    flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const { artist, album, duration_seconds } = parseSubtitleRuns(subtitleRuns);

  // Explicit badge
  const explicit =
    Array.isArray(data.badges) &&
    data.badges.some(
      b => b?.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE'
    );

  return {
    id,
    title,
    artist,
    album,
    duration_seconds,
    thumbnail: extractYtmThumbnail(data),
    language: null,
    has_lyrics: false,
    explicit,
    stream_url: null,
  };
}

// ── YTM musicTwoRowItemRenderer → chart/playlist card ────────────────────
// Used in charts and browse shelves.
function parseTwoRowItemRenderer(item) {
  const data = item?.musicTwoRowItemRenderer;
  if (!data) return null;

  const id =
    data.navigationEndpoint?.watchEndpoint?.videoId ||
    data.navigationEndpoint?.browseEndpoint?.browseId ||
    null;
  if (!id) return null;

  const titleRuns = data.title?.runs || [];
  const title = decodeHtmlEntities(
    titleRuns.map(r => r.text || '').join('').trim()
  ) || 'Unknown';

  const subtitleRuns = data.subtitle?.runs || [];
  const { artist, album, duration_seconds } = parseSubtitleRuns(subtitleRuns);

  const explicit =
    Array.isArray(data.subtitleBadges) &&
    data.subtitleBadges.some(
      b => b?.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE'
    );

  return {
    id,
    title,
    artist,
    album,
    duration_seconds,
    thumbnail: extractYtmThumbnail(data),
    language: null,
    has_lyrics: false,
    explicit,
    stream_url: null,
  };
}

// ── Walk a YTM search response and collect all tracks ────────────────────
// YTM wraps results in tabbedSearchResultsRenderer → tabs → sectionListRenderer
// → musicShelfRenderer sections. Each shelf has a title (e.g. "Top result",
// "Songs", "Videos") and a contents array of list item renderers.
function extractTracksFromSearchResponse(data) {
  const tracks = [];
  if (!data || typeof data !== 'object') return tracks;

  try {
    const tabs =
      data.contents?.tabbedSearchResultsRenderer?.tabs ||
      (data.contents?.sectionListRenderer?.contents &&
        [{ tabRenderer: { content: { sectionListRenderer: { contents: data.contents.sectionListRenderer.contents } } } }]) ||
      [];

    for (const tab of tabs) {
      const sections =
        tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];

      for (const section of sections) {
        const shelf = section?.musicShelfRenderer;
        if (!shelf?.contents) continue;

        for (const item of shelf.contents) {
          const track = parseListItemRenderer(item);
          if (track) tracks.push(track);
        }
      }
    }
  } catch {
    // Swallow; partial results are better than a crash
  }

  return tracks;
}

// ── Exported normalizers ──────────────────────────────────────────────────

function normalizeSearch(data, query) {
  const results = extractTracksFromSearchResponse(data)
    .filter(t => {
      // Drop items with no duration AND no recognisable artist — these are
      // usually artist/album cards that leaked through the shelf parser.
      if (t.duration_seconds === 0 && t.artist === 'Unknown') return false;
      return true;
    });

  return { source: 'youtube', query, results };
}

function normalizeStream(id, streamUrl, format, quality, expiresAt) {
  return {
    id,
    source: 'youtube',
    quality: quality || 'unknown',
    format: format || 'm4a',
    stream_url: streamUrl,
    expires_at: expiresAt || null,
  };
}

// YTM does not expose album/playlist detail APIs without auth.
// These stubs return a consistent shape so routes can handle them uniformly.
function normalizeAlbum(data) {
  return {
    source: 'youtube',
    id: data?.id || '',
    title: decodeHtmlEntities(data?.title || ''),
    artist: decodeHtmlEntities(data?.artist || 'Unknown'),
    year: data?.year || 0,
    song_count: 0,
    duration_seconds: 0,
    thumbnail: null,
    language: null,
    tracks: [],
  };
}

function normalizePlaylist(data) {
  return {
    source: 'youtube',
    id: data?.id || '',
    title: decodeHtmlEntities(data?.title || ''),
    owner: decodeHtmlEntities(data?.owner || 'YouTube Music'),
    song_count: 0,
    duration_seconds: 0,
    thumbnail: null,
    tracks: [],
  };
}

function normalizeSuggestions(data, query) {
  let suggestions = [];

  try {
    // Shape 1: { contents: [{ searchSuggestionsSectionRenderer: { contents: [...] } }] }
    const section =
      data?.contents?.[0]?.searchSuggestionsSectionRenderer?.contents ||
      data?.contents?.searchSuggestionsSectionRenderer?.contents ||
      null;

    if (Array.isArray(section)) {
      for (const c of section) {
        const runs =
          c?.searchSuggestionRenderer?.suggestion?.runs ||
          c?.historySuggestionRenderer?.suggestion?.runs ||
          null;
        if (Array.isArray(runs)) {
          const text = decodeHtmlEntities(
            runs.map(r => r.text || '').join('').trim()
          );
          if (text) suggestions.push(text);
        }
      }
    }
  } catch {
    // Non-critical; return empty
  }

  // Deduplicate and clean
  suggestions = [...new Set(suggestions.map(s => s.trim()).filter(s => s.length > 0))];

  return { source: 'youtube', query, suggestions };
}

function normalizeCharts(data) {
  // YTM charts require a logged-in session; the API returns an empty or
  // auth-gated response for anonymous requests. Return a consistent empty
  // shape rather than crashing.
  return { source: 'youtube', charts: [] };
}

module.exports = {
  normalizeSearch,
  normalizeStream,
  normalizeAlbum,
  normalizePlaylist,
  normalizeSuggestions,
  normalizeCharts,
  decodeHtmlEntities,
  // Exported for tests
  parseSubtitleRuns,
  parseDuration,
  extractYtmThumbnail,
  parseListItemRenderer,
};
