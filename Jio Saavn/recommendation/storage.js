/**
 * storage.js — Atomic tally file I/O with thread-safe locking via an async
 * mutex. Mirrors the Python storage.py design exactly:
 *   - Weekly exponential decay (factor 0.5)
 *   - Max 50 songs in history, max 3 transitions per source song
 *   - Atomic writes via a temp-file + rename pattern
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_STORED_SONGS = 50;
const MAX_TRANSITIONS_PER_SONG = 3;
const DECAY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DECAY_FACTOR = 0.5;

const BASE_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const DEFAULT_TALLY_PATH = path.join(DATA_DIR, 'tally_counter.json');

// ── Async mutex ───────────────────────────────────────────────────────────
// A simple promise-chain lock so concurrent requests never race on the file.
//
// Correctness requirements:
//   1. The caller's promise must resolve/reject with fn's result — not swallow errors.
//   2. The lock chain must always advance even when fn throws, so subsequent
//      callers are not permanently blocked.
//
// The previous implementation used `.catch(fn)` which re-invoked fn on error
// instead of propagating the rejection — both wrong behaviours at once.
let _lockChain = Promise.resolve();

function withLock(fn) {
  // Capture the tail of the chain *before* appending so we can chain fn onto
  // it while keeping a separate reference to return to the caller.
  const tail = _lockChain;

  // The promise we return to the caller: waits for the current tail, then
  // runs fn and propagates its result (resolve or reject) to the caller.
  const callerPromise = tail.then(() => fn());

  // Advance the chain: always resolves (never rejects) so later callers are
  // never blocked by an error in this slot.
  _lockChain = callerPromise.then(() => {}, () => {});

  return callerPromise;
}

// ── Path helper ───────────────────────────────────────────────────────────
function getTallyPath() {
  return process.env.OPENMUSIC_TALLY_PATH || DEFAULT_TALLY_PATH;
}

function ensureDataDir() {
  fs.mkdirSync(path.dirname(getTallyPath()), { recursive: true });
}

// Keys that would pollute Object.prototype. Stripped on both write (behavior.js)
// and read (normalizeData below) so a poisoned tally file can't cause harm.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_KEYS.has(key);
}

// ── Default / normalise ───────────────────────────────────────────────────
function defaultTallyData() {
  return {
    _meta: { last_decay_at: new Date().toISOString(), song_order: [] },
    transitions: {},
  };
}

function normalizeData(raw) {
  const out = defaultTallyData();
  if (!raw || typeof raw !== 'object') return out;

  const meta = raw._meta || {};
  if (meta.last_decay_at) out._meta.last_decay_at = meta.last_decay_at;
  if (Array.isArray(meta.song_order)) {
    out._meta.song_order = meta.song_order.map(String).filter(Boolean);
  }

  const transitions = raw.transitions || {};
  for (const [src, targets] of Object.entries(transitions)) {
    if (!src || !isSafeKey(src) || typeof targets !== 'object') continue;
    const normTargets = {};
    for (const [tgt, count] of Object.entries(targets)) {
      if (!isSafeKey(tgt)) continue;
      const n = parseInt(count, 10);
      if (n > 0) normTargets[String(tgt)] = n;
    }
    if (Object.keys(normTargets).length) out.transitions[String(src)] = normTargets;
  }
  return out;
}

// ── Cleanup ───────────────────────────────────────────────────────────────
function cleanupTallyData(data) {
  const meta = data._meta || (data._meta = {});
  const transitions = data.transitions || (data.transitions = {});

  if (!meta.last_decay_at) meta.last_decay_at = new Date().toISOString();

  // Normalise and cap transitions per source
  const cleaned = {};
  for (const [src, targets] of Object.entries(transitions)) {
    if (typeof targets !== 'object') continue;
    const pairs = Object.entries(targets)
      .map(([tgt, c]) => [String(tgt), parseInt(c, 10)])
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TRANSITIONS_PER_SONG);
    if (pairs.length) cleaned[String(src)] = Object.fromEntries(pairs);
  }
  data.transitions = cleaned;

  // Rebuild song_order: keep only songs that still have transitions
  let order = (meta.song_order || []).map(String).filter(id => id in cleaned);
  for (const src of Object.keys(cleaned)) {
    if (!order.includes(src)) order.push(src);
  }

  // Evict oldest songs beyond the cap
  while (order.length > MAX_STORED_SONGS) {
    const evicted = order.shift();
    delete cleaned[evicted];
    for (const targets of Object.values(cleaned)) {
      delete targets[evicted];
    }
    // Remove sources that became empty after eviction
    for (const [src, targets] of Object.entries(cleaned)) {
      if (!Object.keys(targets).length) {
        delete cleaned[src];
        order = order.filter(id => id !== src);
      }
    }
  }

  meta.song_order = order;
  return data;
}

// ── Decay ─────────────────────────────────────────────────────────────────
function applyDecayIfNeeded(data, now = Date.now()) {
  const lastDecay = new Date(data._meta.last_decay_at).getTime();
  if (isNaN(lastDecay)) {
    data._meta.last_decay_at = new Date(now).toISOString();
    return data;
  }

  const intervals = Math.floor((now - lastDecay) / DECAY_INTERVAL_MS);
  if (intervals <= 0) return data;

  const multiplier = Math.pow(DECAY_FACTOR, intervals);
  for (const [src, targets] of Object.entries(data.transitions)) {
    for (const [tgt, count] of Object.entries(targets)) {
      const decayed = Math.floor(count * multiplier);
      if (decayed <= 0) delete targets[tgt];
      else targets[tgt] = decayed;
    }
    if (!Object.keys(targets).length) delete data.transitions[src];
  }

  const newDecayAt = new Date(lastDecay + intervals * DECAY_INTERVAL_MS).toISOString();
  data._meta.last_decay_at = newDecayAt;
  return cleanupTallyData(data);
}

// ── File I/O (unsafe — must be called inside withLock) ───────────────────
function _loadUnsafe() {
  ensureDataDir();
  const p = getTallyPath();
  if (!fs.existsSync(p)) {
    const d = defaultTallyData();
    _saveUnsafe(d);
    return d;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    raw = defaultTallyData();
  }
  return cleanupTallyData(normalizeData(raw));
}

function _saveUnsafe(data) {
  ensureDataDir();
  const p = getTallyPath();
  const dir = path.dirname(p);
  const cleaned = cleanupTallyData(data);
  // Atomic write: write to a temp file then rename
  const tmp = path.join(dir, `.tally_tmp_${process.pid}_${Date.now()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Atomic read-modify-write. `transform` receives the current tally object
 * and must return the (possibly mutated) object to persist.
 */
function loadAndSaveTally(transform) {
  return withLock(() => {
    const data = _loadUnsafe();
    const result = transform(data);
    _saveUnsafe(result);
    return result;
  });
}

function loadTallyData() {
  return withLock(() => _loadUnsafe());
}

function saveTallyData(data) {
  return withLock(() => { _saveUnsafe(data); });
}

module.exports = {
  loadTallyData,
  saveTallyData,
  loadAndSaveTally,
  applyDecayIfNeeded,
  cleanupTallyData,
  defaultTallyData,
};
