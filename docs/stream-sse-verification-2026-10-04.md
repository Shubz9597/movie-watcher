# Stream and SSE verification — 2026-10-04

Live gateway verification passed against backend image
`torwatch-server:git-bc2293ea6616`. Both URLs are configured in the private
operator environment, with `TORWATCH_VERIFY_FIXTURES=1`. The regular update
and rollback verifier now includes these checks. The URLs contain a generated
test torrent; no application credentials are stored in this report.

The optional internal `stream-fixture` service supplies torrent metadata and
a web seed. Requests go through the existing Caddy gateway into the real Go
`/stream` and `/buffer/info` handlers. No public torrent swarm or gateway
fixture route is required.

| Check | Result |
| --- | --- |
| Initial range `0-1023` | 206, 1024 exact fixture bytes |
| Seek range `65536-66559` | 206, 1024 exact bytes, different digest from initial range |
| Suffix range `-512` | 206, 512 exact fixture bytes |
| Out-of-bounds range | 416 with correct file size |
| SSE | 200 `text/event-stream`, two valid data events |
| First SSE data event | 0.001 seconds |
| Next SSE data event | 1.001 seconds after the first |
| Health, readiness, version and published-port audit | Passed |

[Raw live evidence](stream-sse-evidence-2026-10-04.txt).

Seven verifier regression tests passed, including rejection of corrupt bytes,
bad statuses/range headers, compression, closed SSE streams and delayed initial
events. The shell workflow suite passed all 30 checks. Shell syntax and
`git diff --check` passed. No Go code changed in this follow-up.

The fixture is a deterministic 1 MiB byte pattern, not a playable movie.
These are HTTP/torrent transport checks; the earlier FFmpeg integration suites
cover decoding/remux/transcode with playable clips. Content-based filenames
prevent new fixture data from reusing old torrent storage paths. The source
service publishes no host ports, and synthetic source data follows the normal
cache retention policy.

To repeat on this host:

```bash
./deploy/torwatch-server/torwatch.sh verify
```
