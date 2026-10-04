#!/usr/bin/env python3
"""Check bounded byte-range delivery and repeated SSE events through a gateway."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from verification_fixture import NAME


def fixture_urls(gateway, root):
    info_hash = (Path(root) / "infohash").read_text().strip()
    magnet = "magnet:?" + urlencode({"xt": "urn:btih:" + info_hash,
                                    "xs": "http://stream-fixture:9090/torwatch-verification.torrent"})
    query = urlencode({"cat": "misc", "magnet": magnet, "fileIndex": "0"})
    return (gateway.rstrip("/") + "/stream?" + query,
            gateway.rstrip("/") + "/buffer/info?" + query + "&sse=1")


def check_range(url, byte_range, expected=None, timeout=30):
    request = Request(url, headers={"Range": byte_range, "Accept-Encoding": "identity"})
    start = time.monotonic()
    with urlopen(request, timeout=timeout) as response:
        if response.status != 206:
            raise ValueError(f"range {byte_range}: status {response.status}, want 206")
        if response.headers.get("Content-Encoding", "identity") != "identity":
            raise ValueError("media was compressed")
        if response.headers.get("Accept-Ranges") != "bytes":
            raise ValueError("media does not advertise byte ranges")
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
        if not match:
            raise ValueError("missing or invalid Content-Range")
        first, last, total = map(int, match.groups())
        if not 0 <= first <= last < total:
            raise ValueError("invalid range bounds")
        wanted = byte_range.removeprefix("bytes=")
        begin, end = wanted.split("-")
        wanted_first = int(begin) if begin else max(0, total - int(end))
        wanted_last = min(int(end), total - 1) if begin and end else total - 1
        if (first, last) != (wanted_first, wanted_last):
            raise ValueError(f"range bounds {(first, last)}, want {(wanted_first, wanted_last)}")
        count = last - first + 1
        if count > 1 << 20:
            raise ValueError("verification response exceeds 1 MiB")
        if response.headers.get("Content-Length") != str(count):
            raise ValueError("Content-Length does not match Content-Range")
        body = response.read(count + 1)
        if len(body) != count:
            raise ValueError(f"range length {len(body)}, want {count}")
        if expected is not None and (total != len(expected) or body != expected[first:last + 1]):
            raise ValueError("range bytes differ from the known fixture")
    result = {"check": "range", "range": byte_range, "status": 206, "bytes": len(body),
              "sha256": hashlib.sha256(body).hexdigest(),
              "seconds": round(time.monotonic() - start, 3)}
    print(json.dumps(result), flush=True)
    return result


def check_unsatisfiable(url, size, timeout=30):
    try:
        with urlopen(Request(url, headers={"Range": f"bytes={size}-"}), timeout=timeout):
            raise ValueError("out-of-bounds range was accepted")
    except HTTPError as error:
        if error.code != 416 or error.headers.get("Content-Range") != f"bytes */{size}":
            raise ValueError("out-of-bounds range did not return 416 and the file size") from error
        error.close()
    print(json.dumps({"check": "unsatisfiable-range", "status": 416}), flush=True)


def check_sse(url, expected_size=None, initial_limit=2, event_timeout=3):
    start = time.monotonic()
    request = Request(url, headers={"Accept": "text/event-stream", "Accept-Encoding": "identity"})
    with urlopen(request, timeout=event_timeout) as response:
        if response.status != 200 or response.headers.get_content_type() != "text/event-stream":
            raise ValueError("SSE did not return 200 text/event-stream")
        if response.headers.get("Content-Encoding", "identity") != "identity":
            raise ValueError("SSE was compressed")
        if response.readline(8193) != b"retry: 2000\n":
            raise ValueError("SSE retry line is missing")
        events = []
        arrivals = []
        for _ in range(32):
            line = response.readline(8193)
            if not line:
                raise ValueError("SSE closed before two data events")
            if len(line) > 8192:
                raise ValueError("SSE line exceeds 8 KiB")
            if line.startswith(b"data: "):
                elapsed = time.monotonic() - start
                event = json.loads(line[6:])
                for field in ["targetBytes", "contiguousAhead"]:
                    if not isinstance(event.get(field), (int, float)) or event[field] < 0:
                        raise ValueError(f"SSE has invalid {field}")
                if expected_size is not None and event.get("fileLength") != expected_size:
                    raise ValueError("SSE is not reporting the fixture file")
                events.append(event)
                arrivals.append(elapsed)
                if len(events) == 1 and elapsed > initial_limit:
                    raise ValueError(f"first SSE data event delayed {elapsed:.3f}s (limit {initial_limit}s)")
                if len(events) == 2:
                    if arrivals[1] - arrivals[0] > event_timeout:
                        raise ValueError("second SSE event was delayed")
                    break
        if len(events) != 2:
            raise ValueError("SSE did not deliver two data events")
    result = {"check": "sse", "status": 200, "events": len(events),
              "firstDataSeconds": round(arrivals[0], 3),
              "nextDataSeconds": round(arrivals[1] - arrivals[0], 3)}
    print(json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stream-url")
    parser.add_argument("--sse-url")
    parser.add_argument("--fixture-root")
    parser.add_argument("--gateway")
    parser.add_argument("--print-urls", action="store_true")
    args = parser.parse_args()
    if args.print_urls:
        if not args.fixture_root or not args.gateway:
            parser.error("--print-urls requires --fixture-root and --gateway")
        print("\n".join(fixture_urls(args.gateway, args.fixture_root)))
        return
    expected = (Path(args.fixture_root) / NAME).read_bytes() if args.fixture_root else None
    if args.stream_url:
        check_range(args.stream_url, "bytes=0-1023", expected)
        if expected is not None:
            check_range(args.stream_url, "bytes=65536-66559", expected)
            check_range(args.stream_url, "bytes=-512", expected)
            check_unsatisfiable(args.stream_url, len(expected))
    if args.sse_url:
        check_sse(args.sse_url, len(expected) if expected is not None else None)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, HTTPError) as error:
        print(f"MEDIA VERIFY FAILED: {error}", file=sys.stderr)
        sys.exit(1)
