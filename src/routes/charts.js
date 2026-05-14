const { Router } = require('express');
const jiosaavn = require('../scrapers/jiosaavn');
const ytmusic = require('../scrapers/ytmusic');
const { metadataCache } = require('../utils/cache');

const router = Router();

router.get('/', async (req, res) => {
  const source = req.query.source || 'jiosaavn';

  if (!['jiosaavn', 'ytmusic'].includes(source)) {
    return res.status(400).json({ error: 'invalid_source', message: 'Source must be "jiosaavn" or "ytmusic"' });
  }

  const cacheKey = `charts:${source}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const scraper = source === 'jiosaavn' ? jiosaavn : ytmusic;
    const result = await scraper.getCharts();
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source, message: err.message });
    }
    console.error(`[charts] ${source} error:`, err.message);
    res.status(500).json({ error: 'charts_failed', source, message: err.message });
  }
});

module.exports = router;
