const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  trim,
  decodeHtmlEntities,
  extractJioSaavnThumbnail,
  extractJioSaavnArtist,
  normalizeSearch,
  normalizeStream,
  normalizeAlbum,
  normalizePlaylist,
  normalizeSuggestions,
  normalizeCharts,
} = require('../Jio Saavn/normalize');

describe('trim', () => {
  it('trims strings and passes through non-strings', () => {
    assert.equal(trim('  hello  '), 'hello');
    assert.equal(trim(42), 42);
    assert.equal(trim(null), null);
  });
});

describe('decodeHtmlEntities', () => {
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
    assert.equal(decodeHtmlEntities('&#X2019;'), '\u2019');
    assert.equal(decodeHtmlEntities('&#x27;'), "'");
    assert.equal(decodeHtmlEntities('&#X27;'), "'");
  });

  it('does not fully unescape double-encoded markup to dangerous HTML', () => {
    const partial = decodeHtmlEntities('&amp;lt;script&gt;');
    assert.notEqual(partial, '<script>');
    assert.ok(partial.includes('&lt;'));
    assert.equal(decodeHtmlEntities('Tom &amp;amp; Jerry'), 'Tom &amp; Jerry');
  });

  it('returns non-strings unchanged', () => {
    assert.equal(decodeHtmlEntities(''), '');
    assert.equal(decodeHtmlEntities(null), null);
    assert.equal(decodeHtmlEntities(undefined), undefined);
  });
});

describe('extractJioSaavnThumbnail', () => {
  it('upgrades string image URLs to 500x500', () => {
    assert.equal(
      extractJioSaavnThumbnail({ image: 'https://cdn.example/150x150.jpg' }),
      'https://cdn.example/500x500.jpg',
    );
  });

  it('uses the last quality entry from an image array', () => {
    const item = {
      image: [
        { quality: '50x50', link: 'https://cdn.example/50x50.jpg' },
        { quality: '500x500', link: 'https://cdn.example/500x500.jpg' },
      ],
    };
    assert.equal(extractJioSaavnThumbnail(item), 'https://cdn.example/500x500.jpg');
  });

  it('returns null when image is missing', () => {
    assert.equal(extractJioSaavnThumbnail({}), null);
    assert.equal(extractJioSaavnThumbnail({ image: [] }), null);
  });
});

describe('extractJioSaavnArtist', () => {
  it('prefers primary_artists from more_info.artistMap', () => {
    const item = {
      more_info: {
        artistMap: {
          primary_artists: [{ name: 'Arijit' }, { name: 'Arijit' }, { name: 'Pritam' }],
        },
      },
    };
    assert.equal(extractJioSaavnArtist(item), 'Arijit, Pritam');
  });

  it('parses artist from subtitle before music field', () => {
    assert.equal(
      extractJioSaavnArtist({ subtitle: 'Artist Name - Album Name', more_info: { music: 'Other' } }),
      'Artist Name',
    );
  });

  it('falls back to Unknown', () => {
    assert.equal(extractJioSaavnArtist({}), 'Unknown');
  });
});

describe('normalizeSearch (JioSaavn response shapes)', () => {
  const baseSong = {
    id: 'abc123',
    title: 'Tere &amp; Naal',
    duration: '240',
    image: 'https://cdn.example/150x150.jpg',
    more_info: {
      album: 'Album',
      artistMap: { primary_artists: [{ name: 'Artist' }] },
    },
  };

  it('parses { results: [] }', () => {
    const out = normalizeSearch('jiosaavn', { results: [baseSong] }, 'q');
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].title, 'Tere & Naal');
    assert.equal(out.results[0].id, 'abc123');
    assert.equal(out.results[0].stream_url, null);
  });

  it('parses top-level array', () => {
    const out = normalizeSearch('jiosaavn', [baseSong], 'q');
    assert.equal(out.results.length, 1);
  });

  it('parses { entities: [] } and { songs: [] }', () => {
    assert.equal(normalizeSearch('jiosaavn', { entities: [baseSong] }, 'q').results.length, 1);
    assert.equal(normalizeSearch('jiosaavn', { songs: [baseSong] }, 'q').results.length, 1);
  });

  it('filters out albums and artists without duration', () => {
    const data = {
      results: [
        baseSong,
        { id: 'x', type: 'album', title: 'An Album' },
        { id: 'y', type: 'artist', title: 'An Artist' },
      ],
    };
    const out = normalizeSearch('jiosaavn', data, 'q');
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].id, 'abc123');
  });

  it('uses perma_url slug when id is missing', () => {
    const song = {
      ...baseSong,
      id: '',
      perma_url: 'https://www.jiosaavn.com/song/slug-id',
    };
    const out = normalizeSearch('jiosaavn', { results: [song] }, 'q');
    assert.equal(out.results[0].id, 'slug-id');
  });
});

describe('normalizeStream', () => {
  it('builds a stream payload with defaults', () => {
    const out = normalizeStream('jiosaavn', 'id1', 'https://cdn/stream.m4a', null, null, '2026-01-01T00:00:00Z');
    assert.deepEqual(out, {
      id: 'id1',
      source: 'jiosaavn',
      quality: 'unknown',
      format: 'm4a',
      stream_url: 'https://cdn/stream.m4a',
      expires_at: '2026-01-01T00:00:00Z',
    });
  });
});

describe('normalizeAlbum', () => {
  it('maps JioSaavn album with songs array', () => {
    const data = {
      albumid: 'alb1',
      title: 'My &amp; Album',
      year: '2024',
      songs: [{
        id: 't1',
        title: 'Track',
        duration: '60',
        more_info: { artistMap: { primary_artists: [{ name: 'Singer' }] } },
      }],
    };
    const out = normalizeAlbum('jiosaavn', data);
    assert.equal(out.title, 'My & Album');
    assert.equal(out.tracks.length, 1);
    assert.equal(out.tracks[0].track_number, 1);
    assert.equal(out.tracks[0].artist, 'Singer');
  });

  it('maps JioSaavn album with list array', () => {
    const data = {
      id: 'alb2',
      name: 'List Album',
      list: [{ id: 't2', title: 'T2', duration: '30' }],
    };
    const out = normalizeAlbum('jiosaavn', data);
    assert.equal(out.tracks.length, 1);
    assert.equal(out.tracks[0].id, 't2');
  });
});

describe('normalizePlaylist', () => {
  it('maps JioSaavn playlist and decodes title', () => {
    const data = {
      listid: 'pl1',
      listname: 'Mix &amp; Match',
      songs: [{ id: 's1', title: 'One', duration: '10' }],
    };
    const out = normalizePlaylist('jiosaavn', data);
    assert.equal(out.title, 'Mix & Match');
    assert.equal(out.tracks[0].track_number, 1);
  });
});

describe('normalizeSuggestions', () => {
  it('deduplicates JioSaavn suggestions', () => {
    const out = normalizeSuggestions('jiosaavn', { suggestions: ['  rock ', 'rock', { text: 'pop' }] }, 'r');
    assert.deepEqual(out.suggestions, ['rock', 'pop']);
  });
});

describe('normalizeCharts', () => {
  it('parses JioSaavn charts, tabs, and top-level array shapes', () => {
    const chart = { id: 'c1', title: 'Top &amp; Hits', image: 'https://cdn/50x50.jpg' };
    assert.equal(normalizeCharts('jiosaavn', { charts: [chart] }).charts[0].title, 'Top & Hits');
    assert.equal(normalizeCharts('jiosaavn', { tabs: [chart] }).charts.length, 1);
    assert.equal(normalizeCharts('jiosaavn', [chart]).charts.length, 1);
  });

  it('drops JioSaavn charts without id', () => {
    const out = normalizeCharts('jiosaavn', { charts: [{ title: 'No ID' }] });
    assert.equal(out.charts.length, 0);
  });
});
