const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ── Isolate tally storage to a temp file for every test run ───────────────
const tmpTally = path.join(os.tmpdir(), `openmusic_test_tally_${process.pid}.json`);
process.env.OPENMUSIC_TALLY_PATH = tmpTally;

// Require modules AFTER setting the env var so they pick up the temp path.
const {
  loadTallyData,
  saveTallyData,
  applyDecayIfNeeded,
  cleanupTallyData,
  defaultTallyData,
  MAX_STORED_SONGS,
  MAX_TRANSITIONS_PER_SONG,
  DECAY_INTERVAL_MS,
  DECAY_FACTOR,
} = require('../recommendation/storage');

const { updateTransition, getBehaviorRecommendations } = require('../recommendation/behavior');

const {
  upsertSongRecords,
  getSongById,
  getSongsByIds,
  getSimilarSongs,
  getCatalogSize,
  _clearCatalog,
} = require('../recommendation/content');

const { getRecommendations, getUpNext } = require('../recommendation/engine');

// ── Helpers ───────────────────────────────────────────────────────────────
function resetTally() {
  if (fs.existsSync(tmpTally)) fs.unlinkSync(tmpTally);
}

// ─────────────────────────────────────────────────────────────────────────
// storage.js
// ─────────────────────────────────────────────────────────────────────────

describe('storage — defaultTallyData', () => {
  it('returns a valid skeleton with empty transitions and song_order', () => {
    const data = defaultTallyData();
    assert.deepEqual(data.transitions, {});
    assert.deepEqual(data._meta.song_order, []);
    assert.ok(typeof data._meta.last_decay_at === 'string');
  });
});

describe('storage — loadTallyData / saveTallyData', () => {
  beforeEach(resetTally);

  it('creates the tally file on first load', () => {
    loadTallyData();
    assert.ok(fs.existsSync(tmpTally));
  });

  it('round-trips data through save and load', () => {
    const data = defaultTallyData();
    data.transitions['a'] = { b: 3 };
    data._meta.song_order = ['a'];
    saveTallyData(data);

    const loaded = loadTallyData();
    assert.equal(loaded.transitions['a']['b'], 3);
    assert.ok(loaded._meta.song_order.includes('a'));
  });

  it('recovers gracefully from a corrupt tally file', () => {
    fs.writeFileSync(tmpTally, 'not valid json', 'utf8');
    const data = loadTallyData();
    assert.deepEqual(data.transitions, {});
  });
});

describe('storage — applyDecayIfNeeded', () => {
  it('does not decay when less than one interval has elapsed', () => {
    const data = defaultTallyData();
    data.transitions['a'] = { b: 8 };
    const now = Date.now();
    data._meta.last_decay_at = new Date(now - DECAY_INTERVAL_MS / 2).toISOString();

    const result = applyDecayIfNeeded(data, now);
    assert.equal(result.transitions['a']['b'], 8);
  });

  it('halves counts after one decay interval', () => {
    const data = defaultTallyData();
    data.transitions['a'] = { b: 8 };
    const now = Date.now();
    data._meta.last_decay_at = new Date(now - DECAY_INTERVAL_MS - 1000).toISOString();

    const result = applyDecayIfNeeded(data, now);
    // floor(8 * 0.5) = 4
    assert.equal(result.transitions['a']['b'], 4);
  });

  it('removes entries that decay to zero', () => {
    const data = defaultTallyData();
    data.transitions['a'] = { b: 1 };
    const now = Date.now();
    // Two intervals: floor(1 * 0.25) = 0 → removed
    data._meta.last_decay_at = new Date(now - 2 * DECAY_INTERVAL_MS - 1000).toISOString();

    const result = applyDecayIfNeeded(data, now);
    assert.equal(result.transitions['a'], undefined);
  });

  it('advances last_decay_at by the number of elapsed intervals', () => {
    const data = defaultTallyData();
    data.transitions['a'] = { b: 100 };
    const now = Date.now();
    const twoIntervalsAgo = now - 2 * DECAY_INTERVAL_MS - 1000;
    data._meta.last_decay_at = new Date(twoIntervalsAgo).toISOString();

    const result = applyDecayIfNeeded(data, now);
    const newDecayAt = new Date(result._meta.last_decay_at).getTime();
    // Should be approximately twoIntervalsAgo + 2 * DECAY_INTERVAL_MS
    const expected = twoIntervalsAgo + 2 * DECAY_INTERVAL_MS;
    assert.ok(Math.abs(newDecayAt - expected) < 2000);
  });
});

describe('storage — cleanupTallyData', () => {
  it('enforces MAX_TRANSITIONS_PER_SONG, keeping top-N by count', () => {
    const data = defaultTallyData();
    data.transitions['a'] = { b: 10, c: 5, d: 3, e: 1 };
    data._meta.song_order = ['a'];

    const result = cleanupTallyData(data);
    const targets = Object.keys(result.transitions['a']);
    assert.equal(targets.length, MAX_TRANSITIONS_PER_SONG);
    // Top 3 by count: b, c, d
    assert.ok('b' in result.transitions['a']);
    assert.ok('c' in result.transitions['a']);
    assert.ok('d' in result.transitions['a']);
    assert.ok(!('e' in result.transitions['a']));
  });

  it('evicts oldest source when MAX_STORED_SONGS is exceeded', () => {
    const data = defaultTallyData();
    // Fill exactly MAX_STORED_SONGS + 1 sources
    for (let i = 0; i <= MAX_STORED_SONGS; i++) {
      const src = `song_${String(i).padStart(3, '0')}`;
      data.transitions[src] = { target: 1 };
      data._meta.song_order.push(src);
    }

    const result = cleanupTallyData(data);
    assert.equal(result._meta.song_order.length, MAX_STORED_SONGS);
    // The first song (oldest) should have been evicted
    assert.ok(!('song_000' in result.transitions));
  });

  it('removes sources with no remaining targets', () => {
    const data = defaultTallyData();
    data.transitions['a'] = {};
    data._meta.song_order = ['a'];

    const result = cleanupTallyData(data);
    assert.equal(result.transitions['a'], undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// behavior.js
// ─────────────────────────────────────────────────────────────────────────

describe('behavior — updateTransition', () => {
  beforeEach(resetTally);

  it('records a transition and increments the counter', () => {
    updateTransition('a', 'b');
    const data = loadTallyData();
    assert.equal(data.transitions['a']['b'], 1);
  });

  it('accumulates multiple transitions', () => {
    updateTransition('a', 'b');
    updateTransition('a', 'b');
    updateTransition('a', 'c');
    const data = loadTallyData();
    assert.equal(data.transitions['a']['b'], 2);
    assert.equal(data.transitions['a']['c'], 1);
  });

  it('ignores self-transitions', () => {
    updateTransition('a', 'a');
    const data = loadTallyData();
    assert.equal(data.transitions['a'], undefined);
  });

  it('ignores empty or null IDs', () => {
    updateTransition('', 'b');
    updateTransition(null, 'b');
    updateTransition('a', '');
    const data = loadTallyData();
    assert.deepEqual(data.transitions, {});
  });

  it('moves source to end of song_order on each call (LRU)', () => {
    updateTransition('a', 'x');
    updateTransition('b', 'x');
    updateTransition('a', 'y'); // 'a' should move to end

    const data = loadTallyData();
    const order = data._meta.song_order;
    assert.equal(order[order.length - 1], 'a');
  });
});

describe('behavior — getBehaviorRecommendations', () => {
  beforeEach(resetTally);

  it('returns empty array for unknown song', () => {
    assert.deepEqual(getBehaviorRecommendations('unknown'), []);
  });

  it('returns empty array for empty or null input', () => {
    assert.deepEqual(getBehaviorRecommendations(''), []);
    assert.deepEqual(getBehaviorRecommendations(null), []);
  });

  it('returns recommendations sorted by descending count', () => {
    updateTransition('a', 'b');
    updateTransition('a', 'b');
    updateTransition('a', 'b');
    updateTransition('a', 'c');
    updateTransition('a', 'c');
    updateTransition('a', 'd');

    const recs = getBehaviorRecommendations('a', 3);
    assert.deepEqual(recs, ['b', 'c', 'd']);
  });

  it('respects the limit parameter', () => {
    updateTransition('a', 'b');
    updateTransition('a', 'c');
    updateTransition('a', 'd');

    const recs = getBehaviorRecommendations('a', 2);
    assert.equal(recs.length, 2);
  });

  it('returns empty array when limit is 0', () => {
    updateTransition('a', 'b');
    assert.deepEqual(getBehaviorRecommendations('a', 0), []);
  });

  it('uses alphabetical tiebreak for equal counts', () => {
    updateTransition('a', 'z');
    updateTransition('a', 'm');
    updateTransition('a', 'b');

    const recs = getBehaviorRecommendations('a', 3);
    // All have count 1; alphabetical: b, m, z
    assert.deepEqual(recs, ['b', 'm', 'z']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// content.js
// ─────────────────────────────────────────────────────────────────────────

describe('content — upsertSongRecords / getSongById', () => {
  beforeEach(() => _clearCatalog());

  it('inserts a song and retrieves it by id', () => {
    upsertSongRecords([{ id: 's1', title: 'Song One', artist: 'Artist A', language: 'hindi', duration_seconds: 200 }]);
    const song = getSongById('s1');
    assert.equal(song.title, 'Song One');
    assert.equal(song.artist, 'Artist A');
  });

  it('returns null for unknown id', () => {
    assert.equal(getSongById('nope'), null);
  });

  it('returns null for empty or null id', () => {
    assert.equal(getSongById(''), null);
    assert.equal(getSongById(null), null);
  });

  it('merges on upsert: non-empty fields overwrite, empty fields do not', () => {
    upsertSongRecords([{ id: 's1', title: 'Original', artist: 'A', language: 'hindi', duration_seconds: 100 }]);
    upsertSongRecords([{ id: 's1', title: 'Updated', artist: '', language: null, duration_seconds: 200 }]);
    const song = getSongById('s1');
    assert.equal(song.title, 'Updated');
    assert.equal(song.artist, 'A');       // not overwritten by empty string
    assert.equal(song.language, 'hindi'); // not overwritten by null
    assert.equal(song.duration_seconds, 200);
  });

  it('silently skips songs with no id', () => {
    upsertSongRecords([{ title: 'No ID' }, null, undefined]);
    assert.equal(getCatalogSize(), 0);
  });

  it('is idempotent: inserting the same song twice does not duplicate', () => {
    const song = { id: 's1', title: 'T', artist: 'A', language: 'en', duration_seconds: 60 };
    upsertSongRecords([song]);
    upsertSongRecords([song]);
    assert.equal(getCatalogSize(), 1);
  });
});

describe('content — getSongsByIds', () => {
  beforeEach(() => _clearCatalog());

  it('returns songs in input order, skipping missing ids', () => {
    upsertSongRecords([
      { id: 'a', title: 'A', artist: 'X', language: 'en', duration_seconds: 60 },
      { id: 'b', title: 'B', artist: 'Y', language: 'en', duration_seconds: 90 },
    ]);
    const songs = getSongsByIds(['b', 'a', 'missing']);
    assert.equal(songs.length, 2);
    assert.equal(songs[0].id, 'b');
    assert.equal(songs[1].id, 'a');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(getSongsByIds([]), []);
  });
});

describe('content — getSimilarSongs', () => {
  beforeEach(() => _clearCatalog());

  it('returns empty array when catalog is empty', () => {
    assert.deepEqual(getSimilarSongs('s1'), []);
  });

  it('returns empty array for unknown song id', () => {
    upsertSongRecords([{ id: 's1', title: 'T', artist: 'A', language: 'en', duration_seconds: 60 }]);
    assert.deepEqual(getSimilarSongs('unknown'), []);
  });

  it('returns empty array for empty or null id', () => {
    assert.deepEqual(getSimilarSongs(''), []);
    assert.deepEqual(getSimilarSongs(null), []);
  });

  it('never includes the seed song in results', () => {
    upsertSongRecords([
      { id: 's1', title: 'T1', artist: 'A', language: 'hindi', duration_seconds: 200 },
      { id: 's2', title: 'T2', artist: 'A', language: 'hindi', duration_seconds: 210 },
      { id: 's3', title: 'T3', artist: 'B', language: 'english', duration_seconds: 180 },
    ]);
    const results = getSimilarSongs('s1');
    assert.ok(!results.includes('s1'));
  });

  it('ranks same-artist songs higher than different-artist songs', () => {
    upsertSongRecords([
      { id: 'seed', title: 'Seed', artist: 'Arijit Singh', language: 'hindi', duration_seconds: 240 },
      { id: 'same_artist', title: 'Same', artist: 'Arijit Singh', language: 'hindi', duration_seconds: 230 },
      { id: 'diff_artist', title: 'Diff', artist: 'Totally Different', language: 'english', duration_seconds: 180 },
    ]);
    const results = getSimilarSongs('seed', 2);
    assert.equal(results[0], 'same_artist');
  });

  it('respects the limit parameter', () => {
    upsertSongRecords([
      { id: 's1', title: 'T1', artist: 'A', language: 'en', duration_seconds: 60 },
      { id: 's2', title: 'T2', artist: 'A', language: 'en', duration_seconds: 70 },
      { id: 's3', title: 'T3', artist: 'A', language: 'en', duration_seconds: 80 },
      { id: 's4', title: 'T4', artist: 'A', language: 'en', duration_seconds: 90 },
    ]);
    const results = getSimilarSongs('s1', 2);
    assert.equal(results.length, 2);
  });

  it('returns empty array when limit is 0', () => {
    upsertSongRecords([{ id: 's1', title: 'T', artist: 'A', language: 'en', duration_seconds: 60 }]);
    assert.deepEqual(getSimilarSongs('s1', 0), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// engine.js
// ─────────────────────────────────────────────────────────────────────────

describe('engine — getRecommendations', () => {
  beforeEach(() => {
    resetTally();
    _clearCatalog();
  });

  it('returns empty lists for unknown song with no history', () => {
    const result = getRecommendations('unknown');
    assert.equal(result.source, 'jiosaavn');
    assert.equal(result.song_id, 'unknown');
    assert.deepEqual(result.behavior_based, []);
    assert.deepEqual(result.content_based, []);
  });

  it('returns empty lists for empty or null id', () => {
    const r1 = getRecommendations('');
    assert.deepEqual(r1.behavior_based, []);
    const r2 = getRecommendations(null);
    assert.deepEqual(r2.behavior_based, []);
  });

  it('behavior_based reflects recorded transitions', () => {
    updateTransition('seed', 'b1');
    updateTransition('seed', 'b1');
    updateTransition('seed', 'b2');

    const result = getRecommendations('seed');
    const behaviorIds = result.behavior_based.map(s => s.song_id);
    assert.ok(behaviorIds.includes('b1'));
    assert.ok(behaviorIds.includes('b2'));
  });

  it('content_based does not overlap with behavior_based', () => {
    // Set up catalog with songs that will appear in both lists
    upsertSongRecords([
      { id: 'seed', title: 'Seed', artist: 'A', language: 'hindi', duration_seconds: 200 },
      { id: 'c1', title: 'C1', artist: 'A', language: 'hindi', duration_seconds: 210 },
      { id: 'c2', title: 'C2', artist: 'A', language: 'hindi', duration_seconds: 220 },
    ]);
    // Record c1 as a behavior result
    updateTransition('seed', 'c1');

    const result = getRecommendations('seed');
    const behaviorIds = new Set(result.behavior_based.map(s => s.song_id));
    const contentIds = result.content_based.map(s => s.song_id);

    for (const id of contentIds) {
      assert.ok(!behaviorIds.has(id), `${id} appears in both behavior and content lists`);
    }
  });

  it('seed song never appears in either list', () => {
    upsertSongRecords([
      { id: 'seed', title: 'Seed', artist: 'A', language: 'hindi', duration_seconds: 200 },
      { id: 'other', title: 'Other', artist: 'A', language: 'hindi', duration_seconds: 210 },
    ]);
    updateTransition('seed', 'other');

    const result = getRecommendations('seed');
    const allIds = [
      ...result.behavior_based.map(s => s.song_id),
      ...result.content_based.map(s => s.song_id),
    ];
    assert.ok(!allIds.includes('seed'));
  });

  it('enriches results with catalog metadata when available', () => {
    upsertSongRecords([
      { id: 'b1', title: 'Behavior Song', artist: 'Artist X', language: 'hindi', duration_seconds: 180 },
    ]);
    updateTransition('seed', 'b1');

    const result = getRecommendations('seed');
    const b1 = result.behavior_based.find(s => s.song_id === 'b1');
    assert.ok(b1);
    assert.equal(b1.title, 'Behavior Song');
    assert.equal(b1.artist, 'Artist X');
  });

  it('returns stub { song_id } for IDs not in catalog', () => {
    updateTransition('seed', 'not_in_catalog');

    const result = getRecommendations('seed');
    const stub = result.behavior_based.find(s => s.song_id === 'not_in_catalog');
    assert.ok(stub);
    assert.equal(Object.keys(stub).length, 1); // only song_id
  });
});

describe('engine — getUpNext', () => {
  beforeEach(() => {
    resetTally();
    _clearCatalog();
  });

  it('returns empty array for empty or null id', () => {
    assert.deepEqual(getUpNext(''), []);
    assert.deepEqual(getUpNext(null), []);
  });

  it('returns empty array when limit is 0', () => {
    updateTransition('seed', 'b1');
    assert.deepEqual(getUpNext('seed', 0), []);
  });

  it('behavior results come before content results', () => {
    upsertSongRecords([
      { id: 'seed', title: 'Seed', artist: 'A', language: 'hindi', duration_seconds: 200 },
      { id: 'content_only', title: 'C', artist: 'A', language: 'hindi', duration_seconds: 210 },
    ]);
    updateTransition('seed', 'behavior_only');

    const tracks = getUpNext('seed', 10);
    const reasons = tracks.map(t => t.reason);
    const firstContent = reasons.indexOf('content');
    const lastBehavior = reasons.lastIndexOf('behavior');

    if (firstContent !== -1 && lastBehavior !== -1) {
      assert.ok(lastBehavior < firstContent, 'All behavior entries should precede content entries');
    }
  });

  it('no duplicate song_ids in the result', () => {
    upsertSongRecords([
      { id: 'seed', title: 'Seed', artist: 'A', language: 'hindi', duration_seconds: 200 },
      { id: 'shared', title: 'Shared', artist: 'A', language: 'hindi', duration_seconds: 210 },
    ]);
    updateTransition('seed', 'shared');

    const tracks = getUpNext('seed', 10);
    const ids = tracks.map(t => t.song_id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size);
  });

  it('seed song never appears in the result', () => {
    upsertSongRecords([
      { id: 'seed', title: 'Seed', artist: 'A', language: 'hindi', duration_seconds: 200 },
      { id: 'other', title: 'Other', artist: 'A', language: 'hindi', duration_seconds: 210 },
    ]);
    updateTransition('seed', 'other');

    const tracks = getUpNext('seed', 10);
    assert.ok(!tracks.some(t => t.song_id === 'seed'));
  });

  it('respects the limit parameter', () => {
    for (let i = 1; i <= 8; i++) {
      updateTransition('seed', `song_${i}`);
    }
    const tracks = getUpNext('seed', 3);
    assert.equal(tracks.length, 3);
  });

  it('each entry has song_id and reason fields', () => {
    updateTransition('seed', 'b1');
    const tracks = getUpNext('seed', 5);
    for (const track of tracks) {
      assert.ok('song_id' in track);
      assert.ok('reason' in track);
      assert.ok(track.reason === 'behavior' || track.reason === 'content');
    }
  });
});
