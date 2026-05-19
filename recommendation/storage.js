const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_STORED_SONGS = 50;          // LRU eviction cap for transition sources
const MAX_TRANSITIONS_PER_SONG = 3;   // top-N targets kept per source song
const DECAY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const DECAY_FACTOR = 0.5;             // halve counts per interval

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_TALLY_PATH = path.join(DATA_DIR, 'tally_counter.json');

// ── Path resolver (overridable via env for tests) ─────────────────────────
function getTallyPath() {
  return process.env.OPENMUSIC_TALLY_PATH || DEFAULT_TALLY_PATH;
}

// ── Directory bootstrap ───────────────────────────────────────────────────
function ensureDataDir() {
  const dir = path.dirname(getTallyPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Default structure ─────────────────────────────────────────────────────
function defaultTallyData() {
  return {
    _meta: {
      last_decay_at: new Date().toISOString(),
      song_order: [],
    },
    transitions: {},
  };
}

// ── Data normalizer ───────────────────────────────────────────────────────
// Coerces any raw JSON into the canonical tally shape, discarding invalid entries.
function normalizeData(raw) {
  const result = defaultTallyData();

  if (!raw || typeof raw !== 'object') return result;

  const meta = raw._meta;
  if (meta && typeof meta === 'object') {
    if (typeof meta.last_decay_at === 'string' && meta.last_decay_at) {
      result._meta.last_decay_at = meta.last_decay_at;
    }
    if (Array.isArray(meta.song_order)) {
      result._meta.song_order = meta.song_order
        .map(id => String(id))
        .filter(id => id.length > 0);
    }
  }

  const transitions = raw.transitions;
  if (transitions && typeof transitions === 'object') {
    for (const [sourceId, targets] of Object.entries(transitions)) {
      const src = String(sourceId);
      if (!src || typeof targets !== 'object' || targets === null) continue;

      const normalizedTargets = {};
      for (const [targetId, count] of Object.entries(targets)) {
        const tgt = String(targetId);
        const n = parseInt(count, 10);
        if (tgt && !isNaN(n) && n > 0) {
          normalizedTargets[tgt] = n;
        }
      }
      if (Object.keys(normalizedTargets).length > 0) {
        result.transitions[src] = normalizedTargets;
      }
    }
  }

  return result;
}

// ── Load ──────────────────────────────────────────────────────────────────
function loadTallyData() {
  ensureDataDir();
  const tallyPath = getTallyPath();

  if (!fs.existsSync(tallyPath)) {
    const data = defaultTallyData();
    saveTallyData(data);
    return data;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(tallyPath, 'utf8'));
  } catch {
    raw = defaultTallyData();
  }

  return cleanupTallyData(normalizeData(raw));
}

// ── Save (atomic write via temp file + rename) ────────────────────────────
function saveTallyData(data) {
  ensureDataDir();
  const tallyPath = getTallyPath();
  const dir = path.dirname(tallyPath);
  const cleaned = cleanupTallyData(data);

  // Write to a temp file in the same directory, then atomically rename.
  // This prevents partial writes from corrupting the tally on crash.
  const tmpPath = path.join(dir, `.tally_tmp_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, tallyPath);
  } catch (err) {
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ── Decay ─────────────────────────────────────────────────────────────────
// Applies exponential time-decay to all transition counts.
// Each elapsed DECAY_INTERVAL multiplies counts by DECAY_FACTOR.
// Counts that decay to zero are removed. No-ops if < 1 interval has elapsed.
function applyDecayIfNeeded(data, now = Date.now()) {
  const lastDecayAt = new Date(data._meta.last_decay_at).getTime();
  if (isNaN(lastDecayAt)) {
    data._meta.last_decay_at = new Date(now).toISOString();
    return data;
  }

  const elapsed = now - lastDecayAt;
  const intervals = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (intervals <= 0) return data;

  const multiplier = Math.pow(DECAY_FACTOR, intervals);
  const transitions = data.transitions;

  for (const sourceId of Object.keys(transitions)) {
    const targetMap = transitions[sourceId];
    for (const targetId of Object.keys(targetMap)) {
      const decayed = Math.floor(targetMap[targetId] * multiplier);
      if (decayed <= 0) {
        delete targetMap[targetId];
      } else {
        targetMap[targetId] = decayed;
      }
    }
    if (Object.keys(targetMap).length === 0) {
      delete transitions[sourceId];
    }
  }

  // Advance last_decay_at by the number of full intervals elapsed
  const newDecayAt = new Date(lastDecayAt + intervals * DECAY_INTERVAL_MS).toISOString();
  data._meta.last_decay_at = newDecayAt;

  return cleanupTallyData(data);
}

// ── Cleanup ───────────────────────────────────────────────────────────────
// Enforces MAX_TRANSITIONS_PER_SONG, rebuilds song_order, and LRU-evicts
// sources beyond MAX_STORED_SONGS. Mutates and returns the data object.
function cleanupTallyData(data) {
  if (!data._meta) data._meta = {};
  if (!data.transitions) data.transitions = {};

  if (!data._meta.last_decay_at) {
    data._meta.last_decay_at = new Date().toISOString();
  }

  const transitions = data.transitions;

  // Enforce MAX_TRANSITIONS_PER_SONG: keep only the top-N targets per source,
  // sorted by descending count then ascending id for deterministic ordering.
  for (const sourceId of Object.keys(transitions)) {
    const targetMap = transitions[sourceId];
    if (typeof targetMap !== 'object' || targetMap === null) {
      delete transitions[sourceId];
      continue;
    }

    const entries = Object.entries(targetMap)
      .map(([id, count]) => [id, parseInt(count, 10)])
      .filter(([, count]) => !isNaN(count) && count > 0);

    entries.sort(([aId, aCount], [bId, bCount]) => {
      if (bCount !== aCount) return bCount - aCount;
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    });

    const top = entries.slice(0, MAX_TRANSITIONS_PER_SONG);
    if (top.length === 0) {
      delete transitions[sourceId];
    } else {
      transitions[sourceId] = Object.fromEntries(top);
    }
  }

  // Rebuild song_order: keep only IDs that still have transitions,
  // preserving existing order, then append any new sources at the end.
  let songOrder = (data._meta.song_order || [])
    .map(id => String(id))
    .filter(id => id in transitions);

  for (const sourceId of Object.keys(transitions)) {
    if (!songOrder.includes(sourceId)) {
      songOrder.push(sourceId);
    }
  }

  // LRU eviction: remove oldest entries (front of array) until within cap.
  while (songOrder.length > MAX_STORED_SONGS) {
    const evicted = songOrder.shift();
    delete transitions[evicted];

    // Also remove evicted ID from all target maps to keep data consistent.
    for (const sourceId of Object.keys(transitions)) {
      if (evicted in transitions[sourceId]) {
        delete transitions[sourceId][evicted];
        if (Object.keys(transitions[sourceId]).length === 0) {
          delete transitions[sourceId];
          const idx = songOrder.indexOf(sourceId);
          if (idx !== -1) songOrder.splice(idx, 1);
        }
      }
    }
  }

  data._meta.song_order = songOrder;
  return data;
}

module.exports = {
  getTallyPath,
  loadTallyData,
  saveTallyData,
  applyDecayIfNeeded,
  cleanupTallyData,
  defaultTallyData,
  // Constants exported for tests
  MAX_STORED_SONGS,
  MAX_TRANSITIONS_PER_SONG,
  DECAY_INTERVAL_MS,
  DECAY_FACTOR,
};
