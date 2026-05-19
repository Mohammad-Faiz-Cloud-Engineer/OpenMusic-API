const {
  loadTallyData,
  saveTallyData,
  applyDecayIfNeeded,
  cleanupTallyData,
} = require('./storage');

// ── Record a play transition ──────────────────────────────────────────────
// Call this when a user moves from one track to the next.
// previousSongId → currentSongId increments the transition counter.
// Self-transitions (same song) are silently ignored.
function updateTransition(previousSongId, currentSongId) {
  const prev = String(previousSongId || '').trim();
  const curr = String(currentSongId || '').trim();

  if (!prev || !curr || prev === curr) return;

  const data = applyDecayIfNeeded(loadTallyData());

  // Increment the transition counter
  if (!data.transitions[prev]) data.transitions[prev] = {};
  data.transitions[prev][curr] = (data.transitions[prev][curr] || 0) + 1;

  // Move prev to the end of song_order (most-recently-used position).
  // This ensures LRU eviction removes the least-recently-played sources first.
  const songOrder = data._meta.song_order;
  const existingIdx = songOrder.indexOf(prev);
  if (existingIdx !== -1) songOrder.splice(existingIdx, 1);
  songOrder.push(prev);

  saveTallyData(cleanupTallyData(data));
}

// ── Get behavior-based recommendations ───────────────────────────────────
// Returns up to `limit` song IDs that users most frequently played after
// `songId`, sorted by descending play count then ascending ID (deterministic).
// Applies time-decay on every read so stale data naturally fades out.
function getBehaviorRecommendations(songId, limit = 5) {
  const id = String(songId || '').trim();
  if (!id) return [];

  const maxResults = Math.max(0, Math.floor(limit));
  if (maxResults === 0) return [];

  const data = applyDecayIfNeeded(loadTallyData());
  // Persist the decayed state so the next read doesn't re-apply decay
  saveTallyData(data);

  const targetMap = data.transitions[id] || {};
  const entries = Object.entries(targetMap)
    .map(([targetId, count]) => [targetId, parseInt(count, 10)])
    .filter(([, count]) => !isNaN(count) && count > 0);

  // Sort: highest count first; alphabetical tiebreak for determinism
  entries.sort(([aId, aCount], [bId, bCount]) => {
    if (bCount !== aCount) return bCount - aCount;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  return entries.slice(0, maxResults).map(([targetId]) => targetId);
}

module.exports = { updateTransition, getBehaviorRecommendations };
