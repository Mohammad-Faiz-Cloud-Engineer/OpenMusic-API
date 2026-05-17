import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import requests
import yt_dlp
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse

from recommendation import (
    get_recommendations as get_song_recommendations,
    get_song_by_id,
    get_songs_by_ids,
    get_up_next,
    update_transition,
    upsert_song_records,
)

logger = logging.getLogger("bitsongs")

app = FastAPI()

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
# Wildcard origin is intentional for a public mobile API that has no
# user-session cookies (allow_credentials=False).  If this server ever gains
# cookie-based auth, replace "*" with an explicit allowlist and set
# allow_credentials=True only for those origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

# OPENMUSIC_CACHE_DIR lets operators point song_cache at a persistent volume.
# In HuggingFace Spaces the container filesystem is ephemeral, so set this
# env var to a path backed by a Space persistent storage mount (e.g. /data).
# Falls back to <app_dir>/song_cache when unset (local dev default).
_cache_dir_env = os.environ.get("OPENMUSIC_CACHE_DIR", "")
CACHE_DIR = Path(_cache_dir_env).resolve() if _cache_dir_env else BASE_DIR / "song_cache"

CACHE_LIMIT_BYTES = 600 * 1024 * 1024

# Maximum number of songs that can be requested in a single up_next call.
UP_NEXT_MAX_LIMIT = 50

DATA_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

executor = ThreadPoolExecutor(max_workers=2)


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Accept-Ranges"] = "bytes"
    return response


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def is_song_cached(song_id):
    return (CACHE_DIR / f"{song_id}.m4a").exists()


def get_cache_size_bytes():
    return sum(entry.stat().st_size for entry in CACHE_DIR.iterdir() if entry.is_file())


def clear_audio_cache():
    for entry in CACHE_DIR.iterdir():
        if entry.is_file():
            try:
                entry.unlink()
            except OSError as exc:
                logger.warning("Could not delete cache file %s: %s", entry, exc)


def clear_cache_if_needed():
    if get_cache_size_bytes() > CACHE_LIMIT_BYTES:
        clear_audio_cache()


def inject_cache_status(songs):
    for song in songs:
        song["cached"] = is_song_cached(song["id"])
    return songs


# ---------------------------------------------------------------------------
# iTunes / data helpers
# ---------------------------------------------------------------------------

def _itunes_to_song(item):
    art_url = item.get("artworkUrl100", "")
    cover = art_url.replace("100x100bb", "200x200bb") if art_url else ""
    cover_xl = art_url.replace("100x100bb", "600x600bb") if art_url else ""
    return {
        "id": str(item.get("trackId", item.get("collectionId", 0))),
        "title": item.get("trackName", "Unknown"),
        "artist": item.get("artistName", "Unknown"),
        "artist_id": item.get("artistId", 0),
        "album": item.get("collectionName", "Single"),
        "cover": cover,
        "cover_xl": cover_xl,
        "duration": item.get("trackTimeMillis", 0) // 1000,
        "genre": item.get("primaryGenreName", "Music"),
    }


def search_songs(query):
    if not query:
        return []
    try:
        response = requests.get(
            "https://itunes.apple.com/search",
            params={"term": query, "media": "music", "limit": 25, "country": "IN"},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        songs = [_itunes_to_song(item) for item in data.get("results", []) if item.get("trackName")]
        upsert_song_records(songs)
        return inject_cache_status(songs)
    except Exception as exc:
        logger.error("search_songs failed for query %r: %s", query, exc)
        return []


def get_chart():
    try:
        response = requests.get(
            "https://itunes.apple.com/in/rss/topsongs/limit=25/json",
            timeout=10,
        )
        response.raise_for_status()
        entries = response.json().get("feed", {}).get("entry", [])
        songs = []
        for entry in entries:
            try:
                art_url = ""
                for img in entry.get("im:image", []):
                    art_url = img.get("label", "")
                cover = art_url.replace("170x170bb", "200x200bb") if art_url else ""
                cover_xl = art_url.replace("170x170bb", "600x600bb") if art_url else ""
                artist_id = 0
                artist_link = entry.get("im:artist", {}).get("attributes", {}).get("href", "")
                if "/id" in artist_link:
                    try:
                        artist_id = int(artist_link.split("/id")[-1].split("?")[0])
                    except (ValueError, IndexError):
                        pass
                track_id = str(entry.get("id", {}).get("attributes", {}).get("im:id", "0") or "0")
                genre = entry.get("category", {}).get("attributes", {}).get("label", "Music")
                songs.append(
                    {
                        "id": track_id,
                        "title": entry.get("im:name", {}).get("label", "Unknown"),
                        "artist": entry.get("im:artist", {}).get("label", "Unknown"),
                        "artist_id": artist_id,
                        "album": entry.get("im:collection", {}).get("im:name", {}).get("label", "Single"),
                        "cover": cover,
                        "cover_xl": cover_xl,
                        "duration": 0,
                        "genre": genre,
                    }
                )
            except Exception as exc:
                logger.warning("Skipping malformed chart entry: %s", exc)
                continue
        upsert_song_records(songs)
        return inject_cache_status(songs)
    except Exception as exc:
        logger.error("get_chart failed: %s", exc)
        return []


def fetch_lyrics(artist, title):
    try:
        resp = requests.get(
            "https://lrclib.net/api/search",
            params={"artist_name": artist, "track_name": title},
            headers={"User-Agent": "Bitsongs/1.0"},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list) and data:
            for item in data:
                if item.get("syncedLyrics"):
                    return {"type": "synced", "text": item["syncedLyrics"]}
            for item in data:
                if item.get("plainLyrics"):
                    return {"type": "plain", "text": item["plainLyrics"]}
        return {"type": "error", "text": "No lyrics found."}
    except Exception as exc:
        logger.error("fetch_lyrics failed for %r / %r: %s", artist, title, exc)
        return {"type": "error", "text": "Lyrics unavailable."}


def fetch_artist_tracks(artist_id, limit=20):
    try:
        artist_id = int(artist_id or 0)
        if artist_id <= 0:
            return []
        response = requests.get(
            "https://itunes.apple.com/lookup",
            params={"id": artist_id, "entity": "song", "limit": limit, "country": "IN"},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        songs = [
            _itunes_to_song(item)
            for item in data.get("results", [])
            if item.get("wrapperType") == "track" and item.get("trackName")
        ]
        if songs:
            upsert_song_records(songs)
        return songs
    except Exception as exc:
        logger.error("fetch_artist_tracks failed for artist_id=%s: %s", artist_id, exc)
        return []


def fetch_artist_search_results(artist_name, limit=25):
    try:
        artist_name = (artist_name or "").strip()
        if not artist_name:
            return []
        response = requests.get(
            "https://itunes.apple.com/search",
            params={"term": artist_name, "media": "music", "entity": "song", "limit": limit, "country": "IN"},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        songs = []
        normalized_artist = artist_name.casefold()
        for item in data.get("results", []):
            item_artist = str(item.get("artistName", "")).strip()
            if not item.get("trackName"):
                continue
            if normalized_artist not in item_artist.casefold() and item_artist.casefold() not in normalized_artist:
                continue
            songs.append(_itunes_to_song(item))
        if songs:
            upsert_song_records(songs)
        return songs
    except Exception as exc:
        logger.error("fetch_artist_search_results failed for %r: %s", artist_name, exc)
        return []


def enrich_catalog_for_song(song_id):
    song = get_song_by_id(song_id)
    if not song:
        return
    fetched_songs = fetch_artist_tracks(song.get("artist_id"))
    if not fetched_songs:
        fetch_artist_search_results(song.get("artist"))


def hydrate_song_ids(song_ids):
    return inject_cache_status(get_songs_by_ids(song_ids))


def build_recommendation_response(song_id):
    enrich_catalog_for_song(song_id)
    grouped_ids = get_song_recommendations(song_id)
    return {
        "behavior_based": hydrate_song_ids(grouped_ids.get("behavior_based", [])),
        "content_based": hydrate_song_ids(grouped_ids.get("content_based", [])),
    }


def build_up_next_response(song_id, limit=10):
    enrich_catalog_for_song(song_id)
    entries = get_up_next(song_id, limit=limit)
    songs_by_id = {song["id"]: song for song in hydrate_song_ids([entry["song_id"] for entry in entries])}
    result = []
    for entry in entries:
        song = songs_by_id.get(entry["song_id"])
        if song:
            item = dict(song)
            item["reason"] = entry["reason"]
            result.append(item)
    return result


def download_task(song_id, artist, title):
    clear_cache_if_needed()
    filepath = CACHE_DIR / f"{song_id}.m4a"
    if filepath.exists():
        return
    query = f"{artist} - {title} audio"
    ydl_opts = {
        "format": "bestaudio[ext=m4a]/best",
        "outtmpl": str(filepath),
        "quiet": True,
        "noplaylist": True,
        "extractor_args": {"youtube": {"client": ["android", "ios"]}},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([f"ytsearch1:{query}"])
        clear_cache_if_needed()
    except Exception as exc:
        logger.error("download_task failed for song_id=%s: %s", song_id, exc)


def build_proxy_response(url: str, incoming_headers, headers_json: str):
    try:
        try:
            yt_headers = json.loads(headers_json or "{}")
        except (json.JSONDecodeError, ValueError):
            yt_headers = {}

        headers = {
            "User-Agent": yt_headers.get("User-Agent", "Mozilla/5.0"),
            "Accept": yt_headers.get("Accept", "*/*"),
            "Accept-Language": yt_headers.get("Accept-Language", "en-us,en;q=0.5"),
            "Sec-Fetch-Mode": yt_headers.get("Sec-Fetch-Mode", "navigate"),
        }
        if "range" in incoming_headers:
            headers["Range"] = incoming_headers["range"]

        req = requests.get(url, stream=True, headers=headers, timeout=30)
        excluded_headers = {"content-encoding", "transfer-encoding", "connection"}
        response_headers = {
            name: value
            for name, value in req.headers.items()
            if name.lower() not in excluded_headers
        }
        response_headers["Accept-Ranges"] = "bytes"
        return StreamingResponse(
            req.iter_content(chunk_size=1024 * 16),
            status_code=req.status_code,
            media_type=req.headers.get("content-type", "audio/mp4"),
            headers=response_headers,
        )
    except Exception as exc:
        logger.error("build_proxy_response failed for url=%r: %s", url, exc)
        return PlainTextResponse("Stream error", status_code=502)


def render_play_response(request: Request, song_id: str, artist: str, title: str):
    filename = f"{song_id}.m4a"
    filepath = CACHE_DIR / filename
    if filepath.exists():
        base_url = str(request.base_url).rstrip("/")
        return JSONResponse({"source": "local", "url": f"{base_url}/api/mobile/stream_cache/{filename}"})

    query = f"{artist} - {title} audio"
    ydl_opts = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "quiet": True,
        "noplaylist": True,
        "extractor_args": {"youtube": {"client": ["android", "ios"]}},
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(f"ytsearch1:{query}", download=False)
            video = info["entries"][0] if "entries" in info else info
            http_headers = video.get("http_headers", {})
            base_url = str(request.base_url).rstrip("/")
            proxy_url = (
                f"{base_url}/api/mobile/stream_proxy"
                f"?url={quote(video['url'])}"
                f"&headers={quote(json.dumps(http_headers))}"
            )
            return JSONResponse(
                {
                    "source": "youtube",
                    "url": proxy_url,
                    "direct_url": video["url"],
                    "headers": http_headers,
                }
            )
        except Exception as exc:
            logger.error("render_play_response failed for song_id=%s: %s", song_id, exc)
            return JSONResponse({"error": "Song not found"}, status_code=404)


# ---------------------------------------------------------------------------
# Path-traversal guard for stream_cache
# ---------------------------------------------------------------------------

def _safe_cache_path(filename: str) -> Path | None:
    """
    Resolve the requested filename inside CACHE_DIR and reject any path that
    escapes the directory (e.g. '../../etc/passwd').
    """
    try:
        resolved = (CACHE_DIR / filename).resolve()
        resolved.relative_to(CACHE_DIR.resolve())
        return resolved
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/")
def root():
    return JSONResponse({"status": "ok", "message": "Bitsongs mobile API"})


@app.get("/api/mobile/search")
def mobile_search(q: str = ""):
    if not q or not q.strip():
        return JSONResponse([])
    return JSONResponse(search_songs(q.strip()))


@app.get("/api/mobile/chart")
def mobile_chart():
    return JSONResponse(get_chart())


@app.get("/api/mobile/recommend")
def mobile_recommend(song_id: str = ""):
    if not song_id or not song_id.strip():
        return JSONResponse({"behavior_based": [], "content_based": []})
    return JSONResponse(build_recommendation_response(song_id.strip()))


@app.get("/api/mobile/up_next")
def mobile_up_next(song_id: str = "", limit: int = 10):
    if not song_id or not song_id.strip():
        return JSONResponse([])
    # Clamp limit to a safe range so a caller cannot request an unbounded list.
    clamped_limit = max(1, min(int(limit or 10), UP_NEXT_MAX_LIMIT))
    return JSONResponse(build_up_next_response(song_id.strip(), limit=clamped_limit))


@app.get("/api/mobile/lyrics")
def mobile_lyrics(artist: str = "", title: str = ""):
    if not artist or not title:
        return JSONResponse({"type": "error", "text": "artist and title are required"}, status_code=400)
    return JSONResponse(fetch_lyrics(artist, title))


@app.get("/api/mobile/play")
def mobile_play(
    request: Request,
    id: str = "",
    artist: str = "",
    title: str = "",
    previous_song_id: str | None = None,
):
    if not id or not id.strip():
        return JSONResponse({"error": "id is required"}, status_code=400)
    if not artist or not title:
        return JSONResponse({"error": "artist and title are required"}, status_code=400)
    update_transition(previous_song_id, id)
    return render_play_response(request, id.strip(), artist, title)


@app.get("/api/mobile/stream_cache/{filename:path}")
def mobile_stream_cache(filename: str):
    filepath = _safe_cache_path(filename)
    if filepath is None:
        return PlainTextResponse("Forbidden", status_code=403)
    if not filepath.exists():
        return PlainTextResponse("Not Found", status_code=404)
    return FileResponse(filepath)


@app.get("/api/mobile/stream_proxy")
def mobile_stream_proxy(request: Request, url: str = "", headers: str = "{}"):
    if not url or not url.strip():
        return PlainTextResponse("url parameter is required", status_code=400)
    return build_proxy_response(url, request.headers, headers)


@app.post("/api/mobile/cache_song")
async def mobile_cache_song(request: Request):
    try:
        data = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    if not data or not isinstance(data, dict):
        return JSONResponse({"error": "No data"}, status_code=400)
    song_id = str(data.get("id") or "").strip()
    artist = str(data.get("artist") or "").strip()
    title = str(data.get("title") or "").strip()
    if not song_id or not artist or not title:
        return JSONResponse({"error": "id, artist, and title are required"}, status_code=400)
    executor.submit(download_task, song_id, artist, title)
    return JSONResponse({"status": "queued"})


@app.get("/api/mobile/health")
def mobile_health():
    return JSONResponse(
        {"status": "ok", "server": "Bitsongs", "version": "2.0", "timestamp": int(time.time())}
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
