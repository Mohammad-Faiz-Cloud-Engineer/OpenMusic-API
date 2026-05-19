const NodeCache = require('node-cache');

// Search & suggestions: 5 min TTL
const searchCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Stream URLs: 25 min TTL (auth tokens last ~1 hour; routes evict early via expires_at).
// When expires_at is missing (DES-decrypt fallback), this TTL is the only expiry guard.
const streamCache = new NodeCache({ stdTTL: 1500, checkperiod: 120 });

// Album / Playlist / Charts: 10 min TTL
const metadataCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Recommendations / up-next: 2 min TTL.
// Short TTL so that a new transition recorded via POST /transition is reflected
// quickly. The route handler also proactively invalidates entries on write.
const recommendCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });

module.exports = { searchCache, streamCache, metadataCache, recommendCache };
