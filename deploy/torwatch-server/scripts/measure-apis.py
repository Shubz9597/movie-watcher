#!/usr/bin/env python3
"""Measure first-observed/repeat API latency without recording response contents.

Catalog caches may already be warm. This is a smoke measurement, not a load
or concurrent-user capacity test. Torrent discovery is optional and never
resolves or downloads a source. Playback/stream timing uses verify-media.py.
"""
import argparse
import concurrent.futures
import json
import time
import urllib.error
import urllib.request
from pathlib import Path


def endpoints(torrent_search=False):
    paths = [
        ("health", "/healthz"), ("ready", "/readyz"), ("version", "/v1/version"),
        ("continue-section", "/v2/catalog/sections?kind=continue-watching"),
        ("library", "/v2/library?collection=favourites&kind=all&sort=recent"),
        ("library-overview", "/v2/library/overview?collection=favourites"),
        ("memberships", "/v2/library/memberships?ids=tmdb:movie:550"),
        ("recommendations", "/v2/recommendations"),
        ("trending", "/v2/catalog/sections?kind=trending"),
        ("popular", "/v2/catalog/sections?kind=popular"),
        ("movie-genre", "/v2/catalog/sections?kind=popular&type=movie&genre=28"),
        ("anime-genre", "/v2/catalog/sections?kind=popular&type=anime&genre=Action"),
        ("search-movie", "/v2/catalog/search?q=Interstellar&type=movie&limit=24"),
        ("search-anime", "/v2/catalog/search?q=Frieren&type=anime&limit=24"),
        ("movie-detail", "/v2/catalog/titles/tmdb:movie:550"),
        ("tv-detail", "/v2/catalog/titles/tmdb:tv:1399"),
        ("anime-detail", "/v2/catalog/titles/anilist:154587"),
        ("jikan-detail", "/v2/catalog/titles/jikan:52991"),
        ("tv-episodes", "/v2/catalog/titles/tmdb:tv:1399/episodes?season=1"),
        ("anime-episodes", "/v2/catalog/titles/anilist:154587/episodes?season=1"),
        ("imdb-rating", "/v1/imdb/ratings/tt0137523"),
        ("resume-empty", "/v1/resume?subjectId=performance-probe&seriesId=tmdb:tv:1399"),
        ("resume-source-empty", "/v1/resume/source?subjectId=performance-probe&seriesId=tmdb:tv:1399&season=1&episode=1"),
        ("continue-empty", "/v1/continue?subjectId=performance-probe"),
        ("watched-empty", "/v1/watched?subjectId=performance-probe&seriesId=tmdb:tv:1399"),
    ]
    result = [(name, path, None) for name, path in paths]
    if torrent_search:
        result.append(("torrent-search", "/v1/torrents/search", {"kind": "movie", "title": "Interstellar", "year": 2014, "imdbId": "tt0816692"}))
    return result


def measure(base, item, repeats):
    name, path, payload = item
    rows = []
    for attempt in range(1, repeats + 1):
        start = time.monotonic()
        status, body, data, error = None, b"", {}, None
        request = urllib.request.Request(base.rstrip("/") + path)
        if payload is not None:
            request.data = json.dumps(payload).encode()
            request.add_header("Content-Type", "application/json")
        try:
            try:
                response = urllib.request.urlopen(request, timeout=60)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                status = response.status
                body = response.read()
            parsed = json.loads(body)
            data = parsed if isinstance(parsed, dict) else {}
        except Exception as exc:
            error = type(exc).__name__
        nested = data.get("error", {})
        providers = data.get("degradedProviders")
        if providers is None and isinstance(nested, dict):
            providers = nested.get("degradedProviders")
        items = data.get("results", data.get("episodes", data.get("items", [])))
        rows.append({"endpoint": name, "path": path, "attempt": attempt,
                     "seconds": round(time.monotonic() - start, 3), "status": status,
                     "bytes": len(body), "degraded": data.get("degraded"),
                     "providers": providers, "count": len(items) if isinstance(items, list) else None,
                     "error": error})
    print(json.dumps(rows), flush=True)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", default="http://127.0.0.1:8080")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--torrent-search", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error("--repeats must be between 1 and 10")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = pool.map(lambda item: measure(args.gateway, item, args.repeats), endpoints(args.torrent_search))
        rows = [row for result in results for row in result]
    args.output.write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main()
