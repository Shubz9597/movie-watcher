import assert from "node:assert/strict";
import test from "node:test";

import { nextEpisodeTitleRoute } from "../../src/lib/next-episode-route.ts";

// Dragon Ball Z Kai as the catalog has it: Season 1 has 98 episodes, Season 2 61.
const seasons = {
  1: Array.from({ length: 98 }, (_, index) => ({ episode_number: index + 1, air_date: "2009-04-05" })),
  2: Array.from({ length: 61 }, (_, index) => ({ episode_number: index + 1, air_date: "2014-04-06" })),
};
const fetchSeason = async (_id, season) => {
  if (!seasons[season]) throw new Error("no such season");
  return { episodes: seasons[season] };
};

test("after a downloaded episode: the next episode's sources on the show page", async () => {
  assert.equal(await nextEpisodeTitleRoute("tmdb:tv:61709", 1, 40, fetchSeason),
    "#title?kind=tv&provider=tmdb&mediaKind=tv&id=61709&season=1&episode=41");
});

test("after a season's last episode: the next season's first", async () => {
  assert.equal(await nextEpisodeTitleRoute("tmdb:tv:61709", 1, 98, fetchSeason),
    "#title?kind=tv&provider=tmdb&mediaKind=tv&id=61709&season=2&episode=1");
});

test("no next episode, an unreleased one, offline, or a non-TMDb id: none", async () => {
  assert.equal(await nextEpisodeTitleRoute("tmdb:tv:61709", 2, 61, fetchSeason), null);
  const unreleased = async (_id, season) => ({ episodes: season === 1 ? seasons[1] : [{ episode_number: 1, air_date: "2999-01-01" }] });
  assert.equal(await nextEpisodeTitleRoute("tmdb:tv:61709", 1, 98, unreleased), null);
  assert.equal(await nextEpisodeTitleRoute("tmdb:tv:61709", 1, 98, () => new Promise(() => {}), 20), null);
  assert.equal(await nextEpisodeTitleRoute("anilist:123", 1, 1, fetchSeason), null);
});
