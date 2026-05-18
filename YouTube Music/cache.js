const NodeCache = require('node-cache');

// Search & suggestions: 5 min TTL
// YTM search results are relatively stable over short windows.
const searchCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Stream URLs: 25 min TTL
// Smart Track Replacement resolves to JioSaavn CDN URLs which carry an
// Expires= param (~1 hour). Routes evict early via expires_at, same as
// the JioSaavn stream cache. When expires_at is absent (decrypt fallback),
// this TTL is the only expiry guard.
const streamCache = new NodeCache({ stdTTL: 1500, checkperiod: 120 });

// Metadata (charts stub): 10 min TTL
// Charts are currently empty for YTM (auth required), but the cache layer
// is kept consistent with JioSaavn so the route handler is identical.
const metadataCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

module.exports = { searchCache, streamCache, metadataCache };
