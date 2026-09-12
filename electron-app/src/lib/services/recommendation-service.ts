// Recommendation service (feature 002 M4.2): typed client for the finalized
// GET /v2/recommendations contract (contracts/recommendations-api.md). The
// capability gate lives in the composition (Home only renders the section
// when the server advertises recommendations.basic.v1); failures never block
// Home. Requests ride the shared origin guards: an origin switch aborts
// in-flight requests and discards their responses; a stale response can
// never replace newer state (per-resource generation captured per request).
import {
  LibraryServiceError,
  libraryFetch,
  serverHasLibraryCapability,
} from './library-service.ts';
import { fetchServerVersion } from '../version-check.ts';
import { backendGeneration } from '../connection-service.ts';

export const RECOMMENDATIONS_CAPABILITY = 'recommendations.basic.v1';

export function serverHasRecommendationsCapability(capabilities: readonly string[] | null | undefined): boolean {
  return serverHasLibraryCapability(capabilities) && Array.isArray(capabilities) && capabilities.includes(RECOMMENDATIONS_CAPABILITY);
}
export type RecommendationItem = {
  canonicalId: string;
  type: 'movie' | 'series' | 'anime';
  title: string;
  year?: number;
  artwork?: { poster?: string };
  reason: { code: 'seed_genre' | 'popular'; text: string; seedCanonicalId?: string };
};

export type RecommendationsData = {
  revision: string;
  fallback: boolean;
  degraded: boolean;
  generatedAt: string;
  items: RecommendationItem[];
};

// fetchRecommendations is a single bounded request (max 20 items server-side).
// Callers own caching/refresh; there is no client-side ranking or filtering.
export async function fetchRecommendations(deps?: { fetchImpl?: typeof fetch }): Promise<RecommendationsData> {
  return libraryFetch<RecommendationsData>('/v2/recommendations', deps);
}

// hasLiveRecommendationsCapability reports whether the CURRENT origin
// advertises the recommendation capability. Discovery is fail-open (a server
// without a version endpoint simply has no recommendation section).
export async function hasLiveRecommendationsCapability(deps?: { fetchImpl?: typeof fetch }): Promise<boolean> {
  const version = await fetchServerVersion(deps);
  return serverHasRecommendationsCapability(version?.capabilities);
}

// assertFresh throws when the response raced an origin switch; callers must
// discard it instead of applying cross-origin state.
export function assertFreshResponse(startedGeneration: number): void {
  if (backendGeneration() !== startedGeneration) {
    throw new LibraryServiceError('origin_changed', 'The server origin changed; the recommendation response was discarded.', 0);
  }
}
