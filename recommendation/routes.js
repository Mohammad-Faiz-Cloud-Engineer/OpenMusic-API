const { Router } = require('express');
const { trim } = require('../Jio Saavn/normalize');
const { updateTransition } = require('./behavior');
const { getRecommendations, getUpNext } = require('./engine');
const { recommendCache } = require('../Jio Saavn/cache');

const router = Router();

// ── Recommendations for a track ───────────────────────────────────────────
// Returns behavior-based and content-based recommendations for a given song.
// Behavior results reflect actual play-sequence history (what users played
// after this song). Content results are based on artist/language/duration
// similarity across the in-memory catalog.
//
// GET /jiosaavn/track/:id/recommendations
router.get('/track/:id/recommendations', (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({
      error: 'missing_id',
      message: 'Track ID is required',
    });
  }

  const cacheKey = `recommend:jiosaavn:${id}`;
  const cached = recommendCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const result = getRecommendations(id);
    recommendCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[jiosaavn] recommendations error:', err.message);
    res.status(500).json({
      error: 'recommendations_failed',
      source: 'jiosaavn',
      message: err.message,
    });
  }
});

// ── Up-next queue for a track ─────────────────────────────────────────────
// Returns a merged, ordered list of up to `limit` tracks for auto-play.
// Behavior-based results fill first; content-based fill remaining slots.
// Each entry includes { song_id, reason: 'behavior'|'content', ...metadata }.
//
// GET /jiosaavn/track/:id/up-next?limit=10
router.get('/track/:id/up-next', (req, res) => {
  const id = trim(req.params.id);
  if (!id) {
    return res.status(400).json({
      error: 'missing_id',
      message: 'Track ID is required',
    });
  }

  const rawLimit = req.query.limit;
  const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 10;
  if (isNaN(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({
      error: 'invalid_limit',
      message: 'Query parameter "limit" must be an integer between 1 and 50',
    });
  }

  const cacheKey = `upnext:jiosaavn:${id}:${limit}`;
  const cached = recommendCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const tracks = getUpNext(id, limit);
    const result = { source: 'jiosaavn', song_id: id, limit, tracks };
    recommendCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[jiosaavn] up-next error:', err.message);
    res.status(500).json({
      error: 'upnext_failed',
      source: 'jiosaavn',
      message: err.message,
    });
  }
});

// ── Record a play transition ──────────────────────────────────────────────
// Informs the recommendation engine that the user moved from one track to
// another. This is the only write endpoint in the recommendation system.
// Both IDs are required; self-transitions are silently ignored.
//
// POST /jiosaavn/transition
// Body (JSON): { "from": "<song_id>", "to": "<song_id>" }
router.post('/transition', (req, res) => {
  const from = trim(req.body?.from);
  const to = trim(req.body?.to);

  if (!from || !to) {
    return res.status(400).json({
      error: 'missing_ids',
      message: 'Request body must include "from" and "to" song IDs',
    });
  }

  if (from === to) {
    // Self-transitions are valid to receive but have no effect; return 200.
    return res.json({ recorded: false, reason: 'self_transition' });
  }

  try {
    updateTransition(from, to);

    // Invalidate cached recommendations for the source song so the next
    // request reflects the updated transition data.
    recommendCache.del(`recommend:jiosaavn:${from}`);
    // Invalidate all up-next cache entries for this source (any limit).
    // node-cache doesn't support prefix deletion, so we use a known range.
    for (let l = 1; l <= 50; l++) {
      recommendCache.del(`upnext:jiosaavn:${from}:${l}`);
    }

    res.json({ recorded: true, from, to });
  } catch (err) {
    console.error('[jiosaavn] transition error:', err.message);
    res.status(500).json({
      error: 'transition_failed',
      source: 'jiosaavn',
      message: err.message,
    });
  }
});

module.exports = router;
