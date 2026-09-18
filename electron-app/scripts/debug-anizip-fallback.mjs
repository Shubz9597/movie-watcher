// Simulates the iPhone scenario: api.ani.zip returns a MAPPING WITHOUT
// episode images (what the user saw in Safari), and verifies the service
// still delivers stills via the Kitsu and AniList fallbacks.
import { getAnimeEpisodeMetadata } from '../../electron-app/src/lib/services/anime-episode-metadata-service.ts';

const anilistId = 154587;

let anizipCalls = 0;
let kitsuCalls = 0;
let anilistCalls = 0;

globalThis.fetch = async (url, init) => {
  const target = String(url instanceof URL ? url : url?.url ?? url);
  if (target.startsWith('https://api.ani.zip/mappings')) {
    anizipCalls += 1;
    // Degraded edge-cache response: mappings present, NO episodes, NO images.
    return new Response(JSON.stringify({
      title: 'Frieren: Beyond Journey\'s End',
      mappings: { kitsu_id: 46474, anilist_id: anilistId, mal_id: 52991 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (target.startsWith('https://anime-kitsu.strem.fun/')) {
    kitsuCalls += 1;
    return new Response(JSON.stringify({
      meta: {
        videos: Array.from({ length: 28 }, (_, i) => ({
          episode: i + 1,
          thumbnail: `https://media.kitsu.app/episode/${i + 1}/thumbnail.png`,
        })),
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (target.startsWith('https://graphql.anilist.co')) {
    anilistCalls += 1;
    return new Response(JSON.stringify({ data: { Media: { streamingEpisodes: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fetch: ${target}`);
};

const stills = await getAnimeEpisodeMetadata(anilistId);
console.log(`ani.zip calls: ${anizipCalls} (degraded), kitsu calls: ${kitsuCalls}, anilist calls: ${anilistCalls}`);
console.log(`stills recovered: ${stills.size}`);
console.log('episode 1 still:', stills.get(1)?.stillUrl ?? 'NONE');

// Worst case: ALL sources fail -> empty map, no crash.
let failCalls = 0;
globalThis.fetch = async () => { failCalls += 1; throw new TypeError('Load failed'); };
const none = await getAnimeEpisodeMetadata(154587);
console.log(`all-sources-down: calls=${failCalls}, stills=${none.size} (cache TTL applies)`);
