// Library service boundary (feature 002). M2.2 shipped the PRESENTATION
// boundary with the explicit fixture provider; M3.3 adds the server-backed
// transport for the finalized /v2/library/* contract
// (specs/002-mobile-shared-ui/contracts/library-api.md). NOTHING here falls
// back to localStorage, device-local membership, or direct provider calls:
// a server without the library capability surfaces an explicit unavailable
// state (FR10).
import { buildBackendUrl } from '../api-client.ts';
import { backendGeneration, trackAbort } from '../connection-service.ts';
import { getDeviceId } from '../device-id.ts';
import type { MovieCard } from '../types';

export type LibraryCollection = 'watch-later' | 'favourites';
export type LibraryMediaKind = 'movie' | 'series' | 'anime';
export type LibrarySort = 'recent' | 'title';

export type LibraryShelf = {
  kind: LibraryMediaKind;
  count: number;
  previews: MovieCard[];
};

export type LibraryOverview = {
  shelves: LibraryShelf[];
  /** Truthful source label rendered by consumers, e.g. "Preview data — not synced". */
  sourceLabel: string;
};

export type LibraryCategoryPageData = {
  items: MovieCard[];
  count: number;
  sourceLabel: string;
};

export interface LibraryProvider {
  overview(collection: LibraryCollection): Promise<LibraryOverview>;
  category(collection: LibraryCollection, kind: LibraryMediaKind): Promise<LibraryCategoryPageData>;
}

// --- Server contract (M3.3; contracts/library-api.md) ----------------------

export const LIBRARY_CAPABILITY = 'library.household.v1';

export function serverHasLibraryCapability(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(LIBRARY_CAPABILITY);
}

// One canonical library summary row. canonicalId is the media-qualified
// opaque catalog id ("tmdb:movie:693134", "tmdb:tv:1396", "anilist:154587") —
// it is never parsed, rebuilt, or stripped by the client (M3.1.1 identity).
export type LibraryItemRow = {
  canonicalId: string;
  type: 'movie' | 'series' | 'anime';
  title: string;
  year?: number;
  artwork?: { poster?: string };
  addedAt: string;
  metadataAvailable: boolean;
};

export type LibraryOverviewData = {
  collection: LibraryCollection;
  sort: LibrarySort;
  revision: string;
  shelves: Array<{ kind: LibraryMediaKind; count: number; previews: LibraryItemRow[] }>;
  degraded: boolean;
};

export type LibraryPageData = {
  collection: LibraryCollection;
  kind: LibraryMediaKind | 'all';
  sort: LibrarySort;
  revision: string;
  total: number;
  items: LibraryItemRow[];
  nextCursor?: string;
  degraded: boolean;
};

export type LibraryWriteData = {
  canonicalId: string;
  watchLater: boolean;
  favourite: boolean;
  revision: string;
  updatedAt: string;
};

export class LibraryServiceError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'LibraryServiceError';
    this.code = code;
    this.status = status;
  }
}

type LibraryFetchDeps = { fetchImpl?: typeof fetch };

// libraryFetch is the origin-guarded transport for /v2/library/*: in-flight
// requests are aborted and their responses discarded on an origin switch,
// exactly like the catalog client. The device clientId rides along for
// diagnostics only (never auth, contract §Scope and trust).
export async function libraryFetch<T>(path: string, deps?: LibraryFetchDeps): Promise<T> {
  const doFetch = deps?.fetchImpl ?? fetch.bind(globalThis);
  const startedGeneration = backendGeneration();
  const controller = new AbortController();
  const unregister = deps?.fetchImpl ? undefined : trackAbort(controller);
  let response: Response;
  try {
    response = await doFetch(buildBackendUrl(withClientId(path)), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: deps?.fetchImpl ? undefined : controller.signal,
    });
  } catch (error) {
    if (!deps?.fetchImpl && backendGeneration() !== startedGeneration) {
      throw new LibraryServiceError('origin_changed', 'The server origin changed while this request was in flight.', 0);
    }
    throw new LibraryServiceError('backend_unreachable', `library backend unreachable: ${String(error)}`, 0);
  } finally {
    unregister?.();
  }
  if (backendGeneration() !== startedGeneration) {
    throw new LibraryServiceError('origin_changed', 'The server origin changed while this request was in flight; its response was discarded.', 0);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body = (payload ?? {}) as { error?: { code?: string; message?: string } };
    throw new LibraryServiceError(
      body.error?.code ?? `http_${response.status}`,
      body.error?.message ?? `library request failed with status ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

function withClientId(path: string): string {
  const clientId = getDeviceId();
  if (!clientId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}clientId=${encodeURIComponent(clientId)}`;
}

function encodeId(canonicalId: string): string {
  // The canonical id is percent-encoded ONCE with the ":" separators kept
  // literal (contract §PUT).
  return encodeURIComponent(canonicalId).replace(/%3A/g, ':');
}

export async function fetchLibraryOverview(
  collection: LibraryCollection, sort: LibrarySort, deps?: LibraryFetchDeps,
): Promise<LibraryOverviewData> {
  return libraryFetch<LibraryOverviewData>(
    `/v2/library/overview?collection=${encodeURIComponent(collection)}&sort=${encodeURIComponent(sort)}`, deps);
}

export async function fetchLibraryPage(
  collection: LibraryCollection, kind: LibraryMediaKind | 'all', sort: LibrarySort,
  cursor: string | undefined, limit: number, deps?: LibraryFetchDeps,
): Promise<LibraryPageData> {
  const params = new URLSearchParams({ collection, kind, sort, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return libraryFetch<LibraryPageData>(`/v2/library?${params.toString()}`, deps);
}

export async function putLibraryFlag(
  canonicalId: string, field: LibraryCollection, enabled: boolean, deps?: LibraryFetchDeps,
): Promise<LibraryWriteData> {
  // Contract §PUT: the path segments are /watch-later and /favourite (the
  // latter is singular; the collection query parameter is plural).
  const pathSegment = field === 'favourites' ? 'favourite' : field;
  const doFetch = deps?.fetchImpl ?? fetch.bind(globalThis);
  const startedGeneration = backendGeneration();
  const controller = new AbortController();
  const unregister = deps?.fetchImpl ? undefined : trackAbort(controller);
  let response: Response;
  try {
    response = await doFetch(buildBackendUrl(withClientId(`/v2/library/${encodeId(canonicalId)}/${pathSegment}`)), {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
      signal: deps?.fetchImpl ? undefined : controller.signal,
    });
  } catch (error) {
    if (!deps?.fetchImpl && backendGeneration() !== startedGeneration) {
      throw new LibraryServiceError('origin_changed', 'The server origin changed while this request was in flight.', 0);
    }
    throw new LibraryServiceError('backend_unreachable', `library backend unreachable: ${String(error)}`, 0);
  } finally {
    unregister?.();
  }
  if (backendGeneration() !== startedGeneration) {
    throw new LibraryServiceError('origin_changed', 'The server origin changed while this request was in flight; its response was discarded.', 0);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body = (payload ?? {}) as { error?: { code?: string; message?: string } };
    throw new LibraryServiceError(
      body.error?.code ?? `http_${response.status}`,
      body.error?.message ?? `library write failed with status ${response.status}`,
      response.status,
    );
  }
  return payload as LibraryWriteData;
}

// Per-title reconciliation entry (repair pass): the server-confirmed flags of
// one requested canonical id. Ids the server does not know are OMITTED from
// the response — an omission read at revision R proves absence for clients
// whose per-title state is older than R.
export type LibraryMembershipEntry = {
  canonicalId: string;
  watchLater: boolean;
  favourite: boolean;
};

export type LibraryMembershipsData = {
  revision: string;
  memberships: LibraryMembershipEntry[];
};

// fetchLibraryMemberships asks the server for the confirmed flag state of a
// bounded batch of canonical ids (cross-client removal reconciliation; the
// sync runs it once per poll for locally-known titles).
export async function fetchLibraryMemberships(
  canonicalIds: string[], deps?: LibraryFetchDeps,
): Promise<LibraryMembershipsData> {
  const ids = canonicalIds.map((id) => encodeURIComponent(id)).join(',');
  return libraryFetch<LibraryMembershipsData>(`/v2/library/memberships?ids=${ids}`, deps);
}
