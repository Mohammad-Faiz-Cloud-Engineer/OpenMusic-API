const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDuration,
  parseSubtitleRuns,
  extractYtmThumbnail,
  parseListItemRenderer,
  normalizeSearch,
  normalizeStream,
  normalizeSuggestions,
  normalizeCharts,
  decodeHtmlEntities,
} = require('../YouTube Music/normalize');

// ── decodeHtmlEntities ────────────────────────────────────────────────────
describe('decodeHtmlEntities (YouTube Music)', () => {
  it('decodes named entities', () => {
    assert.equal(decodeHtmlEntities('Rock &amp; Roll'), 'Rock & Roll');
    assert.equal(decodeHtmlEntities('&lt;tag&gt;'), '<tag>');
    assert.equal(decodeHtmlEntities('&quot;hi&quot;'), '"hi"');
    assert.equal(decodeHtmlEntities("Don&#39;t"), "Don't");
    assert.equal(decodeHtmlEntities('&apos;ok&apos;'), "'ok'");
  });

  it('decodes decimal and hex numeric character references', () => {
    assert.equal(decodeHtmlEntities('&#8217;'), '\u2019');
    assert.equal(decodeHtmlEntities('&#x2019;'), '\u2019');
    assert.equal(decodeHtmlEntities('&#x27;'), "'");
  });

  it('does not fully unescape double-encoded markup', () => {
    const partial = decodeHtmlEntities('&amp;lt;script&gt;');
    assert.notEqual(partial, '<script>');
    assert.ok(partial.includes('&lt;'));
  });

  it('returns non-strings unchanged', () => {
    assert.equal(decodeHtmlEntities(''), '');
    assert.equal(decodeHtmlEntities(null), null);
    assert.equal(decodeHtmlEntities(undefined), undefined);
  });
});

// ── parseDuration ─────────────────────────────────────────────────────────
describe('parseDuration', () => {
  it('parses M:SS', () => {
    assert.equal(parseDuration('3:45'), 225);
  });

  it('parses MM:SS', () => {
    assert.equal(parseDuration('10:05'), 605);
  });

  it('parses H:MM:SS', () => {
    assert.equal(parseDuration('1:02:03'), 3723);
  });

  it('returns 0 for non-duration strings', () => {
    assert.equal(parseDuration('Artist Name'), 0);
    assert.equal(parseDuration('1.2M plays'), 0);
    assert.equal(parseDuration(''), 0);
    assert.equal(parseDuration(null), 0);
  });
});

// ── parseSubtitleRuns ─────────────────────────────────────────────────────
describe('parseSubtitleRuns', () => {
  const run = text => ({ text });
  const bullet = () => ({ text: ' \u2022 ' });

  it('extracts artist from [Song, •, Artist]', () => {
    const runs = [run('Song'), bullet(), run('Arijit Singh')];
    const out = parseSubtitleRuns(runs);
    assert.equal(out.artist, 'Arijit Singh');
    assert.equal(out.album, '');
    assert.equal(out.duration_seconds, 0);
  });

  it('extracts artist + album from [Song, •, Artist, •, Album]', () => {
    const runs = [run('Song'), bullet(), run('Pritam'), bullet(), run('Ae Dil Hai Mushkil')];
    const out = parseSubtitleRuns(runs);
    assert.equal(out.artist, 'Pritam');
    assert.equal(out.album, 'Ae Dil Hai Mushkil');
  });

  it('extracts artist + album + duration from full subtitle', () => {
    const runs = [
      run('Song'), bullet(), run('Arijit Singh'), bullet(), run('Tum Hi Ho'), bullet(), run('4:22'),
    ];
    const out = parseSubtitleRuns(runs);
    assert.equal(out.artist, 'Arijit Singh');
    assert.equal(out.album, 'Tum Hi Ho');
    assert.equal(out.duration_seconds, 262);
  });

  it('handles subtitle without type indicator', () => {
    const runs = [run('Dino James'), bullet(), run('3:33')];
    const out = parseSubtitleRuns(runs);
    assert.equal(out.artist, 'Dino James');
    assert.equal(out.duration_seconds, 213);
  });

  it('decodes HTML entities in artist and album runs', () => {
    const runs = [
      run('Song'), bullet(),
      run('Shankar &amp; Ehsaan &amp; Loy'), bullet(),
      run('Dil &amp; Dhadkan'),
    ];
    const out = parseSubtitleRuns(runs);
    assert.equal(out.artist, 'Shankar & Ehsaan & Loy');
    assert.equal(out.album, 'Dil & Dhadkan');
  });

  it('ignores play-count strings as album', () => {
    const runs = [run('Song'), bullet(), run('Artist'), bullet(), run('1.2M plays')];
    const out = parseSubtitleRuns(runs);
    assert.equal(out.artist, 'Artist');
    assert.equal(out.album, '');
  });

  it('returns Unknown artist for empty runs', () => {
    const out = parseSubtitleRuns([]);
    assert.equal(out.artist, 'Unknown');
    assert.equal(out.duration_seconds, 0);
  });
});

// ── extractYtmThumbnail ───────────────────────────────────────────────────
describe('extractYtmThumbnail', () => {
  it('picks the widest thumbnail from musicThumbnailRenderer', () => {
    const item = {
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [
              { url: 'https://yt/small.jpg', width: 60, height: 60 },
              { url: 'https://yt/large.jpg', width: 226, height: 226 },
              { url: 'https://yt/medium.jpg', width: 120, height: 120 },
            ],
          },
        },
      },
    };
    assert.equal(extractYtmThumbnail(item), 'https://yt/large.jpg');
  });

  it('falls back to thumbnail.thumbnails array', () => {
    const item = {
      thumbnail: {
        thumbnails: [
          { url: 'https://yt/a.jpg', width: 40 },
          { url: 'https://yt/b.jpg', width: 300 },
        ],
      },
    };
    assert.equal(extractYtmThumbnail(item), 'https://yt/b.jpg');
  });

  it('returns null when no thumbnails present', () => {
    assert.equal(extractYtmThumbnail({}), null);
    assert.equal(extractYtmThumbnail(null), null);
    assert.equal(
      extractYtmThumbnail({ thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [] } } } }),
      null
    );
  });
});

// ── parseListItemRenderer ─────────────────────────────────────────────────
describe('parseListItemRenderer', () => {
  function makeItem({ videoId, titleText, subtitleRuns = [], explicit = false }) {
    return {
      musicResponsiveListItemRenderer: {
        playlistItemData: { videoId },
        flexColumns: [
          {
            musicResponsiveListItemFlexColumnRenderer: {
              text: { runs: [{ text: titleText }] },
            },
          },
          {
            musicResponsiveListItemFlexColumnRenderer: {
              text: { runs: subtitleRuns },
            },
          },
        ],
        thumbnail: {
          musicThumbnailRenderer: {
            thumbnail: {
              thumbnails: [{ url: 'https://yt/thumb.jpg', width: 226 }],
            },
          },
        },
        badges: explicit
          ? [{ musicInlineBadgeRenderer: { icon: { iconType: 'MUSIC_EXPLICIT_BADGE' } } }]
          : [],
      },
    };
  }

  it('parses a standard song item', () => {
    const item = makeItem({
      videoId: 'abc123',
      titleText: 'Tere Naal',
      subtitleRuns: [
        { text: 'Song' }, { text: ' \u2022 ' },
        { text: 'Dino James' }, { text: ' \u2022 ' },
        { text: 'Tere Naal' }, { text: ' \u2022 ' },
        { text: '3:33' },
      ],
    });
    const out = parseListItemRenderer(item);
    assert.equal(out.id, 'abc123');
    assert.equal(out.title, 'Tere Naal');
    assert.equal(out.artist, 'Dino James');
    assert.equal(out.album, 'Tere Naal');
    assert.equal(out.duration_seconds, 213);
    assert.equal(out.stream_url, null);
    assert.equal(out.explicit, false);
  });

  it('decodes HTML entities in title', () => {
    const item = makeItem({
      videoId: 'ent1',
      titleText: 'Rock &amp; Roll',
      subtitleRuns: [{ text: 'Song' }, { text: ' \u2022 ' }, { text: 'Artist' }],
    });
    const out = parseListItemRenderer(item);
    assert.equal(out.title, 'Rock & Roll');
  });

  it('decodes HTML entities in artist and album via subtitle runs', () => {
    const item = makeItem({
      videoId: 'ent2',
      titleText: 'Track',
      subtitleRuns: [
        { text: 'Song' }, { text: ' \u2022 ' },
        { text: 'A &amp; B' }, { text: ' \u2022 ' },
        { text: 'C &amp; D' },
      ],
    });
    const out = parseListItemRenderer(item);
    assert.equal(out.artist, 'A & B');
    assert.equal(out.album, 'C & D');
  });

  it('marks explicit tracks', () => {
    const item = makeItem({ videoId: 'x1', titleText: 'Track', explicit: true });
    const out = parseListItemRenderer(item);
    assert.equal(out.explicit, true);
  });

  it('returns null when videoId is missing', () => {
    const item = makeItem({ videoId: null, titleText: 'No ID' });
    assert.equal(parseListItemRenderer(item), null);
  });

  it('returns null for non-list-item shapes', () => {
    assert.equal(parseListItemRenderer({}), null);
    assert.equal(parseListItemRenderer(null), null);
  });
});

// ── normalizeSearch ───────────────────────────────────────────────────────
describe('normalizeSearch', () => {
  it('returns empty results for empty/unknown data', () => {
    const out = normalizeSearch({}, 'test');
    assert.equal(out.source, 'youtube');
    assert.equal(out.query, 'test');
    assert.deepEqual(out.results, []);
  });

  it('filters out items with no duration and Unknown artist', () => {
    const data = {
      contents: {
        tabbedSearchResultsRenderer: {
          tabs: [{
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [{
                    musicShelfRenderer: {
                      contents: [
                        // Valid song item
                        {
                          musicResponsiveListItemRenderer: {
                            playlistItemData: { videoId: 'vid1' },
                            flexColumns: [
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Song Title' }] } } },
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Song' }, { text: ' \u2022 ' }, { text: 'Artist' }, { text: ' \u2022 ' }, { text: '3:00' }] } } },
                            ],
                            thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://yt/t.jpg', width: 100 }] } } },
                            badges: [],
                          },
                        },
                        // Artist card (no videoId → filtered by parseListItemRenderer)
                        {
                          musicResponsiveListItemRenderer: {
                            playlistItemData: null,
                            flexColumns: [],
                            badges: [],
                          },
                        },
                      ],
                    },
                  }],
                },
              },
            },
          }],
        },
      },
    };
    const out = normalizeSearch(data, 'test');
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].id, 'vid1');
  });
});

// ── normalizeStream ───────────────────────────────────────────────────────
describe('normalizeStream', () => {
  it('builds a stream payload with defaults', () => {
    const out = normalizeStream('vid1', 'https://cdn/stream.m4a', null, null, null);
    assert.deepEqual(out, {
      id: 'vid1',
      source: 'youtube',
      quality: 'unknown',
      format: 'm4a',
      stream_url: 'https://cdn/stream.m4a',
      expires_at: null,
    });
  });

  it('preserves provided quality, format, and expires_at', () => {
    const out = normalizeStream('vid2', 'https://cdn/s.m4a', 'm4a', '320kbps', '2026-01-01T00:00:00Z');
    assert.equal(out.quality, '320kbps');
    assert.equal(out.format, 'm4a');
    assert.equal(out.expires_at, '2026-01-01T00:00:00Z');
  });
});

// ── normalizeSuggestions ──────────────────────────────────────────────────
describe('normalizeSuggestions', () => {
  it('extracts suggestions from searchSuggestionsSectionRenderer', () => {
    const data = {
      contents: [{
        searchSuggestionsSectionRenderer: {
          contents: [
            { searchSuggestionRenderer: { suggestion: { runs: [{ text: 'tere naal' }] } } },
            { searchSuggestionRenderer: { suggestion: { runs: [{ text: 'tere ' }, { text: 'bina' }] } } },
          ],
        },
      }],
    };
    const out = normalizeSuggestions(data, 'tere');
    assert.deepEqual(out.suggestions, ['tere naal', 'tere bina']);
  });

  it('decodes HTML entities in suggestions', () => {
    const data = {
      contents: [{
        searchSuggestionsSectionRenderer: {
          contents: [
            { searchSuggestionRenderer: { suggestion: { runs: [{ text: 'rock &amp; roll' }] } } },
          ],
        },
      }],
    };
    const out = normalizeSuggestions(data, 'rock');
    assert.deepEqual(out.suggestions, ['rock & roll']);
  });

  it('deduplicates suggestions', () => {
    const data = {
      contents: [{
        searchSuggestionsSectionRenderer: {
          contents: [
            { searchSuggestionRenderer: { suggestion: { runs: [{ text: 'rock' }] } } },
            { searchSuggestionRenderer: { suggestion: { runs: [{ text: 'rock' }] } } },
            { searchSuggestionRenderer: { suggestion: { runs: [{ text: 'pop' }] } } },
          ],
        },
      }],
    };
    const out = normalizeSuggestions(data, 'r');
    assert.deepEqual(out.suggestions, ['rock', 'pop']);
  });

  it('returns empty suggestions for unknown shape', () => {
    const out = normalizeSuggestions({}, 'q');
    assert.deepEqual(out.suggestions, []);
    assert.equal(out.source, 'youtube');
  });
});

// ── normalizeCharts ───────────────────────────────────────────────────────
describe('normalizeCharts', () => {
  it('always returns empty charts (YTM requires auth)', () => {
    const out = normalizeCharts({});
    assert.equal(out.source, 'youtube');
    assert.deepEqual(out.charts, []);
  });
});
