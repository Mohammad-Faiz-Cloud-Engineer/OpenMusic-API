---
title: OpenMusic API
emoji: "🎵"
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
---

# OpenMusic API

[![Tests](https://github.com/Mohammad-Faiz-Cloud-Engineer/OpenMusic-API/actions/workflows/test.yml/badge.svg)](https://github.com/Mohammad-Faiz-Cloud-Engineer/OpenMusic-API/actions/workflows/test.yml)

A JioSaavn music API proxy that scrapes metadata and streams audio. No API keys, no sign-up, no database. Just a JSON API and a built-in browser UI.

---

## Use the hosted API

Already deployed on Hugging Face Spaces:

```
https://LocalFind-OpenMusic-API.hf.space
```

Replace `https://your-space.hf.space` in all examples below with the URL above, or your own Space URL if you self-host.

---

## Deploy on Hugging Face (1 click)

1. Go to [huggingface.co/spaces](https://huggingface.co/spaces) and click **Create new Space**
2. Give it a name, set **SDK** to **Docker**
3. Clone the repo and push, or connect your GitHub repo
4. That's it. Hugging Face auto-detects Node.js and runs `npm start`

The API will be live at `https://<your-space>.hf.space`.

> **No config needed.** The `PORT` env var is set automatically by Hugging Face.

---

## Deploy locally

```bash
npm install
npm start
```

Opens on `http://localhost:3000`. Hit `/health` to check.

### Tests

```bash
npm test
```

Runs unit tests for the normalizer (JioSaavn response shapes, HTML entities, thumbnails) and decrypt validation.

---

## API Endpoints

### JioSaavn API `(/jiosaavn/*)`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/jiosaavn/search?q=<query>` | Search songs |
| `GET` | `/jiosaavn/suggestions?q=<query>` | Autocomplete suggestions |
| `GET` | `/jiosaavn/album/:id` | Album details + track list |
| `GET` | `/jiosaavn/playlist/:id` | Playlist details + track list |
| `GET` | `/jiosaavn/charts` | Trending charts |
| `GET` | `/jiosaavn/track/:id` | Get stream URL for a track |
| `GET` | `/jiosaavn/track/:id/play` | **Proxy audio stream** (pipe through server) |

---

## Copy-Paste Examples

### JavaScript (fetch)

```javascript
const BASE = 'https://LocalFind-OpenMusic-API.hf.space';

// Search songs
const searchRes = await fetch(`${BASE}/jiosaavn/search?q=tere naal`);
const searchData = await searchRes.json();
console.log(searchData.results);
// [{ id, title, artist, album, duration_seconds, thumbnail, stream_url }, ...]

// Get album details
const albumRes = await fetch(`${BASE}/jiosaavn/album/70160165`);
const albumData = await albumRes.json();
console.log(albumData);
// { id, title, artist, year, song_count, duration_seconds, thumbnail, tracks: [...] }

// Get playlist
const plRes = await fetch(`${BASE}/jiosaavn/playlist/1134543272`);
const plData = await plRes.json();
console.log(plData);

// Trending charts
const chartsRes = await fetch(`${BASE}/jiosaavn/charts`);
const chartsData = await chartsRes.json();
console.log(chartsData.charts);

// Get playable stream URL for a track
const streamRes = await fetch(`${BASE}/jiosaavn/track/0gKfBAgi`);
const streamData = await streamRes.json();
console.log(streamData.stream_url);  // <- this is the actual audio URL

// Play audio in browser (uses server-side proxy)
const audio = new Audio();
audio.src = `${BASE}/jiosaavn/track/0gKfBAgi/play`;
audio.play();
```

### Python (requests)

```python
import requests

BASE = 'https://LocalFind-OpenMusic-API.hf.space'

search = requests.get(f'{BASE}/jiosaavn/search', params={'q': 'tere naal'}).json()
print(search['results'][0]['title'])  # first result title

album = requests.get(f'{BASE}/jiosaavn/album/70160165').json()
print(album['title'], album['song_count'], 'tracks')

stream = requests.get(f'{BASE}/jiosaavn/track/0gKfBAgi').json()
print('Stream URL:', stream['stream_url'])
```

### cURL

```bash
BASE=https://LocalFind-OpenMusic-API.hf.space

# Search
curl "$BASE/jiosaavn/search?q=tere%20naal"

# Album
curl "$BASE/jiosaavn/album/70160165"

# Stream URL
curl "$BASE/jiosaavn/track/0gKfBAgi"
```

---

## Response Shapes

Every endpoint returns JSON. Here's what you get:

### Search results

```json
{
  "source": "jiosaavn",
  "query": "tere naal",
  "results": [
    {
      "id": "0gKfBAgi",
      "title": "Tere Naal",
      "artist": "Dino James, Nikhita Gandhi",
      "album": "Tere Naal",
      "duration_seconds": 213,
      "thumbnail": "https://c.saavncdn.com/738/...-500x500.jpg",
      "stream_url": null
    }
  ]
}
```

### Stream URL

```json
{
  "id": "0gKfBAgi",
  "source": "jiosaavn",
  "quality": "320kbps",
  "format": "m4a",
  "stream_url": "https://aac.saavncdn.com/..._320.mp4?Signature=<sig>&Key-Pair-Id=<key>&Expires=<unix_ts>",
  "expires_at": "2026-12-31T12:00:00.000Z"
}
```

### Album / Playlist

```json
{
  "source": "jiosaavn",
  "id": "70160165",
  "title": "Tere Naal",
  "artist": "Dino James",
  "year": 2023,
  "song_count": 1,
  "duration_seconds": 213,
  "thumbnail": "https://c.saavncdn.com/738/...-500x500.jpg",
  "tracks": [
    {
      "track_number": 1,
      "id": "0gKfBAgi",
      "title": "Tere Naal",
      "artist": "Dino James, Nikhita Gandhi",
      "album": "Tere Naal",
      "duration_seconds": 213,
      "thumbnail": "https://c.saavncdn.com/738/...-500x500.jpg",
      "stream_url": null
    }
  ]
}
```

### Charts

```json
{
  "source": "jiosaavn",
  "charts": [
    {
      "id": "1134543272",
      "title": "Top Hits 2025",
      "description": "50 songs",
      "thumbnail": "https://c.saavncdn.com/...-500x500.jpg"
    }
  ]
}
```

### Suggestions

```json
{
  "source": "jiosaavn",
  "query": "tere",
  "suggestions": ["tere naal", "tere bina", "tere sang yara"]
}
```

---

## Architecture

### System Overview

```
┌──────────┐     ┌─────────────────────────────────────────────────────┐
│ Browser  │────>│                  Express Server                     │
│ / SPA    │     │  src/index.js                                       │
│ (public/)│     │                                                     │
│          │     │  Rate Limiter ─> CORS ─> Static ─> Router ─> JSON   │
└──────────┘     └──────────┬──────────────────────────────────────────┘
                            │
                     ┌──────v──────────────────────────────────────┐
                     │           Jio Saavn Router                  │
                     │         Jio Saavn/routes.js                 │
                     │                                             │
                     │  Cache-aside: lookup ── hit? ──> return     │
                     │                     miss? ──> scrape & cache│
                     └──────┬──────────────────────────────────────┘
                            │
               ┌────────────┼────────────────┐
               v            v                 v
       ┌────────────┐ ┌──────────┐ ┌──────────────┐
       │  Scraper   │ │  Cache   │ │  Normalizer  │
       │ scraper.js │ │ cache.js │ │ normalize.js │
       └──────┬─────┘ └──────────┘ └──────────────┘
              │
       ┌──────v──────┐
       │   Decrypt   │
       │  decrypt.js │
       └─────────────┘
```

### Request Flow (Step by Step)

```
Browser / App
  │
  │  GET /jiosaavn/search?q=tere naal
  v
Express (src/index.js)
  ├── 1. Rate limiter ─────── 429 if >120 req/min
  ├── 2. CORS middleware ──── sets Allow-Origin: *, handles OPTIONS
  ├── 3. Static files ─────── serves public/ (not for /jiosaavn/*)
  └── 4. Route match ──────── /jiosaavn/* → Jio Saavn/routes.js
                               /health       → { status: 'ok' }
                               anything else → 404
                               
Jio Saavn/routes.js
  ├── Validate params (400 if missing)
  ├── Cache lookup ── hit? ──> return cached JSON immediately
  │                  miss? ──> continue
  ├── Call scraper function (Jio Saavn/scraper.js)
  │     ├── callApi('search.getResults', { q, n, p })
  │     │     └── axios GET → www.jiosaavn.com/api.php
  │     │           └── parseResponse() strips __JIO_SAAVN__ prefix
  │     └── normalizeSearch('jiosaavn', data, query)
  │           └── jioSaavnSearchResults() → jioSaavnSong() per item
  ├── Cache the result
  └── Return JSON with ETag / Cache-Control headers
```

### Module Dependency Graph

```
src/index.js
  ├── express
  ├── express-rate-limit
  └── Jio Saavn/routes.js            ← all /jiosaavn/* endpoints
        ├── express (Router)
        ├── axios                     ← for audio proxy stream
        ├── Jio Saavn/scraper.js      ← API calls to JioSaavn
        │     ├── axios               ← HTTP client
        │     ├── Jio Saavn/decrypt.js← DES/ECB decryption fallback
        │     │     └── crypto-js
        │     └── Jio Saavn/normalize.js  ← pure transformations
        ├── Jio Saavn/cache.js        ← in-memory (node-cache)
        └── Jio Saavn/normalize.js    ← trim helper only
```

Each module is single-purpose with no circular dependencies.

### Stream URL Resolution — The Most Complex Path

`GET /jiosaavn/track/:id` goes through a multi-tier resolution strategy:

```
jiosaavn.getStreamUrl(id)
  │
  ├── 1. callApi('song.getDetails', { pids: id })
  │       └── Handles 3 JioSaavn response shapes:
  │             { songs: [...] }, top-level array, or keyed object
  │
  ├── 2. Extract encrypted_media_url from song.more_info
  │
  ├── 3. Try auth token generation (preferred)
  │       └── callApi('song.generateAuthToken', { url, bitrate })
  │             Tries: 320kbps → 160kbps → 128kbps
  │             Success → use auth_url, parse Expires= timestamp
  │             Replace web.saavncdn.com → aac.saavncdn.com
  │
  └── 4. DES decrypt fallback (if all auth attempts fail)
          └── decryptMediaUrl(encUrl)
                └── CryptoJS.DES.decrypt(key: '38346591', ECB, PKCS7)
                      Returns plain CDN URL, upgrade to _320 bitrate
```

The resolution result is cached for 25 minutes. The proxy endpoint (`/track/:id/play`) pipes the CDN stream through the server, forwarding `Range` headers for seek support (206 Partial Content).

### Caching Strategy (Cache-Aside Pattern)

| Cache Store | TTL | Check Period | Endpoints |
|---|---|---|---|
| `searchCache` | 5 min | 60s | `/search`, `/suggestions` |
| `metadataCache` | 10 min | 120s | `/album/:id`, `/playlist/:id`, `/charts` |
| `streamCache` | 25 min | 120s | `/track/:id`, `/track/:id/play` |

Stream cache entries are proactively evicted when the auth token's `expires_at` is within 3 minutes of expiry, ensuring stale URLs are never served.

### Layers

| Layer | Module | Responsibility |
|---|---|---|
| **Transport** | `src/index.js` | HTTP server, middleware chain, graceful shutdown |
| **Routing** | `Jio Saavn/routes.js` | Param validation, cache orchestration, error → HTTP status mapping, audio proxy |
| **Scraper** | `Jio Saavn/scraper.js` | JioSaavn API calls, response parsing, multi-bitrate stream resolution |
| **Normalizer** | `Jio Saavn/normalize.js` | Pure data transformation — raw JioSaavn JSON → consistent shapes, HTML entity decoding, thumbnail extraction |
| **Decrypt** | `Jio Saavn/decrypt.js` | DES/ECB decryption (legacy stream URL fallback) |
| **Cache** | `Jio Saavn/cache.js` | Three isolated node-cache stores with independent TTLs |
| **UI** | `public/index.html` | Vanilla JS SPA — dark theme, search, album/playlist/charts views, audio player |

---

## Built-in UI

Open the root URL (`/`) in a browser. There's a dark-themed single-page app for browsing, searching, and playing music without writing any API calls. All vanilla JS, zero frameworks.

---

## Rate Limiting

120 requests per minute per IP. After that, you get:

```json
{ "error": "rate_limited", "message": "Too many requests. Try again in a minute." }
```

---

## Tech Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js >= 18 |
| Web framework | Express 4 |
| HTTP client | Axios |
| Caching | node-cache (in-memory) |
| Decryption | crypto-js (DES/ECB) |
| Rate limiting | express-rate-limit |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port (Hugging Face sets this to `7860` automatically) |

No other config is needed. Everything (JioSaavn base URL, DES key, user agents) is hardcoded with sensible defaults.

---

## Why This Exists

Personal music API proxy. Scrapes what public APIs don't offer. Streams what streaming apps won't give you directly. Use at your own risk; no warranty, no guarantees.

**BSD 2-Clause License.** Do whatever you want, but don't blame me if it breaks. 
