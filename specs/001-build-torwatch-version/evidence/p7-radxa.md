# P7 Radxa ROCK 3A Measurements (T063)

**Status: PENDING — hardware unavailable.** No Radxa ROCK 3A (or other ARM64 target) is attached to or identifiable from this host, so no measurements were taken. Per the phase rules the **conservative default is kept**: `WATCH_MAX_ACTIVE_TITLES=1` (one guaranteed active distinct-title resource set, SC-006) — the deployment default in `deploy/torwatch-server/.env.example` and `internal/config` (`WATCH_MAX_ACTIVE_TITLES`, default 1).

## To execute when a ROCK 3A 4 GB host is available

Per `docs/v2-server-package/acceptance-tests.md` §8 and quickstart §6:

1. Install the release bundle (`deploy/torwatch-server/`, immutable tag) on the ROCK 3A.
2. 30-minute direct playback + seek session from a LAN client.
3. Record CPU / memory / network at 1-minute intervals (`docker stats`, `/proc/meminfo`); confirm **no OOM termination**.
4. Second distinct title during playback → expect `503 capacity_exceeded` + `retryAfterSeconds` while the first stream continues healthy.
5. If memory headroom is demonstrated across repeated runs, raise `WATCH_MAX_ACTIVE_TITLES` to the measured envelope (never above what a 30-minute dual-title soak proves), re-run step 3–4, and record both configurations here.

No results are claimed in this file until real hardware runs are recorded.
