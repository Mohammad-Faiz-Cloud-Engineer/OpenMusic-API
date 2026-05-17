/**
 * engine.js — Combines behavior-based and content-based recommendations.
 * Mirrors Python engine.py exactly.
 *
 * getRecommendations(songId)
 *   → { behavior_based: [...ids], content_based: [...ids] }
 *
 * getUpNext(songId, limit)
 *   → [{ song_id, reason: 'behavior'|'content' }, ...]
 */

'use strict';

const { getBehaviorRecommendations } = require('./behavior');
const { getSimilarSongs }            = require('./content');

async function getRecommendations(songId) {
  songId = String(songId || '').trim();
  if (!songId) return { behavior_based: [], content_based: [] };

  const behaviorIds = (await getBehaviorRecommendations(songId, 5))
    .filter(id => id !== songId);
  const behaviorSeen = new Set(behaviorIds);

  const contentIds = getSimilarSongs(songId, 5)
    .filter(id => id !== songId && !behaviorSeen.has(id));

  return { behavior_based: behaviorIds, content_based: contentIds };
}

async function getUpNext(songId, limit = 10) {
  songId = String(songId || '').trim();
  const max = Math.max(0, parseInt(limit, 10) || 0);
  if (!songId || max === 0) return [];

  const combined = [];
  const seen = new Set([songId]);

  for (const id of await getBehaviorRecommendations(songId, max)) {
    if (seen.has(id)) continue;
    combined.push({ song_id: id, reason: 'behavior' });
    seen.add(id);
    if (combined.length >= max) return combined;
  }

  for (const id of getSimilarSongs(songId, max)) {
    if (seen.has(id)) continue;
    combined.push({ song_id: id, reason: 'content' });
    seen.add(id);
    if (combined.length >= max) break;
  }

  return combined;
}

module.exports = { getRecommendations, getUpNext };
