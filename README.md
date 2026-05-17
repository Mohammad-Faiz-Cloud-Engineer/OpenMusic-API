---
title: OpenMusic API
emoji: 🎵
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
---

# OpenMusic API

A JioSaavn music API proxy. No API keys, no sign-up, no database. Just a JSON API and a built-in browser UI.

**Base path:** `/jiosaavn/*` — search, stream, and proxy audio from JioSaavn.

---

## Use the hosted API

Already deployed on Hugging Face Spaces:

```
https://LocalFind-OpenMusic-API.hf.space
```

---

## Deploy on Hugging Face (1 click)

1. Go to [huggingface.co/spaces](https://huggingface.co/spaces) and click **Create new Space**
2. Give it a name, set **SDK** to **Docker**
3. Clone the repo and push, or connect your GitHub repo
4. That's it — the API will be live at `https://<your-space>.hf.space`

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
console.log(streamData.stream_url);

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
print(search['results'][0]['title'])

album = requests.get(f'{BASE}/jiosaavn/album/70160165').json()
print(album['title'], album['song_count'], 'tracks')

stream = requests.get(f'{BASE}/jiosaavn/track/0gKfBAgi').json()
print('Stream URL:', stream['stream_url'])
```

### cURL

```bash
BASE=https://LocalFind-OpenMusic-API.hf.space

curl "$BASE/jiosaavn/search?q=tere%20naal"
curl "$BASE/jiosaavn/album/70160165"
curl "$BASE/jiosaavn/track/0gKfBAgi"
```

---

## Response Shapes

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
  "stream_url": "https://aac.saavncdn.com/...&Expires=1712345678",
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

## How It Works

```
Browser / App → Express → Scraper (JioSaavn) → Normalizer → Cache → JSON
```

- Each request checks an in-memory cache first
- On a miss, the scraper fetches from JioSaavn, normalizes the response, caches it, and returns JSON
- Stream URLs are resolved via auth token generation (320kbps → 128kbps fallback), with DES decrypt as a last resort
- `/jiosaavn/track/:id/play` proxies the audio through the server to bypass CORS and Referer restrictions

### Cache TTLs

| Cache | TTL | Endpoints |
|---|---|---|
| Search / Suggestions | 5 min | `/search`, `/suggestions` |
| Album / Playlist / Charts | 10 min | `/album`, `/playlist`, `/charts` |
| Stream URLs | 25 min | `/track/:id` |

---

## Built-in UI

Open the root URL (`/`) in a browser for a dark-themed single-page app to browse, search, and play music. All vanilla JS, zero frameworks.

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

---

## Project Structure

```
src/
  index.js              # Express app entry point
Jio Saavn/
  routes/
    jiosaavn.js         # Route handlers
  scrapers/
    jiosaavn.js         # JioSaavn API scraper
  utils/
    cache.js            # In-memory cache instances
    decrypt.js          # DES stream URL decryption
    normalize.js        # Response normalizers
public/
  index.html            # Built-in browser UI
```

---

**BSD 2-Clause License.** Use at your own risk.
