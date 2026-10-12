import assert from "node:assert/strict";
import test from "node:test";

import { nextUpEpisode } from "../../src/lib/next-up.ts";

const seasons = [0, 1, 2, 3];
const lengths = { 1: 3, 2: 10, 3: 8 };
const length = (season) => lengths[season] ?? 0;
const mark = (season, episode, watched = true, percent = 100) => ({ season, episode, watched, percent });

test("nothing watched: no next episode", () => {
  assert.equal(nextUpEpisode([], seasons, length), null);
});

test("after a finished season, the next season's first episode", () => {
  assert.deepEqual(nextUpEpisode([mark(1, 1), mark(1, 2), mark(1, 3)], seasons, length), { season: 2, episode: 1, started: false });
});

test("mid-season: the following episode; a started one is continued", () => {
  assert.deepEqual(nextUpEpisode([mark(2, 4)], seasons, length), { season: 2, episode: 5, started: false });
  assert.deepEqual(nextUpEpisode([mark(2, 4), mark(2, 5, false, 40)], seasons, length), { season: 2, episode: 5, started: true });
});

test("specials do not move the show on; the last season's end has no next", () => {
  assert.deepEqual(nextUpEpisode([mark(1, 2), mark(0, 9)], seasons, length), { season: 1, episode: 3, started: false });
  assert.equal(nextUpEpisode([mark(3, 8)], seasons, length), null);
});
