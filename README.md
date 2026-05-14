# OpenMusic-API

A lightweight Express server that scrapes music metadata and streams from **JioSaavn** and **YouTube Music**. No database. No authentication. Just a JSON API and a built-in browser UI for testing.

## Quick Start

```bash
npm install
npm start
```

Opens on `http://localhost:3000`. Hit `/health` to check.

## API Endpoints

All endpoints return JSON. Every endpoint accepts a `?source=jiosaavn` or `?source=ytmusic` query param (defaults to `jiosaavn`).

| Endpoint | Description |
|---|---|
| `GET /search?q=<query>` | Search songs |
| `GET /suggestions?q=<query>` | Autocomplete suggestions |
| `GET /album/:id` | Album details + tracks |
| `GET /playlist/:id` | Playlist details + tracks |
| `GET /charts` | Trending charts |
| `GET /track/:id` | Get stream URL for a track |
| `GET /track/:id/play` | Proxy audio stream (JioSaavn only) |

## How It Works

```
Browser -> Express -> Scraper (JioSaavn/YT Music) -> Normalize -> Cache -> JSON
```

- Request hits Express → router validates input → checks in-memory cache → calls scraper → normalizes response → caches it → sends JSON back.
- `/track/:id/play` proxies the actual audio through the server (useful for CORS issues). Only works with JioSaavn — YT Music returns an error.
- Audio stream URLs expire in ~30 min. Cache handles that.

## Scrapers

**JioSaavn** — hits their internal `api.php` endpoint with the right query params. Media URLs come encrypted — gets decrypted with a hardcoded DES key (`38346591`). Falls back to auth token generation if decryption fails.

**YouTube Music** — uses the `ytmusic-api` npm package (ESM-only, imported dynamically). Doesn't support streaming — YT Music links open in YouTube instead.

## Cache (In-Memory)

| Cache | TTL |
|---|---|
| Search / Suggestions | 5 min |
| Album / Playlist / Charts | 10 min |
| Stream URLs | 30 min |

## Config

| Env | Default | What it does |
|---|---|---|
| `PORT` | 3000 | Server port |

Rate limit: 120 req/min. CORS: all origins allowed (`*`).

## Built-in UI

Open `http://localhost:3000` — there's a dark-themed single-page app for browsing/searching/playing music without writing any API calls. All vanilla JS, zero frameworks.

## Tech Stack

**Runtime:** Node.js  
**Framework:** Express 4  
**HTTP:** Axios  
**Caching:** node-cache  
**Decryption:** crypto-js (DES)  
**YT Music:** ytmusic-api  
**Rate limiting:** express-rate-limit

## Why This Exists

Personal music API proxy. Scrapes what public APIs don't offer. Streams what streaming apps won't give you directly. Use at your own risk — no warranty, no guarantees.
