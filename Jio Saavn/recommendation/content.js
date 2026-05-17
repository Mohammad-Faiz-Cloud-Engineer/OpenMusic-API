/**
 * content.js — Cosine-similarity content engine.
 *
 * Feature vector per song (mirrors Python content.py):
 *   [ ...artist one-hot, ...language one-hot, normalised_duration ]
 *
 * JioSaavn songs don't carry tempo/energy, so we use language instead of
 * genre (JioSaavn returns language reliably) and duration_seconds instead
 * of tempo. The catalog is populated automatically whenever songs are
 * upserted from search/album/playlist results.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const DEFAULT_CATALOG_PATH = path.join(DATA_DIR, 'songs.json');

// In-process mtime-based cache — avoids re-parsing the file on every request
let _catalogCache     = null;
let _catalogCacheMtime = null;

function getCatalogPath() {
  return process.env.OPENMUSIC_SONGS_PATH || DEFAULT_CATALOG_PATH;
}

function ensureCatalogFile() {
  const p = getCatalogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]\n', 'utf8');
}

// ── Song normaliser ───────────────────────────────────────────────────────
function normalizeSong(song) {
  if (!song || typeof song !== 'object') return null;
  const id = String(song.id || '').trim();
  if (!id) return null;
  return {
    id,
    title:            String(song.title    || 'Unknown'),
    artist:           String(song.artist   || ''),
    album:            String(song.album    || ''),
    language:         String(song.language || ''),
    duration_seconds: parseInt(song.duration_seconds || song.duration || 0, 10) || 0,
    thumbnail:        String(song.thumbnail || ''),
  };
}

// ── Catalog I/O ───────────────────────────────────────────────────────────
function _readCatalog() {
  ensureCatalogFile();
  const p = getCatalogPath();
  let mtime = null;
  try { mtime = fs.statSync(p).mtimeMs; } catch { /* ignore */ }

  if (_catalogCache !== null && _catalogCacheMtime === mtime) {
    return _catalogCache.map(s => ({ ...s }));
  }

  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { raw = []; }
  if (!Array.isArray(raw)) raw = [];

  const catalog = raw.map(normalizeSong).filter(Boolean);
  _catalogCache      = catalog;
  _catalogCacheMtime = mtime;
  return catalog.map(s => ({ ...s }));
}

function _writeCatalog(catalog) {
  ensureCatalogFile();
  const p = getCatalogPath();
  const sorted = [...catalog].sort((a, b) => a.id.localeCompare(b.id));
  const tmp = p + `.tmp_${process.pid}_${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  _catalogCache      = sorted;
  _catalogCacheMtime = fs.statSync(p).mtimeMs;
}

/**
 * Upsert an array of song objects into the catalog.
 * Existing records are merged (non-empty fields win over empty ones).
 * Called automatically by search/album/playlist scrapers.
 */
function upsertSongRecords(songs) {
  if (!Array.isArray(songs) || !songs.length) return;
  const catalog = Object.fromEntries(_readCatalog().map(s => [s.id, s]));
  let changed = false;

  for (const raw of songs) {
    const song = normalizeSong(raw);
    if (!song) continue;
    const existing = catalog[song.id] || {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(song)) {
      if (v !== '' && v !== null && v !== undefined) merged[k] = v;
    }
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      catalog[song.id] = merged;
      changed = true;
    }
  }

  if (changed) _writeCatalog(Object.values(catalog));
}

function getSongById(songId) {
  songId = String(songId || '').trim();
  if (!songId) return null;
  return _readCatalog().find(s => s.id === songId) || null;
}

function getSongsByIds(songIds) {
  const catalog = Object.fromEntries(_readCatalog().map(s => [s.id, s]));
  return songIds.map(id => catalog[String(id)]).filter(Boolean);
}

// ── Feature matrix + cosine similarity ───────────────────────────────────

function _buildFeatureMatrix(catalog) {
  if (!catalog.length) return { matrix: [], catalog: [] };

  const artists   = [...new Set(catalog.map(s => s.artist   || ''))].sort();
  const languages = [...new Set(catalog.map(s => s.language || ''))].sort();
  const artistIdx   = Object.fromEntries(artists.map((a, i) => [a, i]));
  const languageIdx = Object.fromEntries(languages.map((l, i) => [l, i]));

  // Normalise duration to [0, 1]
  const durations = catalog.map(s => s.duration_seconds || 0);
  const durMin = Math.min(...durations);
  const durMax = Math.max(...durations);
  const durRange = durMax - durMin || 1;

  const dim = artists.length + languages.length + 1;
  const matrix = catalog.map(song => {
    const v = new Array(dim).fill(0.0);
    v[artistIdx[song.artist   || '']] = 1.0;
    v[artists.length + languageIdx[song.language || '']] = 1.0;
    v[dim - 1] = ((song.duration_seconds || 0) - durMin) / durRange;
    return v;
  });

  return { matrix, catalog };
}

function _cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Return up to `limit` song IDs most similar to `songId` by cosine
 * similarity on artist, language, and duration features.
 */
function getSimilarSongs(songId, limit = 5) {
  songId = String(songId || '').trim();
  if (!songId) return [];

  const { matrix, catalog } = _buildFeatureMatrix(_readCatalog());
  if (!matrix.length) return [];

  const targetIdx = catalog.findIndex(s => s.id === songId);
  if (targetIdx === -1) return [];

  const target = matrix[targetIdx];
  const ranked = catalog
    .map((song, i) => ({ id: song.id, sim: _cosineSimilarity(matrix[i], target) }))
    .filter(({ id }) => id !== songId)
    .sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map(({ id }) => id);

  return ranked;
}

module.exports = {
  upsertSongRecords,
  getSongById,
  getSongsByIds,
  getSimilarSongs,
};
