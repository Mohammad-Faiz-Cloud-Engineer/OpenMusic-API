---
title: OpenMusic API
emoji: 🎵
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
---

# OpenMusic API

A two-service music API repo:

| Service | Stack | Folder |
|---|---|---|
| **JioSaavn** | Node.js + Express | `Jio Saavn/` |
| **YouTube Music** | Python + FastAPI | `YouTube Music/` |

Both services are independent — each has its own dependencies, entry point, and can be deployed separately.

---

## JioSaavn Service

Search, stream, and proxy audio from JioSaavn. No API keys required.

### Deploy locally

```bash
npm install
npm start
```

Opens on `http://localhost:3000`. Hit `/health` to check.

### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/jiosaavn/search?q=<query>` | Search songs |
| `GET` | `/jiosaavn/suggestions?q=<query>` | Autocomplete suggestions |
| `GET` | `/jiosaavn/album/:id` | Album details + track list |
| `GET` | `/jiosaavn/playlist/:id` | Playlist details + track list |
| `GET` | `/jiosaavn/charts` | Trending charts |
| `GET` | `/jiosaavn/track/:id` | Get stream URL for a track |
| `GET` | `/jiosaavn/track/:id/play` | **Proxy audio stream** (pipe through server) |

### Examples

```javascript
const BASE = 'https://your-api.hf.space';

// Search
const res = await fetch(`${BASE}/jiosaavn/search?q=tere naal`);
const data = await res.json();
console.log(data.results); // [{ id, title, artist, album, duration_seconds, thumbnail, stream_url }]

// Stream URL
const stream = await fetch(`${BASE}/jiosaavn/track/0gKfBAgi`);
const streamData = await stream.json();
console.log(streamData.stream_url);

// Play audio in browser
const audio = new Audio(`${BASE}/jiosaavn/track/0gKfBAgi/play`);
audio.play();
```

```python
import requests
BASE = 'https://your-api.hf.space'

results = requests.get(f'{BASE}/jiosaavn/search', params={'q': 'tere naal'}).json()
print(results['results'][0]['title'])

stream = requests.get(f'{BASE}/jiosaavn/track/0gKfBAgi').json()
print(stream['stream_url'])
```

### Response Shapes

**Search**
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
      "thumbnail": "https://c.saavncdn.com/...-500x500.jpg",
      "stream_url": null
    }
  ]
}
```

**Stream URL**
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

**Album / Playlist**
```json
{
  "source": "jiosaavn",
  "id": "70160165",
  "title": "Tere Naal",
  "artist": "Dino James",
  "year": 2023,
  "song_count": 1,
  "duration_seconds": 213,
  "thumbnail": "https://c.saavncdn.com/...-500x500.jpg",
  "tracks": [{ "track_number": 1, "id": "0gKfBAgi", "title": "Tere Naal", ... }]
}
```

**Charts**
```json
{
  "source": "jiosaavn",
  "charts": [{ "id": "1134543272", "title": "Top Hits 2025", "description": "50 songs", "thumbnail": "..." }]
}
```

### How It Works

```
Client → Express → Scraper (JioSaavn) → Normalizer → Cache → JSON
```

- In-memory cache checked first on every request
- Stream URLs resolved via auth token (320kbps → 128kbps fallback), DES decrypt as last resort
- `/jiosaavn/track/:id/play` proxies audio through the server to bypass CORS/Referer restrictions

### Cache TTLs

| Cache | TTL | Endpoints |
|---|---|---|
| Search / Suggestions | 5 min | `/search`, `/suggestions` |
| Album / Playlist / Charts | 10 min | `/album`, `/playlist`, `/charts` |
| Stream URLs | 25 min | `/track/:id` |

### Tech Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js >= 18 |
| Framework | Express 4 |
| HTTP client | Axios |
| Caching | node-cache (in-memory) |
| Decryption | crypto-js (DES/ECB) |
| Rate limiting | express-rate-limit |

---

## YouTube Music Service

A FastAPI recommendation and playback service. Uses iTunes Search API for metadata, yt-dlp for audio, and a content + behavior-based recommendation engine.

### Deploy locally

```bash
cd "YouTube Music"
pip install -r requirements.txt
python app.py
```

Opens on `http://localhost:8000`.

### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/mobile/search?q=<query>` | Search songs via iTunes |
| `GET` | `/api/mobile/chart` | Top 25 iTunes India chart |
| `GET` | `/api/mobile/recommend?song_id=<id>` | Behavior + content-based recommendations |
| `GET` | `/api/mobile/up_next?song_id=<id>&limit=<n>` | Ordered up-next queue (max 50) |
| `GET` | `/api/mobile/lyrics?artist=<a>&title=<t>` | Synced/plain lyrics via lrclib |
| `GET` | `/api/mobile/play?id=<id>&artist=<a>&title=<t>` | Resolve playable audio URL via yt-dlp |
| `GET` | `/api/mobile/stream_cache/<filename>` | Serve a locally cached `.m4a` file |
| `GET` | `/api/mobile/stream_proxy?url=<url>` | Proxy an audio stream |
| `POST` | `/api/mobile/cache_song` | Queue a song for background download |
| `GET` | `/api/mobile/health` | Health check |

### Examples

```python
import requests
BASE = 'http://localhost:8000'

# Search
results = requests.get(f'{BASE}/api/mobile/search', params={'q': 'tere naal'}).json()
print(results[0]['title'])

# Get playable URL
play = requests.get(f'{BASE}/api/mobile/play', params={
    'id': '1073359419', 'artist': 'Arijit Singh', 'title': 'Tum Hi Ho'
}).json()
print(play['url'])

# Recommendations
recs = requests.get(f'{BASE}/api/mobile/recommend', params={'song_id': '1073359419'}).json()
print(recs['behavior_based'], recs['content_based'])

# Up next queue
up_next = requests.get(f'{BASE}/api/mobile/up_next', params={'song_id': '1073359419', 'limit': 5}).json()
for item in up_next:
    print(item['title'], '-', item['reason'])
```

### Response Shapes

**Search / Chart** — returns a list of song objects:
```json
[
  {
    "id": "1073359419",
    "title": "Tum Hi Ho",
    "artist": "Mithoon & Arijit Singh",
    "artist_id": 266194090,
    "album": "Aashiqui 2 (Original Motion Picture Soundtrack)",
    "cover": "https://is1-ssl.mzstatic.com/.../200x200bb.jpg",
    "cover_xl": "https://is1-ssl.mzstatic.com/.../600x600bb.jpg",
    "duration": 261,
    "genre": "Bollywood",
    "cached": false
  }
]
```

**Play**
```json
{
  "source": "youtube",
  "url": "http://localhost:8000/api/mobile/stream_proxy?url=...&headers=...",
  "direct_url": "https://rr1---sn-....googlevideo.com/...",
  "headers": { "User-Agent": "..." }
}
```

**Recommendations**
```json
{
  "behavior_based": [{ "id": "...", "title": "...", "cached": false }],
  "content_based":  [{ "id": "...", "title": "...", "cached": false }]
}
```

**Up Next**
```json
[
  { "id": "...", "title": "...", "reason": "behavior" },
  { "id": "...", "title": "...", "reason": "content" }
]
```

### How It Works

```
Client → FastAPI → iTunes (metadata) + yt-dlp (audio) → Recommendation Engine → JSON
```

- **Metadata**: iTunes Search API (`/search`, `/lookup`, RSS feed for charts)
- **Audio**: yt-dlp resolves a YouTube search query to a direct audio URL; optionally downloads and caches as `.m4a`
- **Recommendations**: two-layer engine
  - *Behavior-based*: transition tally (which song played after which), with weekly exponential decay
  - *Content-based*: cosine similarity on artist, genre, tempo, and energy feature vectors
- **Cache**: up to 600 MB of `.m4a` files in `song_cache/`; auto-cleared when limit is exceeded
- **Concurrency**: `threading.Lock` on tally and catalog writes; atomic file writes via `os.replace()`

### Tech Stack

| Layer | Tool |
|---|---|
| Runtime | Python 3.12+ |
| Framework | FastAPI + uvicorn |
| Metadata | iTunes Search API |
| Audio | yt-dlp |
| HTTP client | requests |
| Recommendation | Custom cosine similarity + tally engine |
| Concurrency | threading.Lock + atomic file writes |

---

## Project Structure

```
Jio Saavn/
  routes/
    jiosaavn.js         # Express route handlers
  scrapers/
    jiosaavn.js         # JioSaavn API scraper
  utils/
    cache.js            # In-memory cache instances
    decrypt.js          # DES stream URL decryption
    normalize.js        # Response normalizers

YouTube Music/
  app.py                # FastAPI entry point
  requirements.txt      # Python dependencies
  recommendation/
    __init__.py
    behavior.py         # Transition tally + decay
    content.py          # Cosine similarity engine
    engine.py           # Combined recommendation logic
    storage.py          # Atomic tally file I/O
  data/
    songs.json          # Song catalog (auto-populated)
    tally_counter.json  # Transition tally (auto-populated)
  tests/
    test_recommendation.py

src/
  index.js              # JioSaavn Express app entry point

public/
  index.html            # Built-in browser UI (JioSaavn)
```

---

## Rate Limiting (JioSaavn)

120 requests per minute per IP:

```json
{ "error": "rate_limited", "message": "Too many requests. Try again in a minute." }
```

---

## Environment Variables

### JioSaavn (Node.js)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |

### YouTube Music (Python)

| Variable | Default | Description |
|---|---|---|
| `BITSONGS_SONGS_PATH` | `data/songs.json` | Path to song catalog file |
| `BITSONGS_TALLY_PATH` | `data/tally_counter.json` | Path to tally counter file |

---

**BSD 2-Clause License.** Use at your own risk.
