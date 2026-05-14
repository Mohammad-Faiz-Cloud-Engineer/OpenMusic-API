const { Router } = require('express');
const axios = require('axios');
const jiosaavn = require('../scrapers/jiosaavn');
const ytmusic = require('../scrapers/ytmusic');
const { streamCache } = require('../utils/cache');

const router = Router();

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const source = req.query.source || 'jiosaavn';

  if (!id || !id.trim()) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID is required' });
  }
  if (!['jiosaavn', 'ytmusic'].includes(source)) {
    return res.status(400).json({ error: 'invalid_source', message: 'Source must be "jiosaavn" or "ytmusic"' });
  }

  const cacheKey = `stream:${source}:${id}`;
  const cached = streamCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const scraper = source === 'jiosaavn' ? jiosaavn : ytmusic;
    const result = await scraper.getStreamUrl(id.trim());
    streamCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.message?.includes('No encrypted media') || err.message?.includes('not found')) {
      return res.status(404).json({ error: 'track_not_found', source, message: err.message });
    }
    if (err.message?.includes('Failed to decrypt')) {
      console.error(`[stream] Decryption failed for ${id}:`, err.message);
      return res.status(500).json({ error: 'decryption_failed', source, message: 'Failed to decrypt stream URL' });
    }
    if (err.message?.includes('unavailable') || err.message?.includes('timed out')) {
      return res.status(503).json({ error: 'source_unavailable', source, message: err.message });
    }
    console.error(`[stream] ${source} error:`, err.message);
    res.status(500).json({ error: 'stream_failed', source, message: err.message });
  }
});

// Proxy endpoint: pipes the audio stream through the backend with proper headers
// The browser's <audio> element cannot set custom Referer headers, but JioSaavn's
// CDN requires them. This proxy fetches the stream server-side and pipes it to the client.
router.get('/:id/play', async (req, res) => {
  const { id } = req.params;
  const source = req.query.source || 'jiosaavn';

  if (!id || !id.trim()) {
    return res.status(400).json({ error: 'missing_id', message: 'Track ID is required' });
  }
  if (!['jiosaavn', 'ytmusic'].includes(source)) {
    return res.status(400).json({ error: 'invalid_source', message: 'Source must be "jiosaavn" or "ytmusic"' });
  }

  if (source === 'ytmusic') {
    return res.status(400).json({ error: 'ytmusic_not_supported', message: 'YouTube Music streaming is not available through this API. Open the video on YouTube directly.' });
  }

  try {
    const result = await jiosaavn.getStreamUrl(id.trim());

    if (!result.stream_url) {
      return res.status(404).json({ error: 'no_stream', message: 'No playable stream URL found for this track' });
    }

    const range = req.headers.range;
    const axiosConfig = {
      method: 'get',
      url: result.stream_url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.jiosaavn.com/',
      },
      timeout: 30000,
    };

    if (range) {
      axiosConfig.headers['Range'] = range;
    }

    const cdnRes = await axios(axiosConfig);

    const contentType = cdnRes.headers['content-type'];
    if (contentType) {
      res.set('Content-Type', contentType);
    } else {
      res.set('Content-Type', 'audio/mp4');
    }

    if (cdnRes.headers['content-length']) {
      res.set('Content-Length', cdnRes.headers['content-length']);
    }

    if (cdnRes.headers['accept-ranges']) {
      res.set('Accept-Ranges', cdnRes.headers['accept-ranges']);
    }

    if (range && cdnRes.headers['content-range']) {
      res.set('Content-Range', cdnRes.headers['content-range']);
    }
    if (cdnRes.status === 206) {
      res.status(206);
    }

    cdnRes.data.on('error', (streamErr) => {
      console.error(`[proxy] Stream error for ${id}:`, streamErr.message);
      if (!res.headersSent) {
        return res.status(502).json({ error: 'proxy_stream_error', message: `Stream error: ${streamErr.message}` });
      }
      res.end();
    });

    req.on('close', () => {
      cdnRes.data.destroy();
    });

    cdnRes.data.pipe(res);
  } catch (err) {
    console.error(`[proxy] Error streaming ${id}:`, err.message);
    if (err.response?.status === 403 || err.message?.includes('403')) {
      return res.status(502).json({ error: 'proxy_forbidden', message: 'Stream source rejected the request (403). The CDN may be blocking our server.' });
    }
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'proxy_timeout', message: 'Stream source timed out' });
    }
    res.status(502).json({ error: 'proxy_error', message: `Failed to proxy stream: ${err.message}` });
  }
});

module.exports = router;
