// ── Content-based recommendation via cosine similarity ───────────────────
//
// Feature vector per song:
//   [ ...artist_one_hot, ...language_one_hot, normalized_duration ]
//
// Artist and language are one-hot encoded over the full catalog vocabulary.
// Duration is min-max normalized (0–1) across the catalog.
// Cosine similarity is computed in pure JS — no native dependencies required.
//
// The catalog is held in a module-level Map (in-memory) and updated via
// upsertSongRecords(). It is never persisted to disk; it is rebuilt from
// the songs that flow through the API at runtime (search results, album
// tracks, playlist tracks). This matches the zero-database design of the
// rest of the codebase.

// ── In-memory catalog ─────────────────────────────────────────────────────
// Map<songId, NormalizedSong>
const _catalog = new Map();

// ── Song normalizer ───────────────────────────────────────────────────────
// Accepts a song object in the shape produced by normalize.js (jioSaavnSong)
// and returns a lean record suitable for similarity computation.
// Returns null if the song has no usable id.
function _normalizeSong(song) {
  const id = String(song?.id || '').trim();
  if (!id) return null;

  return {
    id,
    title: String(song.title || 'Unknown'),
    artist: String(song.artist || ''),
    album: String(song.album || ''),
    language: String(song.language || ''),
    duration_seconds: Math.max(0, parseInt(song.duration_seconds, 10) || 0),
    thumbnail: song.thumbnail || null,
    has_lyrics: Boolean(song.has_lyrics),
    explicit: Boolean(song.explicit),
  };
}

// ── Catalog management ────────────────────────────────────────────────────

// Upsert an array of song objects into the in-memory catalog.
// Existing entries are merged: non-empty incoming fields overwrite stored ones.
// Idempotent — safe to call on every search/album/playlist response.
function upsertSongRecords(songs) {
  if (!Array.isArray(songs)) return;

  for (const song of songs) {
    const normalized = _normalizeSong(song);
    if (!normalized) continue;

    const existing = _catalog.get(normalized.id) || {};
    const merged = { ...existing };

    for (const [key, value] of Object.entries(normalized)) {
      // Only overwrite if the incoming value is non-empty / non-zero
      if (value !== '' && value !== null && value !== undefined) {
        merged[key] = value;
      }
    }

    _catalog.set(normalized.id, merged);
  }
}

// Retrieve a single song from the catalog by ID. Returns null if not found.
function getSongById(songId) {
  const id = String(songId || '').trim();
  if (!id) return null;
  const song = _catalog.get(id);
  return song ? { ...song } : null;
}

// Retrieve multiple songs by ID array, preserving input order.
// Missing IDs are silently skipped.
function getSongsByIds(songIds) {
  if (!Array.isArray(songIds)) return [];
  const results = [];
  for (const songId of songIds) {
    const song = _catalog.get(String(songId));
    if (song) results.push({ ...song });
  }
  return results;
}

// ── Feature matrix ────────────────────────────────────────────────────────
// Builds a feature vector for every song in the catalog.
// Returns { vectors: Map<id, Float64Array>, ids: string[] }
// or null if the catalog is empty.
function _buildFeatureMatrix(catalog) {
  if (catalog.size === 0) return null;

  const songs = [...catalog.values()];

  // Vocabulary: sorted unique artists and languages for deterministic indexing
  const artists = [...new Set(songs.map(s => s.artist || ''))].sort();
  const languages = [...new Set(songs.map(s => s.language || ''))].sort();

  const artistIndex = new Map(artists.map((a, i) => [a, i]));
  const languageIndex = new Map(languages.map((l, i) => [l, i]));

  // Duration normalization: min-max across catalog
  const durations = songs.map(s => s.duration_seconds || 0);
  const durationMin = Math.min(...durations);
  const durationMax = Math.max(...durations);
  const durationRange = durationMax - durationMin;

  // Vector layout: [artist_one_hot..., language_one_hot..., normalized_duration]
  const vecLen = artists.length + languages.length + 1;

  const vectors = new Map();
  for (const song of songs) {
    const vec = new Float64Array(vecLen);

    const aIdx = artistIndex.get(song.artist || '');
    if (aIdx !== undefined) vec[aIdx] = 1.0;

    const lIdx = languageIndex.get(song.language || '');
    if (lIdx !== undefined) vec[artists.length + lIdx] = 1.0;

    vec[vecLen - 1] = durationRange === 0
      ? 0.0
      : (song.duration_seconds - durationMin) / durationRange;

    vectors.set(song.id, vec);
  }

  return { vectors, ids: songs.map(s => s.id) };
}

// ── Cosine similarity ─────────────────────────────────────────────────────
function _cosineSimilarity(a, b) {
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0.0 : dot / denom;
}

// ── Content-based recommendations ────────────────────────────────────────
// Returns up to `limit` song IDs from the catalog most similar to `songId`,
// ranked by descending cosine similarity then ascending ID (deterministic).
// Returns [] if the song is not in the catalog or the catalog is too small.
function getSimilarSongs(songId, limit = 5) {
  const id = String(songId || '').trim();
  if (!id) return [];

  const maxResults = Math.max(0, Math.floor(limit));
  if (maxResults === 0) return [];

  const matrix = _buildFeatureMatrix(_catalog);
  if (!matrix) return [];

  const targetVec = matrix.vectors.get(id);
  if (!targetVec) return [];

  const ranked = [];
  for (const candidateId of matrix.ids) {
    if (candidateId === id) continue;
    const candidateVec = matrix.vectors.get(candidateId);
    const similarity = _cosineSimilarity(targetVec, candidateVec);
    ranked.push([candidateId, similarity]);
  }

  // Sort: highest similarity first; alphabetical tiebreak for determinism
  ranked.sort(([aId, aSim], [bId, bSim]) => {
    if (bSim !== aSim) return bSim - aSim;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  return ranked.slice(0, maxResults).map(([candidateId]) => candidateId);
}

// ── Catalog size (for diagnostics / tests) ────────────────────────────────
function getCatalogSize() {
  return _catalog.size;
}

// ── Clear catalog (for tests only) ───────────────────────────────────────
function _clearCatalog() {
  _catalog.clear();
}

module.exports = {
  upsertSongRecords,
  getSongById,
  getSongsByIds,
  getSimilarSongs,
  getCatalogSize,
  _clearCatalog, // exported for test isolation only
};
