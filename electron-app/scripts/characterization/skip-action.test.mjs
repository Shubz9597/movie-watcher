import assert from "node:assert/strict";
import test from "node:test";

import { skipActionAt } from "../../src/lib/skip-action.ts";

// Dragon Ball Kai episode 1 as AniSkip reports it (23:07 long).
const kai = [
  { type: "intro", start: 0, end: 89.84 },
  { type: "credits", start: 1295, end: 1387 },
];

test("intro, recap and credits each get a skip button", () => {
  assert.deepEqual(skipActionAt(kai, 30, 1387, true), { label: "Skip intro", target: 90.09 });
  assert.deepEqual(skipActionAt([{ type: "recap", start: 0, end: 60 }], 10, 1400, true), { label: "Skip recap", target: 60.25 });
  assert.equal(skipActionAt(kai, 600, 1387, true), null);
});

test("credits that run to the end move on to the next episode", () => {
  assert.deepEqual(skipActionAt(kai, 1300, 1387, true), { label: "Next episode", target: 1386.5 });
  assert.deepEqual(skipActionAt(kai, 1300, 1387, false), { label: "Skip credits", target: 1386.5 });
});

test("credits followed by more of the episode only skip the credits", () => {
  const postCredits = [{ type: "credits", start: 1200, end: 1290 }];
  assert.deepEqual(skipActionAt(postCredits, 1250, 1400, true), { label: "Skip credits", target: 1290.25 });
});
