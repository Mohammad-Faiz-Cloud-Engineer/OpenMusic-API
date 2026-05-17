'use strict';

/**
 * test_recommendation.js
 *
 * Mirrors YouTube Music/tests/test_recommendation.py exactly, adapted for
 * the JioSaavn Node.js recommendation modules.
 *
 * Differences from the Python suite:
 *  - Env vars: OPENMUSIC_TALLY_PATH / OPENMUSIC_SONGS_PATH
 *  - Content features: artist, language, duration_seconds (no tempo/energy)
 *  - All behavior functions are async
 *  - Test runner: Node built-in `node:test` + `node:assert` (no extra deps)
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a fresh temp directory, point the env vars at it, and reload all
 * four modules so each test starts with a clean slate.
 */
function setupModules() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmusic-test-'));
  process.env.OPENMUSIC_TALLY_PATH = path.join(tmpDir, 'tally_counter.json');
  process.env.OPENMUSIC_SONGS_PATH = path.join(tmpDir, 'songs.json');

  // Bust the require cache so module-level state (cache vars, lock chain) is
  // reset between tests — same technique as Python's importlib.reload().
  const moduleIds = [
    '../recommendation/storage',
    '../recommendation/content',
    '../recommendation/behavior',
    '../recommendation/engine',
  ].map(rel => require.resolve(rel));

  for (const id of moduleIds) delete require.cache[id];

  const storage  = require('../recommendation/storage');
  const content  = require('../recommendation/content');
  const behavior = require('../recommendation/behavior');
  const engine   = require('../recommendation/engine');

  return { tmpDir, storage, content, behavior, engine };
}

function teardownModules(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OPENMUSIC_TALLY_PATH;
  delete process.env.OPENMUSIC_SONGS_PATH;
}

/** Seed the content catalog with four songs spanning two artists/languages. */
function seedCatalog(content) {
  content.upsertSongRecords([
    {
      id: 'song_1',
      title: 'Alpha',
      artist: 'Artist A',
      language: 'hindi',
      duration_seconds: 210,
      thumbnail: '',
      album: 'Album A',
    },
    {
      id: 'song_2',
      title: 'Beta',
      artist: 'Artist A',
      language: 'hindi',
      duration_seconds: 200,
      thumbnail: '',
      album: 'Album A',
    },
    {
      id: 'song_3',
      title: 'Gamma',
      artist: 'Artist B',
      language: 'english',
      duration_seconds: 195,
      thumbnail: '',
      album: 'Album B',
    },
    {
      id: 'song_4',
      title: 'Delta',
      artist: 'Artist C',
      language: 'punjabi',
      duration_seconds: 220,
      thumbnail: '',
      album: 'Album C',
    },
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('updateTransition keeps top-three targets and caps song history at 50', async () => {
  const { tmpDir, storage, behavior } = setupModules();
  try {
    await behavior.updateTransition('song_a', 'song_b');
    await behavior.updateTransition('song_a', 'song_c');
    await behavior.updateTransition('song_a', 'song_d');
    await behavior.updateTransition('song_a', 'song_e'); // 4th target — should be dropped
    await behavior.updateTransition('song_a', 'song_b'); // bump song_b to count=2

    const data = await storage.loadTallyData();
    // Only the top-3 by count should survive: song_b(2), song_c(1), song_d(1)
    assert.deepEqual(
      Object.keys(data.transitions['song_a']),
      ['song_b', 'song_c', 'song_d'],
    );

    // Add 52 distinct source songs to trigger the 50-song eviction
    for (let i = 0; i < 52; i++) {
      await behavior.updateTransition(`source_${i}`, `target_${i}`);
    }

    const capped = await storage.loadTallyData();
    assert.equal(capped._meta.song_order.length, 50);
    assert.ok(!('source_0' in capped.transitions));
  } finally {
    teardownModules(tmpDir);
  }
});

test('decay removes zero-value transitions and halves surviving counts', async () => {
  const { tmpDir, storage, behavior } = setupModules();
  try {
    // Write a tally whose last_decay_at is 7 days in the past
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await storage.saveTallyData({
      _meta: { last_decay_at: sevenDaysAgo, song_order: ['song_a'] },
      transitions: { song_a: { song_b: 10, song_c: 1 } },
    });

    const recommendations = await behavior.getBehaviorRecommendations('song_a');
    // song_c decays to floor(1 * 0.5) = 0 → removed; song_b decays to 5
    assert.deepEqual(recommendations, ['song_b']);

    const data = await storage.loadTallyData();
    assert.equal(data.transitions['song_a']['song_b'], 5);
    assert.ok(!('song_c' in data.transitions['song_a']));
  } finally {
    teardownModules(tmpDir);
  }
});

test('content similarity and getUpNext prioritise behavior-based results', async () => {
  const { tmpDir, content, behavior, engine } = setupModules();
  try {
    seedCatalog(content);

    // song_3 played after song_1 twice; song_2 played after song_1 once
    await behavior.updateTransition('song_1', 'song_3');
    await behavior.updateTransition('song_1', 'song_3');
    await behavior.updateTransition('song_1', 'song_2');

    // Content: song_2 shares artist + language with song_1 → highest similarity
    const similar = content.getSimilarSongs('song_1');
    assert.equal(similar[0], 'song_2');
    assert.ok(!similar.includes('song_1'));

    // Engine: behavior list is [song_3, song_2]; content list must exclude them
    const combined = await engine.getRecommendations('song_1');
    assert.deepEqual(combined.behavior_based, ['song_3', 'song_2']);
    assert.ok(!combined.content_based.includes('song_3'));

    // getUpNext: behavior entries come first, then content fill
    const upNext = await engine.getUpNext('song_1', 3);
    assert.deepEqual(upNext[0], { song_id: 'song_3', reason: 'behavior' });
    assert.deepEqual(upNext[1], { song_id: 'song_2', reason: 'behavior' });
    assert.ok(upNext.every(entry => entry.song_id !== 'song_1'));
  } finally {
    teardownModules(tmpDir);
  }
});
