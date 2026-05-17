const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  trim,
  decodeHtmlEntities,
  pickThumbnail,
  extractJioSaavnThumbnail,
  extractJioSaavnArtist,
  normalizeSearch,
  normalizeStream,
  normalizeAlbum,
  normalizePlaylist,
  normalizeSuggestions,
  normalizeCharts,
} = require('../src/utils/normalize');

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

describe('pickThumbnail', () => {
  it('picks the widest thumbnail from an array', () => {
    const thumbs = [
      { url: 'https://a/small.jpg', width: 120 },
      { url: 'https://a/large.jpg', width: 544 },
      { url: 'https://a/medium.jpg', width: 226 },
    ];
    assert.equal(pickThumbnail(thumbs), 'https://a/large.jpg');
  });

  it('handles a single thumbnail object', () => {
    assert.equal(
      pickThumbnail({ url: 'https://a/one.jpg', width: 100 }),
      'https://a/one.jpg',
    );
  });

  it('returns null for empty or missing input', () => {
    assert.equal(pickThumbnail(null), null);
    assert.equal(pickThumbnail([]), null);
    assert.equal(pickThumbnail([{}]), null);
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

describe('normalizeSearch (YT Music song shapes)', () => {
  it('normalizes SongDetailed shape (name + artist)', () => {
    const song = {
      type: 'SONG',
      videoId: 'vid1',
      name: 'Song A',
      artist: { name: 'Artist A' },
      album: { name: 'Album A' },
      duration: 200,
      thumbnails: [{ url: 'https://yt/s.jpg', width: 120 }],
    };
    const out = normalizeSearch('ytmusic', [song], 'q');
    assert.equal(out.results[0].title, 'Song A');
    assert.equal(out.results[0].artist, 'Artist A');
    assert.equal(out.results[0].album, 'Album A');
    assert.equal(out.results[0].duration_seconds, 200);
    assert.equal(out.results[0].thumbnail, 'https://yt/s.jpg');
  });

  it('normalizes PlaylistVideo shape (title + artists)', () => {
    const song = {
      type: 'SONG',
      videoId: 'vid2',
      title: 'Song B',
      artists: { name: 'Artist B' },
      duration: '180',
      thumbnails: [{ url: 'https://yt/l.jpg', width: 480 }],
    };
    const out = normalizeSearch('ytmusic', [song], 'q');
    assert.equal(out.results[0].title, 'Song B');
    assert.equal(out.results[0].artist, 'Artist B');
    assert.equal(out.results[0].duration_seconds, 180);
  });

  it('filters non-song types', () => {
    const data = [
      { type: 'SONG', videoId: 'a', name: 'Keep', artist: { name: 'X' }, duration: 1, thumbnails: [] },
      { type: 'ALBUM', albumId: 'b', name: 'Drop' },
    ];
    const out = normalizeSearch('ytmusic', data, 'q');
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].id, 'a');
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

  it('maps YT Music album', () => {
    const data = {
      type: 'ALBUM',
      albumId: 'yt-alb',
      name: 'YT Album',
      artist: { name: 'YT Artist' },
      year: 2023,
      songs: [{
        type: 'SONG',
        videoId: 'v1',
        name: 'YT Song',
        artist: { name: 'YT Artist' },
        duration: 100,
        thumbnails: [{ url: 'https://yt/t.jpg', width: 200 }],
      }],
    };
    const out = normalizeAlbum('ytmusic', data);
    assert.equal(out.id, 'yt-alb');
    assert.equal(out.title, 'YT Album');
    assert.equal(out.tracks[0].title, 'YT Song');
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

  it('maps YT Music playlist with injected tracks', () => {
    const data = {
      type: 'PLAYLIST',
      playlistId: 'PL1',
      name: 'Playlist',
      artist: { name: 'Owner' },
      videoCount: 1,
      tracks: [{
        type: 'SONG',
        videoId: 'v9',
        title: 'In Playlist',
        artists: { name: 'Band' },
        duration: 90,
        thumbnails: [],
      }],
    };
    const out = normalizePlaylist('ytmusic', data);
    assert.equal(out.owner, 'Owner');
    assert.equal(out.tracks[0].title, 'In Playlist');
  });
});

describe('normalizeSuggestions', () => {
  it('deduplicates JioSaavn suggestions', () => {
    const out = normalizeSuggestions('jiosaavn', { suggestions: ['  rock ', 'rock', { text: 'pop' }] }, 'r');
    assert.deepEqual(out.suggestions, ['rock', 'pop']);
  });

  it('passes through YT Music string suggestions', () => {
    const out = normalizeSuggestions('ytmusic', ['jazz', { name: 'blues' }], 'j');
    assert.deepEqual(out.suggestions, ['jazz', 'blues']);
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

  it('parses YT Music home sections', () => {
    const data = [{
      title: 'Trending',
      contents: [
        { type: 'SONG', videoId: 'skip' },
        { type: 'PLAYLIST', playlistId: 'PL99', thumbnails: [{ url: 'https://yt/p.jpg', width: 300 }] },
      ],
    }];
    const out = normalizeCharts('ytmusic', data);
    assert.equal(out.charts[0].id, 'PL99');
    assert.equal(out.charts[0].thumbnail, 'https://yt/p.jpg');
  });

  it('falls back to trending tracks for YT Music song list', () => {
    const data = [{ type: 'SONG', videoId: 'v1', name: 'Hit', artist: { name: 'A' }, duration: 60, thumbnails: [] }];
    const out = normalizeCharts('ytmusic', data);
    assert.equal(out.charts[0].id, 'trending');
    assert.equal(out.charts[0].tracks.length, 1);
  });
});
