---
title: OpenMusic API
emoji: 🎵
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
---

# OpenMusic API

A unified music API that scrapes metadata and streams from **JioSaavn** and **YouTube Music**. No API keys, no sign-up, no database. Just a JSON API and a built-in browser UI.

**Two APIs in one:**
- `/jiosaavn/*` — search, stream, and proxy audio from JioSaavn
- `/ytmusic/*` — search and browse YouTube Music (no streaming, opens YouTube instead)

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

### YouTube Music API `(/ytmusic/*)`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/ytmusic/search?q=<query>` | Search songs |
| `GET` | `/ytmusic/suggestions?q=<query>` | Autocomplete suggestions |
| `GET` | `/ytmusic/album/:id` | Album details + track list |
| `GET` | `/ytmusic/playlist/:id` | Playlist details + track list |
| `GET` | `/ytmusic/charts` | Trending music |
| `GET` | `/ytmusic/track/:id` | Get track metadata (no stream URL — opens YouTube) |

> **Note:** YouTube Music doesn't give out direct audio URLs. The `/track/:id` endpoint returns metadata only. Use the `videoId` to open `https://www.youtube.com/watch?v=<videoId>`.

---

## Copy-Paste Examples

### JavaScript (fetch)

```javascript
const BASE = 'https://LocalFind-OpenMusic-API.hf.space';

// ── JioSaavn ──────────────────────────────────────────────────

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
console.log(streamData.stream_url);  // ← this is the actual audio URL

// Play audio in browser (uses server-side proxy)
const audio = new Audio();
audio.src = `${BASE}/jiosaavn/track/0gKfBAgi/play`;
audio.play();


// ── YouTube Music ──────────────────────────────────────────────

// Search songs
const ytSearch = await fetch(`${BASE}/ytmusic/search?q=tere naal`);
const ytData = await ytSearch.json();
console.log(ytData.results);

// Get album
const ytAlbum = await fetch(`${BASE}/ytmusic/album/MPREb_DHWbS7Con8q`);
const ytAlbumData = await ytAlbum.json();
console.log(ytAlbumData);

// Get playlist
const ytPl = await fetch(`${BASE}/ytmusic/playlist/PL...`);
const ytPlData = await ytPl.json();
console.log(ytPlData);

// Track metadata (no stream URL — open in YouTube)
const ytTrack = await fetch(`${BASE}/ytmusic/track/dQw4w9WgXcQ`);
const ytTrackData = await ytTrack.json();
console.log(ytTrackData);
// Open: https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

### Python (requests)

```python
import requests

BASE = 'https://LocalFind-OpenMusic-API.hf.space'

# ── JioSaavn ──
search = requests.get(f'{BASE}/jiosaavn/search', params={'q': 'tere naal'}).json()
print(search['results'][0]['title'])  # first result title

album = requests.get(f'{BASE}/jiosaavn/album/70160165').json()
print(album['title'], album['song_count'], 'tracks')

stream = requests.get(f'{BASE}/jiosaavn/track/0gKfBAgi').json()
print('Stream URL:', stream['stream_url'])

# ── YouTube Music ──
yt = requests.get(f'{BASE}/ytmusic/search', params={'q': 'tere naal'}).json()
print(yt['results'][0]['title'])
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
curl "$BASE/ytmusic/search?q=tere%20naal"

# YouTube Music album
curl "$BASE/ytmusic/album/MPREb_DHWbS7Con8q"
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

### Stream URL (JioSaavn only)

```json
{
  "id": "0gKfBAgi",
  "source": "jiosaavn",
  "quality": "320kbps",
  "format": "m4a",
  "stream_url": "https://...(!@# auth token...)&Expires=1712345678",
  "expires_at": "2026-05-14T12:00:00.000Z"
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

### Charts (JioSaavn)

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

## How It Works

```
Browser / App → Express → Scraper (JioSaavn / YT Music) → Normalizer → Cache → JSON
```

- Routes are split by source: `/jiosaavn/*` and `/ytmusic/*`
- Each request checks an in-memory cache first
- If missed, the scraper fetches from the source API, normalizes the response, caches it, and returns JSON
- JioSaavn stream URLs are decrypted with a hardcoded DES key, or fetched via auth token generation
- `/jiosaavn/track/:id/play` proxies the audio through the server to bypass CORS and Referer restrictions

### Cache TTLs

| Cache | TTL | Endpoints |
|---|---|---|
| Search / Suggestions | 5 min | `/search`, `/suggestions` |
| Album / Playlist / Charts | 10 min | `/album`, `/playlist`, `/charts` |
| Stream URLs | 25 min | `/track/:id` |

---

## Built-in UI

Open the root URL (`/`) in a browser — there's a dark-themed single-page app for browsing, searching, and playing music without writing any API calls. All vanilla JS, zero frameworks.

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
| YT Music | ytmusic-api (ESM, dynamically imported) |
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

Personal music API proxy. Scrapes what public APIs don't offer. Streams what streaming apps won't give you directly. Use at your own risk — no warranty, no guarantees.

**BSD 2-Clause License.** Do whatever you want, but don't blame me if it breaks.
