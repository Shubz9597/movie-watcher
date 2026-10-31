import assert from "node:assert/strict";
import test from "node:test";

import { OFFLINE_MESSAGE, userMessage } from "../../src/lib/user-error.ts";

test("raw failures become words the viewer can act on", () => {
  // The title page showed this on a phone that couldn't reach the server.
  const unreachable = Object.assign(new Error("catalog backend unreachable: TypeError: Load failed"), { code: "backend_unreachable" });
  assert.equal(userMessage(unreachable, "Couldn’t load this title."), OFFLINE_MESSAGE);
  assert.equal(userMessage("library backend unreachable: TypeError: Failed to fetch", "x"), OFFLINE_MESSAGE);
  assert.equal(userMessage(new TypeError("Load failed"), "x"), OFFLINE_MESSAGE);
  assert.equal(userMessage(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }), "x"), OFFLINE_MESSAGE);
  assert.equal(userMessage(new Error("status 502"), "x"), "Your server had a problem. Try again in a moment.");
  assert.equal(userMessage(new Error("Unexpected token < in JSON at position 0"), "Couldn’t load this title."), "Couldn’t load this title.");
  assert.equal(userMessage(new Error("invalid_client_id"), "Couldn’t load this row."), "Couldn’t load this row.");
  assert.equal(userMessage(null, "Couldn’t load this title."), "Couldn’t load this title.");
});

test("the app's own messages pass through", () => {
  assert.equal(userMessage(new Error("Not enough storage for this download."), "x"), "Not enough storage for this download.");
  assert.equal(userMessage("This collection link is incomplete.", "x"), "This collection link is incomplete.");
  assert.equal(userMessage("Source search timed out. An indexer may be slow or unavailable. Check Prowlarr on your server, then refresh.", "x"),
    "Source search timed out. An indexer may be slow or unavailable. Check Prowlarr on your server, then refresh.");
});
