"""The verifier must reject broken delivery, not just successful HTTP status."""

import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("verify_media", SCRIPTS / "verify-media.py")
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
from verification_fixture import generate, NAME

PAYLOAD = bytes(range(256)) * 512


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/sse"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json" if self.path == "/sse-json" else "text/event-stream")
            self.end_headers()
            try:
                if self.path == "/sse-delay":
                    time.sleep(0.08)
                self.wfile.write(b"retry: 2000\n\n")
                for i in range(1 if self.path == "/sse-close" else 2):
                    event = {"targetBytes": 1024, "contiguousAhead": 1024, "fileLength": len(PAYLOAD)}
                    if self.path == "/sse-invalid":
                        event["targetBytes"] = -1
                    self.wfile.write(b"data: " + json.dumps(event).encode() + b"\n\n")
                    self.wfile.flush()
                    if i == 0:
                        time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        raw = self.headers.get("Range", "bytes=0-1023").removeprefix("bytes=")
        first, last = raw.split("-")
        begin = int(first) if first else len(PAYLOAD) - int(last)
        end = min(int(last), len(PAYLOAD) - 1) if first and last else len(PAYLOAD) - 1
        if begin >= len(PAYLOAD):
            self.send_response(416 if self.path != "/bad-unsatisfiable" else 200)
            self.send_header("Content-Range", f"bytes */{len(PAYLOAD)}")
            self.end_headers()
            return
        body = PAYLOAD[begin:end + 1]
        self.send_response(200 if self.path == "/status" else 206)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", "garbage" if self.path == "/bad-range" else f"bytes {begin}-{end}/{len(PAYLOAD)}")
        self.send_header("Content-Length", str(len(body) + (1 if self.path == "/bad-length" else 0)))
        if self.path == "/gzip":
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        try:
            self.wfile.write(bytes(len(body)) if self.path == "/corrupt" else body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class VerifyMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def test_range_and_suffix(self):
        for wanted in ["bytes=0-1023", "bytes=65536-66559", "bytes=-512"]:
            with self.subTest(range=wanted):
                media.check_range(self.base + "/range", wanted, PAYLOAD)

    def test_rejects_bad_range_responses(self):
        for path in ["status", "bad-range", "bad-length", "corrupt", "gzip"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                media.check_range(self.base + "/" + path, "bytes=0-1023", PAYLOAD)

    def test_unsatisfiable_range(self):
        media.check_unsatisfiable(self.base + "/range", len(PAYLOAD))
        with self.assertRaises(ValueError):
            media.check_unsatisfiable(self.base + "/bad-unsatisfiable", len(PAYLOAD))

    def test_repeated_sse_events(self):
        result = media.check_sse(self.base + "/sse", len(PAYLOAD))
        self.assertEqual(result["events"], 2)

    def test_rejects_invalid_or_closed_sse(self):
        for path in ["sse-json", "sse-close", "sse-invalid"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                media.check_sse(self.base + "/" + path, len(PAYLOAD))

    def test_rejects_buffered_initial_sse(self):
        with self.assertRaisesRegex(ValueError, "first SSE data event delayed"):
            media.check_sse(self.base + "/sse-delay", len(PAYLOAD), initial_limit=0.03)

    def test_fixture_is_stable_and_distinguishes_seek_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            first = generate(directory)
            metadata = Path(directory) / "torwatch-verification.torrent"
            before = metadata.stat().st_mtime_ns
            self.assertEqual(generate(directory), first)
            self.assertEqual(metadata.stat().st_mtime_ns, before)
            payload = (Path(directory) / NAME).read_bytes()
            self.assertNotEqual(payload[:1024], payload[65536:66560])
            stream, sse = media.fixture_urls(self.base, directory)
            self.assertIn("/stream?", stream)
            self.assertIn("/buffer/info?", sse)
            self.assertTrue(sse.endswith("&sse=1"))


if __name__ == "__main__":
    unittest.main()
