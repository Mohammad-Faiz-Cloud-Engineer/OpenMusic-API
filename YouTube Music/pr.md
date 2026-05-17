# Production Hardening: Security, Concurrency, and Input Validation

## Description

This PR is the result of a full production-readiness audit of the Bitsongs server.
No new features were added. Every change either closes a real vulnerability, fixes
a logic bug, or removes noise that was masking real errors.

### What changed and why

#### Path traversal in `/api/mobile/stream_cache` (Security — Critical)
The original handler passed the `filename` path parameter directly to
`CACHE_DIR / filename` and called `.exists()` on the result. A request like
`GET /api/mobile/stream_cache/../../etc/passwd` would resolve outside the cache
directory and serve arbitrary files from the host filesystem.

A `_safe_cache_path()` guard was added that calls `.resolve()` on the joined path
and then asserts it is still a child of `CACHE_DIR` using
`Path.relative_to()`. Any path that escapes the directory now gets a 403 before
the filesystem is touched.

#### Race condition on tally and catalog files (Concurrency — High)
Both `storage.py` and `content.py` used a read-then-write pattern with no
synchronisation. Under FastAPI's default async worker model, two simultaneous
`/play` requests could both read the same stale tally snapshot, each increment
their own copy, and then the second write would silently overwrite the first —
losing a transition count.

A `threading.Lock` was added to each module (`_tally_lock` in `storage.py`,
`_catalog_lock` in `content.py`). A new `load_and_save_tally()` helper in
`storage.py` performs the full read-modify-write cycle under the lock so callers
never have to acquire it themselves. `behavior.py` was updated to use this helper
for both `update_transition` and `get_behavior_recommendations`.

The catalog lock also protects the mtime-based cache invalidation, which had the
same TOCTOU window.

#### Silent exception swallowing across all external calls (Error Handling — High)
Every `except Exception: pass` or `except Exception: return []` block was
discarding the error without any record of it. Failures against iTunes, lrclib,
and yt-dlp were completely invisible in production.

All catch blocks now call `logger.error(...)` or `logger.warning(...)` with the
exception and relevant context (query, artist_id, song_id). The `logging` module
is used rather than `print()` so log level and destination are controlled by the
deployment environment.

#### Missing input validation on API endpoints (Security / Bugs — High)
Several endpoints accepted empty or whitespace-only parameters and passed them
straight into downstream logic:

- `/api/mobile/play` with an empty `id` would call `update_transition(None, "")`,
  which is a no-op, but then pass an empty string to `render_play_response` which
  would construct a yt-dlp query of `" -  audio"` and make a real network call.
- `/api/mobile/up_next` accepted any integer for `limit`, including negative
  values and arbitrarily large numbers that could trigger unbounded work.
- `/api/mobile/cache_song` accepted a body with missing `id`, `artist`, or
  `title` and would submit a `download_task` with `None` arguments.
- `/api/mobile/lyrics` accepted empty strings and made a live HTTP request.

All endpoints now validate required parameters and return a `400` with a
descriptive message before any downstream work is done. `up_next` clamps `limit`
to `[1, 50]` via the `UP_NEXT_MAX_LIMIT` constant.

#### Error detail leaked to clients in stream proxy (Security — Medium)
`build_proxy_response` returned `f"Stream error: {exc}"` in a 500 response,
which could expose internal paths, library versions, or upstream URLs to callers.
The response body is now the generic string `"Stream error"` and the full
exception is logged server-side. The status code was also corrected from 500
(server fault) to 502 (bad gateway) since the failure is in an upstream
dependency.

Similarly, `render_play_response` returned `f"Song not found: {exc}"` in a 404;
the exception detail is now only in the server log.

#### Hardcoded port 499 in `__main__` block (Config — Low)
The server was hardcoded to bind on port 499, which is an unusual port that
requires elevated privileges on some systems and is not the conventional default
for a development server. Changed to `8000`, which is the standard uvicorn
default. This only affects direct `python app.py` invocations; production
deployments driven by a process manager are unaffected.

#### Missing `.gitignore` (Config — Medium)
There was no `.gitignore` in the repository. The `song_cache/` directory (which
can grow to 600 MB of audio files), `__pycache__/`, `.env*` files, and other
generated/secret artefacts had no protection against accidental commits. A
comprehensive `.gitignore` was added covering Python bytecode, virtual
environments, secrets, the audio cache, pytest artefacts, and OS/IDE noise.

#### `response.raise_for_status()` missing on all outbound HTTP calls (Error Handling — Medium)
`requests.get(...)` does not raise on 4xx/5xx responses by default. A 429 from
iTunes or a 503 from lrclib would be silently treated as a successful empty
result. `raise_for_status()` was added after every external `requests.get` call
so HTTP errors are caught by the surrounding `except Exception` block and logged.

---

## Audit summary

| Area | Finding | Action |
|---|---|---|
| Security | Path traversal in `stream_cache` | Fixed — `_safe_cache_path()` guard added |
| Concurrency | Race condition on tally and catalog writes | Fixed — per-module `threading.Lock` + atomic helper |
| Error Handling | Silent `except: pass` on all external I/O | Fixed — all failures now logged |
| Security | Error detail leaked in proxy/play responses | Fixed — generic message to client, detail in log |
| Input Validation | Missing validation on 5 endpoints | Fixed — 400 returned for missing/invalid params |
| Performance | Unbounded `limit` on `up_next` | Fixed — clamped to `[1, 50]` |
| Config | Hardcoded port 499 | Fixed — changed to 8000 |
| Config | No `.gitignore` | Fixed — created with full pattern set |
| Error Handling | `raise_for_status()` absent on all HTTP calls | Fixed — added to every outbound request |

All 3 existing tests pass without modification.

---

## What was not changed

- The CORS wildcard (`allow_origins=["*"]`) is intentional for a public,
  credential-free mobile API. A comment was added explaining the reasoning and
  the condition under which it must be revisited.
- The recommendation algorithm, data schema, and all business logic are
  unchanged. This PR is purely defensive.
- No new dependencies were introduced.
