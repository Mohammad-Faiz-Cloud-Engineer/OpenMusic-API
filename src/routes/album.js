const { Router } = require('express');
const jiosaavn = require('../scrapers/jiosaavn');
const ytmusic = require('../scrapers/ytmusic');
const { metadataCache } = require('../utils/cache');

const router = Router();

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const source = req.query.source || 'jiosaavn';

  if (!id || !id.trim()) {
    return res.status(400).json({ error: 'missing_id', message: 'Album ID is required' });
  }
  if (!['jiosaavn', 'ytmusic'].includes(source)) {
    return res.status(400).json({ error: 'invalid_source', message: 'Source must be "jiosaavn" or "ytmusic"' });
  }

  const cacheKey = `album:${source}:${id}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const scraper = source === 'jiosaavn' ? jiosaavn : ytmusic;
    const result = await scraper.getAlbum(id.trim());
    metadataCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: 'album_not_found', source, message: err.message });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source, message: err.message });
    }
    console.error(`[album] ${source} error:`, err.message);
    res.status(500).json({ error: 'album_failed', source, message: err.message });
  }
});

module.exports = router;
