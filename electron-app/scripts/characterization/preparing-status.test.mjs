import assert from "node:assert/strict";
import test from "node:test";

import { describePreparing, preparingFraction } from "../../src/lib/preparing-status.ts";

test("describePreparing narrates each server stage", () => {
  assert.equal(describePreparing(undefined), "Preparing");
  assert.equal(describePreparing({ stage: "queued", queuedAhead: 3 }), "Queued · 3 ahead");
  assert.equal(describePreparing({ stage: "metadata" }), "Searching DHT and trackers for peers");
  assert.equal(describePreparing({ stage: "metadata", knownPeers: 40 }), "Connecting · 40 peers found");
  assert.equal(describePreparing({ stage: "metadata", peers: 1 }), "Getting torrent info · 1 peer");
  assert.equal(describePreparing({ stage: "subtitles" }), "Fetching subtitles");
  assert.equal(
    describePreparing({ stage: "downloading", peers: 12, seeders: 5, bytesDone: 250, bytesTotal: 1000, rateBps: 2.5 * 1024 * 1024 }),
    "Server downloading · 25% · 2.5 MB/s · 12 peers (5 seeding)",
  );
  assert.equal(describePreparing({ stage: "downloading", peers: 0, bytesDone: 500, bytesTotal: 1000 }), "Waiting for peers · 50%");
  assert.equal(describePreparing({ stage: "finalizing" }), "Verifying file");
});

test("preparingFraction is only reported while downloading", () => {
  assert.equal(preparingFraction({ stage: "metadata" }), null);
  assert.equal(preparingFraction({ stage: "downloading", bytesDone: 1, bytesTotal: 4 }), 0.25);
});
