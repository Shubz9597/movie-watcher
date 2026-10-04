#!/usr/bin/env python3
"""Generate a small, deterministic torrent for HTTP transport verification."""

import argparse
import hashlib
import os
from pathlib import Path

SIZE = 1 << 20
PIECE_SIZE = 1 << 16
PAYLOAD = b"".join(hashlib.sha256(b"torwatch-verification:" + i.to_bytes(4, "big")).digest()
                   for i in range(SIZE // 32))
# A new payload must never share a torrent storage path with an old fixture.
NAME = "torwatch-verification-" + hashlib.sha256(PAYLOAD).hexdigest()[:12] + ".mp4"


def bencode(value):
    if isinstance(value, int):
        return b"i" + str(value).encode() + b"e"
    if isinstance(value, bytes):
        return str(len(value)).encode() + b":" + value
    if isinstance(value, dict):
        return b"d" + b"".join(bencode(k) + bencode(value[k]) for k in sorted(value)) + b"e"
    raise TypeError(type(value))


def generate(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    # This is known byte-pattern data, not a decodable movie. It tests torrent
    # reads and HTTP delivery; FFmpeg integration has separate playable clips.
    payload = PAYLOAD
    pieces = b"".join(hashlib.sha1(payload[i:i + PIECE_SIZE]).digest()
                      for i in range(0, SIZE, PIECE_SIZE))
    info = {b"length": SIZE, b"name": NAME.encode(), b"piece length": PIECE_SIZE,
            b"pieces": pieces, b"private": 1}
    info_hash = hashlib.sha1(bencode(info)).hexdigest()
    metadata = bencode({b"info": info, b"url-list": b"http://stream-fixture:9090/"})
    for name, content in [(NAME, payload), ("torwatch-verification.torrent", metadata),
                          ("infohash", (info_hash + "\n").encode())]:
        target = root / name
        if target.exists() and target.read_bytes() == content:
            continue
        temporary = root / (name + ".tmp")
        temporary.write_bytes(content)
        temporary.chmod(0o644)
        os.replace(temporary, target)
    return info_hash


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    print(generate(parser.parse_args().root))
