/**
 * behavior.js — Transition tally: records which song played after which,
 * and returns the most-frequently-followed songs for a given source song.
 * Mirrors Python behavior.py exactly.
 */

'use strict';

const { loadAndSaveTally, applyDecayIfNeeded, cleanupTallyData } = require('./storage');

/**
 * Record that `currentSongId` was played immediately after `previousSongId`.
 * No-op if either ID is empty or they are the same song.
 */
async function updateTransition(previousSongId, currentSongId) {
  previousSongId = String(previousSongId || '').trim();
  currentSongId  = String(currentSongId  || '').trim();
  if (!previousSongId || !currentSongId || previousSongId === currentSongId) return;

  await loadAndSaveTally(data => {
    data = applyDecayIfNeeded(data);

    const transitions = data.transitions || (data.transitions = {});
    const targets = transitions[previousSongId] || (transitions[previousSongId] = {});
    targets[currentSongId] = (targets[currentSongId] || 0) + 1;

    const order = data._meta.song_order || (data._meta.song_order = []);
    const idx = order.indexOf(previousSongId);
    if (idx !== -1) order.splice(idx, 1);
    order.push(previousSongId);

    return cleanupTallyData(data);
  });
}

/**
 * Return up to `limit` song IDs that most often followed `songId`,
 * sorted by descending play count then ascending ID for tie-breaking.
 */
async function getBehaviorRecommendations(songId, limit = 5) {
  songId = String(songId || '').trim();
  if (!songId) return [];

  const data = await loadAndSaveTally(d => applyDecayIfNeeded(d));

  const targetMap = (data.transitions || {})[songId] || {};
  return Object.entries(targetMap)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

module.exports = { updateTransition, getBehaviorRecommendations };
