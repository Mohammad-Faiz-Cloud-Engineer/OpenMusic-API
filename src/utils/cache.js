const NodeCache = require('node-cache');

// Search & suggestions: 5 min TTL
const searchCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Stream URLs: 25 min TTL
// FIX: was 30 min but JioSaavn auth tokens typically expire in ~1 hour.
// The route layer does its own expiry check using the expires_at field,
// but setting the cache TTL to 25 min ensures stale entries are evicted
// even when expires_at is null (DES fallback path).
const streamCache = new NodeCache({ stdTTL: 1500, checkperiod: 120 });

// Album / Playlist / Charts: 10 min TTL
const metadataCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

module.exports = { searchCache, streamCache, metadataCache };
