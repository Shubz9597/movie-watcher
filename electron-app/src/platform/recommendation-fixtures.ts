// Recommendation fixture fetch (feature 002 M4.2) — TEST/DEV-ONLY. Serves the
// finalized /v2/recommendations contract shapes deterministically so the REAL
// RecommendationRow / RecommendationsAllPage can be captured and tested in
// every required state. Injected explicitly; no production path imports it.
import type { RecommendationsData } from '../lib/services/recommendation-service';

export type RecommendationFixtureScenario =
  | 'seeded'    // favourite-based reasons
  | 'popular'   // cold start fallback
  | 'degraded'  // server serving its last computed list
  | 'error'     // endpoint failure → Retry
  | 'empty'     // truthful empty
  | 'oldserver';// capability absent → section hidden

const VERSION = {
  serverVersion: 'fixture', protocolVersion: 1, supportedProtocolRange: [1, 1],
  capabilities: ['catalog.bff.v2', 'library.household.v1', 'recommendations.basic.v1'],
};

const items = (fallback: boolean) => [
  {
    canonicalId: 'tmdb:movie:693134', type: 'movie' as const, title: 'Dune: Part Two', year: 2024,
    artwork: { poster: 'https://image.tmdb.org/t/p/w342/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg' },
    reason: fallback
      ? { code: 'popular' as const, text: 'Popular pick' }
      : { code: 'seed_genre' as const, text: 'Because you favourited Blade Runner 2049', seedCanonicalId: 'tmdb:movie:335984' },
  },
  {
    canonicalId: 'tmdb:movie:335984', type: 'movie' as const,
    title: 'A Deliberately Extremely Long Recommendation Title That Wraps Across Two Lines And Keeps Going',
    year: 2017,
    reason: { code: 'popular' as const, text: 'Popular pick' },
  },
  {
    canonicalId: 'tmdb:tv:1396', type: 'series' as const, title: 'Breaking Bad', year: 2008,
    reason: fallback
      ? { code: 'popular' as const, text: 'Popular pick' }
      : { code: 'seed_genre' as const, text: 'Because you favourited Dune: Part Two', seedCanonicalId: 'tmdb:movie:693134' },
  },
  {
    canonicalId: 'anilist:16498', type: 'anime' as const, title: 'Attack on Titan', year: 2013,
    reason: { code: 'popular' as const, text: 'Popular pick' },
  },
];

export function createRecommendationsFixtureFetch(scenario: string): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/v1/version')) {
      if (scenario === 'oldserver') {
        return json({ ...VERSION, capabilities: VERSION.capabilities.filter((c) => c !== 'recommendations.basic.v1') });
      }
      return json(VERSION);
    }
    if (url.includes('/v2/recommendations')) {
      if (scenario === 'error') return json({ error: { code: 'providers_unavailable', message: 'fixture' } }, 503);
      return json(recommendationsFixtureData(scenario));
    }
    return json({ error: { code: 'fixture_unmatched', message: url } }, 404);
  };
}

// recommendationsFixtureData returns the contract payload for a scenario so
// pure-view tests can render exact states without a transport.
export function recommendationsFixtureData(scenario: string): RecommendationsData {
  if (scenario === 'empty') {
    return { revision: '0', fallback: true, degraded: false, generatedAt: '2026-09-10T12:00:00Z', items: [] };
  }
  return {
    revision: '18446744073709551615',
    fallback: scenario === 'popular',
    degraded: scenario === 'degraded',
    generatedAt: '2026-09-10T12:00:00Z',
    items: items(scenario === 'popular'),
  };
}
