/**
 * behavior.js — Transition tally: records which song played after which,
 * and returns the most-frequently-followed songs for a given source song.
 * Mirrors Python behavior.py exactly.
 */

'use strict';

const { loadAndSaveTally, applyDecayIfNeeded, cleanupTallyData } = require('./storage');

// Keys that would pollute Object.prototype if used in a plain-object lookup.
// We reject them at the entry point so they never reach the tally store.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key) {
  return key.length > 0 && !UNSAFE_KEYS.has(key);
}

function createMap() {
  return Object.create(null);
}

function isObjectLike(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Return a prototype-less map, copying plain-object data when needed. */
function normalizeMap(value) {
  if (!isObjectLike(value)) return createMap();
  if (Object.getPrototypeOf(value) === null) return value;
  const map = createMap();
  for (const key of Object.keys(value)) {
    map[key] = value[key];
  }
  return map;
}

/**
 * Record that `currentSongId` was played immediately after `previousSongId`.
 * No-op if either ID is empty or they are the same song.
 */
async function updateTransition(previousSongId, currentSongId) {
  previousSongId = String(previousSongId || '').trim();
  currentSongId  = String(currentSongId  || '').trim();
  if (!previousSongId || !currentSongId || previousSongId === currentSongId) return;
  // Reject prototype-polluting key names before they touch any object.
  if (!isSafeKey(previousSongId) || !isSafeKey(currentSongId)) return;

  await loadAndSaveTally(data => {
    data = applyDecayIfNeeded(data);

    data.transitions = normalizeMap(data.transitions);
    const transitions = data.transitions;
    const existingTargets = transitions[previousSongId];
    const targets = normalizeMap(existingTargets);
    if (existingTargets !== targets) {
      transitions[previousSongId] = targets;
    }
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
  if (!songId || !isSafeKey(songId)) return [];

  const data = await loadAndSaveTally(d => applyDecayIfNeeded(d));

  const transitions = normalizeMap(data.transitions);
  const targetMap = normalizeMap(transitions[songId]);
  return Object.entries(targetMap)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}

module.exports = { updateTransition, getBehaviorRecommendations };
