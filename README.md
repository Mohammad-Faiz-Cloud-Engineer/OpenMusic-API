---
title: OpenMusic API
emoji: 🎵
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
---

# OpenMusic API

[![Tests](https://github.com/Mohammad-Faiz-Cloud-Engineer/OpenMusic-API/actions/workflows/test.yml/badge.svg)](https://github.com/Mohammad-Faiz-Cloud-Engineer/OpenMusic-API/actions/workflows/test.yml)

A multi-source music API proxy that scrapes metadata and streams audio from **JioSaavn** and **YouTube Music**. No API keys, no sign-up, no database. Just a JSON API and a built-in browser UI.

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

Runs unit tests for both sources — JioSaavn and YouTube Music normalizers, HTML entity decoding, thumbnail extraction, response shape variants, and decrypt validation.

---

## API Endpoints

### Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server status + active sources |

### JioSaavn `(/jiosaavn/*)`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/jiosaavn/search?q=<query>` | Search songs |
| `GET` | `/jiosaavn/suggestions?q=<query>` | Autocomplete suggestions |
| `GET` | `/jiosaavn/album/:id` | Album details + track list |
| `GET` | `/jiosaavn/playlist/:id` | Playlist details + track list |
| `GET` | `/jiosaavn/charts` | Trending charts |
| `GET` | `/jiosaavn/track/:id` | Get stream URL for a track |
| `GET` | `/jiosaavn/track/:id/play` | **Proxy audio stream** (pipe through server) |

### YouTube Music `(/youtube/*)`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/youtube/search?q=<query>` | Search songs on YouTube Music |
| `GET` | `/youtube/suggestions?q=<query>` | Autocomplete suggestions |
| `GET` | `/youtube/charts` | Charts (returns empty — requires auth) |
| `GET` | `/youtube/track/:id` | Get stream URL for a YTM track |
| `GET` | `/youtube/track/:id?title=<t>&artist=<a>` | Stream URL with metadata hint (skips extra round-trip) |
| `GET` | `/youtube/track/:id/play` | **Proxy audio stream** (pipe through server) |
| `GET` | `/youtube/album/:id` | Returns `501` — YTM albums require auth |
| `GET` | `/youtube/playlist/:id` | Returns `501` — YTM playlists require auth |

> **YouTube Music streams** are resolved via Smart Track Replacement: YTM search results are returned as metadata, but audio is streamed from JioSaavn's CDN. This bypasses YouTube's rotating signature ciphers entirely.

---

## Copy-Paste Examples

### JavaScript (fetch)

```javascript
const BASE = 'https://LocalFind-OpenMusic-API.hf.space';

// ── JioSaavn ──────────────────────────────────────────────────────────────

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
console.log(streamData.stream_url);  // ← actual audio URL

// Play audio in browser (uses server-side proxy)
const audio = new Audio();
audio.src = `${BASE}/jiosaavn/track/0gKfBAgi/play`;
audio.play();

// ── YouTube Music ─────────────────────────────────────────────────────────

// Search songs on YouTube Music
const ytSearchRes = await fetch(`${BASE}/youtube/search?q=tere naal`);
const ytSearchData = await ytSearchRes.json();
console.log(ytSearchData.results);
// [{ id, title, artist, album, duration_seconds, thumbnail, stream_url }, ...]

// Get stream URL for a YTM track (Smart Track Replacement via JioSaavn CDN)
const ytStreamRes = await fetch(`${BASE}/youtube/track/dQw4w9WgXcQ`);
const ytStreamData = await ytStreamRes.json();
console.log(ytStreamData.stream_url);

// Pass title + artist hint to skip the metadata round-trip
const ytStreamFast = await fetch(
  `${BASE}/youtube/track/dQw4w9WgXcQ?title=Never+Gonna+Give+You+Up&artist=Rick+Astley`
);

// Play audio in browser
const ytAudio = new Audio();
ytAudio.src = `${BASE}/youtube/track/dQw4w9WgXcQ/play?title=Never+Gonna+Give+You+Up&artist=Rick+Astley`;
ytAudio.play();
```

### Python (requests)

```python
import requests

BASE = 'https://LocalFind-OpenMusic-API.hf.space'

# JioSaavn
search = requests.get(f'{BASE}/jiosaavn/search', params={'q': 'tere naal'}).json()
print(search['results'][0]['title'])  # first result title

album = requests.get(f'{BASE}/jiosaavn/album/70160165').json()
print(album['title'], album['song_count'], 'tracks')

stream = requests.get(f'{BASE}/jiosaavn/track/0gKfBAgi').json()
print('Stream URL:', stream['stream_url'])

# YouTube Music
yt_search = requests.get(f'{BASE}/youtube/search', params={'q': 'tere naal'}).json()
print(yt_search['results'][0]['title'])

yt_stream = requests.get(
    f'{BASE}/youtube/track/dQw4w9WgXcQ',
    params={'title': 'Never Gonna Give You Up', 'artist': 'Rick Astley'}
).json()
print('YTM Stream URL:', yt_stream['stream_url'])
```

### cURL

```bash
BASE=https://LocalFind-OpenMusic-API.hf.space

# JioSaavn search
curl "$BASE/jiosaavn/search?q=tere%20naal"

# JioSaavn album
curl "$BASE/jiosaavn/album/70160165"

# JioSaavn stream URL
curl "$BASE/jiosaavn/track/0gKfBAgi"

# YouTube Music search
curl "$BASE/youtube/search?q=tere%20naal"

# YouTube Music stream URL (with metadata hint)
curl "$BASE/youtube/track/dQw4w9WgXcQ?title=Tere%20Naal&artist=Dino%20James"
```

---

## Response Shapes

Every endpoint returns JSON. Both sources return the same shape so clients can treat them identically.

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
      "language": "hindi",
      "has_lyrics": true,
      "explicit": false,
      "stream_url": null
    }
  ]
}
```

```json
{
  "source": "youtube",
  "query": "tere naal",
  "results": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Tere Naal",
      "artist": "Dino James",
      "album": "Tere Naal",
      "duration_seconds": 213,
      "thumbnail": "https://lh3.googleusercontent.com/...",
      "language": null,
      "has_lyrics": false,
      "explicit": false,
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
  "stream_url": "https://aac.saavncdn.com/...&Expires=1712345678",
  "expires_at": "2026-05-14T12:00:00.000Z"
}
```

```json
{
  "id": "dQw4w9WgXcQ",
  "source": "youtube",
  "quality": "320kbps",
  "format": "m4a",
  "stream_url": "https://aac.saavncdn.com/...&Expires=1712345678",
  "expires_at": "2026-05-14T12:00:00.000Z"
}
```

> YouTube Music stream URLs are resolved via JioSaavn's CDN (Smart Track Replacement). The `source` field stays `"youtube"` so clients know the original search source.

### Album / Playlist (JioSaavn only)

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

### Charts (JioSaavn only)

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

### Error shapes

```json
{ "error": "missing_query",          "message": "Query parameter \"q\" is required" }
{ "error": "track_not_found",        "source": "jiosaavn", "message": "..." }
{ "error": "source_unavailable",     "source": "youtube",  "message": "..." }
{ "error": "not_implemented",        "source": "youtube",  "message": "YouTube Music album details require authentication and are not supported" }
{ "error": "rate_limited",           "message": "Too many requests. Try again in a minute." }
```

---

## How It Works

```
Browser / App
     │
     ▼
Express  ──── rate limiter (120 req/min/IP)
     │
     ├── /jiosaavn/*  ──► JioSaavn Scraper ──► JioSaavn API
     │                         │
     │                    Normalizer (decodes HTML entities, picks best thumbnail,
     │                    extracts artists, handles all response shapes)
     │                         │
     │                      Cache ──► JSON response
     │
     └── /youtube/*   ──► YouTube Music Scraper ──► YTM internal API (search/suggestions)
                               │
                          Smart Track Replacement:
                          search JioSaavn for the same song,
                          resolve stream via auth token or DES decrypt
                               │
                            Cache ──► JSON response (source: "youtube")
```

- Every request checks an in-memory cache first (per-source, per-endpoint)
- JioSaavn stream URLs carry an `Expires=` param; the cache evicts them 3 minutes early to prevent serving a dying URL
- All string fields (title, artist, album, suggestions) are HTML-entity decoded at the normalizer boundary — clients always receive clean UTF-8
- `/jiosaavn/track/:id/play` and `/youtube/track/:id/play` proxy audio through the server with range request support to bypass CORS and CDN Referer restrictions

### Cache TTLs

| Cache | TTL | Endpoints |
|---|---|---|
| Search / Suggestions | 5 min | `/search`, `/suggestions` |
| Album / Playlist / Charts | 10 min | `/album`, `/playlist`, `/charts` |
| Stream URLs | 25 min (+ early eviction via `expires_at`) | `/track/:id` |

---

## Built-in UI

Open the root URL (`/`) in a browser. There's a dark-themed single-page app for browsing, searching, and playing music without writing any API calls. All vanilla JS, zero frameworks.

---

## Rate Limiting

120 requests per minute per IP. After that:

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

No other config is needed. JioSaavn base URL, DES key, YTM client context, and user agents are all hardcoded with sensible defaults.

---

## Why This Exists

Personal music API proxy. Scrapes what public APIs don't offer. Streams what streaming apps won't give you directly. Use at your own risk; no warranty, no guarantees.

**BSD 2-Clause License.** Do whatever you want, but don't blame me if it breaks.
