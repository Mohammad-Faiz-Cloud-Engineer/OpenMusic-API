const { getBehaviorRecommendations } = require('./behavior');
const { getSimilarSongs, getSongsByIds } = require('./content');

// ── Recommendation engine ─────────────────────────────────────────────────
//
// Hybrid strategy: behavior-first, content-fill.
//
// get_recommendations: returns two separate ranked lists so the caller can
//   display them with distinct labels ("Because you played X" vs "Similar to X").
//
// get_up_next: merges both lists into a single ordered queue, behavior first,
//   content filling remaining slots. Suitable for auto-play / queue building.
//
// Both functions guarantee:
//   - The seed song is never included in results
//   - No duplicate IDs across the two lists (get_recommendations) or within
//     the merged list (get_up_next)

// ── get_recommendations ───────────────────────────────────────────────────
// Returns:
// {
//   source: 'jiosaavn',
//   song_id: string,
//   behavior_based: SongObject[],   // up to 5, enriched from catalog
//   content_based:  SongObject[],   // up to 5, enriched from catalog, no overlap
// }
function getRecommendations(songId) {
  const id = String(songId || '').trim();
  if (!id) {
    return { source: 'jiosaavn', song_id: id, behavior_based: [], content_based: [] };
  }

  // Behavior: top-5 most-frequently-played-after songs
  const behaviorIds = getBehaviorRecommendations(id, 5).filter(c => c !== id);
  const behaviorSeen = new Set(behaviorIds);

  // Content: top-5 most-similar songs, excluding behavior results
  const contentIds = [];
  for (const candidate of getSimilarSongs(id, 10)) {
    if (candidate === id || behaviorSeen.has(candidate)) continue;
    contentIds.push(candidate);
    if (contentIds.length >= 5) break;
  }

  // Enrich IDs with full song metadata from the in-memory catalog.
  // IDs not in the catalog are returned as lightweight stubs so the caller
  // can still use them (e.g. to hit /jiosaavn/track/:id).
  const behaviorSongs = _enrichIds(behaviorIds);
  const contentSongs = _enrichIds(contentIds);

  return {
    source: 'jiosaavn',
    song_id: id,
    behavior_based: behaviorSongs,
    content_based: contentSongs,
  };
}

// ── get_up_next ───────────────────────────────────────────────────────────
// Returns a merged, ordered list of up to `limit` recommendations.
// Each entry: { song_id, reason: 'behavior'|'content', ...songMetadata }
// Behavior results fill first; content fills remaining slots.
function getUpNext(songId, limit = 10) {
  const id = String(songId || '').trim();
  const maxResults = Math.max(0, Math.floor(limit));

  if (!id || maxResults === 0) return [];

  const combined = [];
  const seen = new Set([id]);

  // Fill from behavior first
  for (const candidate of getBehaviorRecommendations(id, maxResults)) {
    if (seen.has(candidate)) continue;
    combined.push({ song_id: candidate, reason: 'behavior', ..._enrichId(candidate) });
    seen.add(candidate);
    if (combined.length >= maxResults) return combined;
  }

  // Fill remaining slots from content-based
  const remaining = maxResults - combined.length;
  if (remaining > 0) {
    for (const candidate of getSimilarSongs(id, maxResults)) {
      if (seen.has(candidate)) continue;
      combined.push({ song_id: candidate, reason: 'content', ..._enrichId(candidate) });
      seen.add(candidate);
      if (combined.length >= maxResults) break;
    }
  }

  return combined;
}

// ── Internal helpers ──────────────────────────────────────────────────────

// Enrich a list of IDs with catalog metadata. Returns an array of objects
// where each entry has at minimum { song_id } and optionally full song fields.
function _enrichIds(ids) {
  const songs = getSongsByIds(ids);
  const byId = new Map(songs.map(s => [s.id, s]));

  return ids.map(id => {
    const song = byId.get(id);
    return song ? { song_id: id, ...song } : { song_id: id };
  });
}

// Enrich a single ID. Returns {} if not in catalog (caller spreads this).
function _enrichId(id) {
  const songs = getSongsByIds([id]);
  return songs.length > 0 ? songs[0] : {};
}

module.exports = { getRecommendations, getUpNext };
