import assert from "node:assert/strict";
import test from "node:test";

const { bannerReduce, INITIAL_BANNER } = await import("../../src/lib/connection-banner.ts");
const run = (events, state = INITIAL_BANNER) => events.reduce((current, event) => bannerReduce(current, event), state);
const status = (value) => ({ type: "status", status: value });

test("a server that goes away: Reconnecting…, then Server offline", () => {
  const away = run([status("ready"), status("unreachable")]);
  assert.equal(away.phase, "reconnecting");
  assert.equal(run([status("unreachable")], away).phase, "offline");
  assert.equal(run([status("unreachable"), status("unreachable")], away).phase, "offline", "background retries do not flash Reconnecting");
});

test("back again: Connected, then the banner slides away", () => {
  const offline = run([status("unreachable"), status("unreachable")]);
  const back = run([status("ready")], offline);
  assert.equal(back.phase, "connected");
  assert.equal(run([{ type: "settled" }], back).phase, "hidden");
});

test("pull to refresh while offline: Reconnecting…, then Connected or Server offline", () => {
  const offline = run([status("unreachable"), status("unreachable")]);
  const pulled = run([{ type: "manual" }], offline);
  assert.equal(pulled.phase, "reconnecting");
  assert.equal(run([status("unreachable")], pulled).phase, "offline");
  assert.equal(run([status("ready")], pulled).phase, "connected");
});

test("nothing shows while all is well", () => {
  assert.equal(run([status("checking"), status("ready")]).phase, "hidden", "launch");
  assert.equal(run([status("ready"), { type: "manual" }, status("ready")]).phase, "hidden", "a pull while connected");
});

test("a new address in Server settings: Reconnecting…, then Connected", () => {
  const offline = run([status("unreachable"), status("unreachable")]);
  const trying = run([status("checking")], offline);
  assert.equal(trying.phase, "reconnecting");
  assert.equal(run([status("ready")], trying).phase, "connected");
});

test("an incompatible server asks for an update, and clears once updated", () => {
  const update = run([status("incompatible")]);
  assert.equal(update.phase, "update");
  assert.equal(run([status("ready")], update).phase, "connected");
});
