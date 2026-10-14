import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const { needsSkipLookup, recordSkipLookup } = await import("../../src/lib/offline-skip-segments.ts");

// Dragon Ball Z Kai episode 28: AniSkip has nothing and the server's own
// detection outlasted the first request; the empty answer must not stop
// later lookups (it used to mark the download "looked up" for good).
test("an empty answer is asked again, a few times", () => {
  for (let i = 0; i < 4; i++) {
    recordSkipLookup("ep28");
    assert.equal(needsSkipLookup("ep28"), true, `after ${i + 1} empty answers`);
  }
  recordSkipLookup("ep28");
  assert.equal(needsSkipLookup("ep28"), false, "stops after five");
});

test("a download with intro and credits is not looked up", () => {
  store.set("torwatch_offline_skip_segments_v1", JSON.stringify({
    ep21: [{ type: "intro", start: 25, end: 112, provider: "torwatch" }, { type: "credits", start: 1290, end: 1352, provider: "torwatch" }],
    ep5: [{ type: "credits", start: 1290, end: 1382, provider: "aniskip" }],
  }));
  assert.equal(needsSkipLookup("ep21"), false);
  assert.equal(needsSkipLookup("ep5"), true, "credits without an intro is still incomplete");
});
