import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BACKEND_ORIGIN,
} from "../../backend-origin.mjs";
import {
  backendGeneration,
  cancelTrackedRequests,
  getBackendOrigin,
  normalizeOrigin,
  setBackendOrigin,
  subscribeOrigin,
  trackAbort,
} from "../../src/lib/connection-service.ts";

test("connection default origin is byte-identical to the V1 launch contract", () => {
  assert.equal(DEFAULT_BACKEND_ORIGIN, "http://localhost:4001");
  assert.equal(getBackendOrigin(), "http://localhost:4001", "no entry called setBackendOrigin in this process");
});

test("normalizeOrigin accepts shorthand and strips trailing slashes, never empty", () => {
  assert.equal(normalizeOrigin("http://radxa.lan:4001/"), "http://radxa.lan:4001");
  assert.equal(normalizeOrigin("  radxa.lan:4001  "), "http://radxa.lan:4001");
  assert.equal(normalizeOrigin(""), DEFAULT_BACKEND_ORIGIN);
  assert.equal(normalizeOrigin("   "), DEFAULT_BACKEND_ORIGIN);
});

test("setBackendOrigin switches, notifies, and preserves the generation order", async () => {
  const events = [];
  const unsubscribe = subscribeOrigin((origin, generation) => events.push({ origin, generation }));
  try {
    const applied = setBackendOrigin("http://192.168.1.50:4001");
    assert.equal(applied, "http://192.168.1.50:4001");
    assert.equal(getBackendOrigin(), "http://192.168.1.50:4001");
    assert.equal(events.length, 1);
    assert.equal(events[0].origin, "http://192.168.1.50:4001");
    // A same-origin switch is a no-op.
    setBackendOrigin("http://192.168.1.50:4001/");
    assert.equal(events.length, 1, "no redundant notification");
  } finally {
    unsubscribe();
    setBackendOrigin(DEFAULT_BACKEND_ORIGIN);
  }
});

test("origin switch aborts tracked in-flight requests and bumps the stale-response generation", async () => {
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener("abort", () => { aborted = true; });
  const unregister = trackAbort(controller);
  const generationAtStart = backendGeneration();

  setBackendOrigin("http://switch-target:4001");
  assert.ok(aborted, "in-flight backend request must be aborted on switch");
  assert.notEqual(backendGeneration(), generationAtStart, "generation bump marks older responses stale");
  unregister();
  setBackendOrigin(DEFAULT_BACKEND_ORIGIN);
});

test("cancelTrackedRequests is safe to call repeatedly", () => {
  cancelTrackedRequests();
  cancelTrackedRequests();
  assert.ok(true, "no throw");
});
