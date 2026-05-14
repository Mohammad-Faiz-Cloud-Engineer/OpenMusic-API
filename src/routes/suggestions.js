const { Router } = require('express');
const jiosaavn = require('../scrapers/jiosaavn');
const ytmusic = require('../scrapers/ytmusic');
const { searchCache } = require('../utils/cache');

const router = Router();

router.get('/', async (req, res) => {
  const q = req.query.q;
  const source = req.query.source || 'jiosaavn';

  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'missing_query', message: 'Query parameter "q" is required' });
  }
  if (!['jiosaavn', 'ytmusic'].includes(source)) {
    return res.status(400).json({ error: 'invalid_source', message: 'Source must be "jiosaavn" or "ytmusic"' });
  }

  const cacheKey = `suggestions:${source}:${q.trim().toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const scraper = source === 'jiosaavn' ? jiosaavn : ytmusic;
    const result = await scraper.getSuggestions(q.trim());
    searchCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source, message: err.message });
    }
    console.error(`[suggestions] ${source} error:`, err.message);
    res.status(500).json({ error: 'suggestions_failed', source, message: err.message });
  }
});

module.exports = router;
