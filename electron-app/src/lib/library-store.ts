// LibraryStore (feature 002 M3.3): the framework-free state owner for the
// server-backed household library. One instance per composition root.
//
// Contract rules implemented here (contracts/library-api.md, plan.md):
//   - Capability gate: availability is 'available' ONLY when the server
//     advertises library.household.v1. Missing capability / unreachable
//     server surface an explicit unavailable state — never a local fallback
//     (no localStorage, no device-local membership, no provider calls).
//   - Revisions are lossless decimal strings compared per resource with
//     BigInt; one resource's revision never suppresses another's response.
//   - Same-title writes serialize per title/field; no offline queue exists.
//   - Successful writes reconcile from the complete server response (BOTH
//     flags + revision) and invalidate the affected Library resources.
//   - Late/stale responses (older revision or superseded request) can never
//     undo newer confirmed state.
//   - An origin switch clears every origin-scoped cache and membership and
//     re-checks the capability on the new origin.
import {
  LibraryServiceError,
  fetchLibraryMemberships,
  fetchLibraryOverview,
  fetchLibraryPage,
  putLibraryFlag,
  serverHasLibraryCapability,
  type LibraryCollection,
  type LibraryItemRow,
  type LibraryMediaKind,
  type LibrarySort,
} from './services/library-service.ts';
import { fetchServerVersion } from './version-check.ts';
import { buildBackendUrl } from './api-client.ts';
import { assertCurrentGeneration, backendGeneration, subscribeOrigin } from './connection-service.ts';

export type LibraryAvailability = 'checking' | 'available' | 'unavailable' | 'unreachable';

export type LibraryOverviewState = {
  status: 'loading' | 'ready' | 'error';
  shelves: Array<{ kind: LibraryMediaKind; count: number; previews: LibraryItemRow[] }>;
  revision: string;
  error: string | null;
  /** True when the displayed data is a previously-loaded snapshot that could
      not be refreshed (offline / unreachable) — consumers must label it. */
  stale?: boolean;
};

export type LibraryPageState = {
  status: 'loading' | 'ready' | 'error';
  items: LibraryItemRow[];
  total: number;
  revision: string;
  cursor: string | null;
  loadingMore: boolean;
  error: string | null;
  /** See LibraryOverviewState.stale. */
  stale?: boolean;
};

export type LibraryMembership = { watchLater: boolean; favourite: boolean; revision?: string };

export type LibrarySnapshot = {
  availability: LibraryAvailability;
  overviews: Record<string, LibraryOverviewState>;
  pages: Record<string, LibraryPageState>;
  memberships: Record<string, LibraryMembership>;
  /** key = `${field}|${canonicalId}` while a write is in flight or queued. */
  pending: Record<string, true>;
  /** key = `${field}|${canonicalId}` after a failed write; value is actionable copy. */
  errors: Record<string, string>;
};

const PAGE_LIMIT = 30;

// isNewerRevision: lossless string bigint comparison (never Number, contract
// §Revision rules). Non-numeric values compare lexically as a safe fallback.
export function isNewerRevision(candidate: string, current: string | undefined | null): boolean {
  if (current === undefined || current === null || current === '') return true;
  if (candidate === current) return false;
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    return candidate > current;
  }
}
export function overviewKey(collection: LibraryCollection, sort: LibrarySort): string {
  return `${collection}|${sort}`;
}

export function pageKey(collection: LibraryCollection, kind: LibraryMediaKind | 'all', sort: LibrarySort): string {
  return `${collection}|${kind}|${sort}`;
}

export function flagKey(field: LibraryCollection, canonicalId: string): string {
  return `${field}|${canonicalId}`;
}

// LibraryController is the surface shared components consume. LibraryStore
// implements it against the real server; deterministic test/capture fixtures
// implement the same surface explicitly (never a production fallback).
export type LibraryController = Pick<
  LibraryStore,
  | 'subscribe'
  | 'getSnapshot'
  | 'ensureOverview'
  | 'loadOverview'
  | 'ensurePage'
  | 'loadPage'
  | 'loadMore'
  | 'refreshCapability'
  | 'refreshAll'
  | 'toggle'
  | 'retry'
  | 'lastTargetFor'
  // M1.4: the mobile shell disposes composition-owned stores when replaced.
  | 'dispose'
>;

export class LibraryStore {
  private snapshot: LibrarySnapshot = {
    availability: 'checking',
    overviews: {},
    pages: {},
    memberships: {},
    pending: {},
    errors: {},
  };
  private listeners = new Set<() => void>();
  // Monotonic request sequence per cache key: a response from a superseded
  // request (older fetch of the same resource) is discarded.
  private requestSeq = new Map<string, number>();
  // Serialized write chains per title/field.
  private writeQueues = new Map<string, Promise<void>>();
  // Last intended target per title/field, so Retry re-issues it truthfully.
  private lastTargets = new Map<string, boolean>();
  private disposed = false;
  private unsubscribeOrigin: () => void = () => undefined;

  private deps: { fetchImpl?: typeof fetch };

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.deps = deps;
    // Requirement 15: origin-scoped state is cleared on origin change. The
    // shared origin service bumps a generation and aborts in-flight requests;
    // the store drops every cached resource and re-checks the capability.
    // The subscription is remembered so dispose() can detach it (no leaks).
    this.unsubscribeOrigin = subscribeOrigin(() => {
      this.resetForOriginSwitch();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LibrarySnapshot => this.snapshot;

  private publish(next: Partial<LibrarySnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (error) {
        console.warn('[Library] subscriber failed:', error);
      }
    }
  }

  // refreshCapability checks /v1/version and gates availability:
  //   - capability advertised → 'available'
  //   - server reachable without the capability (older server) → 'unavailable'
  //   - server unreachable → 'unreachable'
  // Both non-available states render the explicit library-unavailable surface;
  // nothing ever falls back to local state (FR10).
  async refreshCapability(): Promise<LibraryAvailability> {
    if (this.disposed) return this.snapshot.availability;
    // A delayed capability response from an OLD origin must never set the new
    // origin's availability: capture the generation at request start.
    const startedGeneration = backendGeneration();
    const version = await fetchServerVersion(this.deps);
    if (backendGeneration() !== startedGeneration) {
      return this.snapshot.availability; // origin switched mid-probe: discard
    }
    if (serverHasLibraryCapability(version?.capabilities)) {
      this.setAvailability('available');
    } else if (version) {
      this.setAvailability('unavailable');
    } else {
      // A null version cannot distinguish an old server from an unreachable
      // one: probe once so the copy is truthful.
      const reachable = await this.probeReachable();
      if (backendGeneration() !== startedGeneration) {
        return this.snapshot.availability;
      }
      this.setAvailability(reachable ? 'unavailable' : 'unreachable');
    }
    return this.snapshot.availability;
  }

  private async probeReachable(): Promise<boolean> {
    const doFetch = this.deps.fetchImpl ?? fetch.bind(globalThis);
    try {
      await doFetch(buildBackendUrl('/v1/version'), { headers: { Accept: 'application/json' } });
      return true;
    } catch {
      return false;
    }
  }

  private setAvailability(availability: LibraryAvailability) {
    if (this.snapshot.availability !== availability) {
      this.publish({ availability });
    }
  }

  // resetForOriginSwitch clears all origin-scoped state (requirement 15) and
  // re-checks the capability against the new origin.
  resetForOriginSwitch(): void {
    this.requestSeq.clear();
    this.everLoaded.clear();
    this.writeQueues.clear();
    this.lastTargets.clear();
    this.publish({
      availability: 'checking',
      overviews: {},
      pages: {},
      memberships: {},
      pending: {},
      errors: {},
    });
    void this.refreshCapability();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeOrigin();
    this.listeners.clear();
  }

  // --- Reads ----------------------------------------------------------------

  ensureOverview(collection: LibraryCollection, sort: LibrarySort): void {
    if (this.snapshot.availability !== 'available') return;
    const existing = this.snapshot.overviews[overviewKey(collection, sort)];
    if (existing && existing.status === 'ready' && !existing.stale) return;
    void this.loadOverview(collection, sort);
  }

  async loadOverview(collection: LibraryCollection, sort: LibrarySort): Promise<void> {
    if (this.snapshot.availability !== 'available') return;
    const key = overviewKey(collection, sort);
    this.everLoaded.add(key);
    const seq = this.nextSeq(key);
    const startedGeneration = backendGeneration();
    // Capture the last good snapshot BEFORE the loading state replaces it: a
    // failed refresh must fall back to it, labelled stale (M3.4 offline reads).
    const previous = this.snapshot.overviews[key];
    this.publish({
      overviews: { ...this.snapshot.overviews, [key]: { status: 'loading', shelves: [], revision: '', error: null } },
    });
    try {
      const data = await fetchLibraryOverview(collection, sort, this.deps);
      if (!this.isCurrent(seq, key, startedGeneration)) return;
      const memberships = this.mergeMembershipRows(data.shelves.flatMap((shelf) => shelf.previews), collection, data.revision);
      // Empty-collection truth (overview counts are full-scope): a zero count
      // PROVES no title is in this collection, so confirmed flags older than
      // this snapshot are reconciled — this is how a removal made by ANOTHER
      // client becomes visible on this client after a bounded poll. (A
      // non-empty collection cannot prove absence from bounded reads; the
      // Library lists themselves always render server truth.)
      if (data.shelves.reduce((sum, shelf) => sum + shelf.count, 0) === 0) {
        for (const [id, membership] of Object.entries(memberships)) {
          if (isNewerRevision(membership.revision ?? '', data.revision)) continue;
          memberships[id] = collection === 'watch-later'
            ? { ...membership, watchLater: false, revision: data.revision }
            : { ...membership, favourite: false, revision: data.revision };
        }
      }
      this.publish({
        overviews: {
          ...this.snapshot.overviews,
          [key]: { status: 'ready', shelves: data.shelves, revision: data.revision, error: null },
        },
        memberships,
      });
    } catch (error) {
      if (!this.isCurrent(seq, key, startedGeneration)) return;
      if (previous && previous.status === 'ready') {
        // Offline read: keep the previously loaded snapshot on screen, clearly
        // labelled stale. Never a local fork — it is the server's last
        // response this origin delivered.
        this.publish({
          overviews: {
            ...this.snapshot.overviews,
            [key]: { ...previous, stale: true, error: libraryErrorCopy(error) },
          },
        });
        return;
      }
      this.publish({
        overviews: {
          ...this.snapshot.overviews,
          [key]: { status: 'error', shelves: [], revision: '', error: libraryErrorCopy(error) },
        },
      });
    }
  }

  ensurePage(collection: LibraryCollection, kind: LibraryMediaKind | 'all', sort: LibrarySort): void {
    if (this.snapshot.availability !== 'available') return;
    const existing = this.snapshot.pages[pageKey(collection, kind, sort)];
    if (existing && existing.status === 'ready' && !existing.stale) return;
    void this.loadPage(collection, kind, sort);
  }

  async loadPage(collection: LibraryCollection, kind: LibraryMediaKind | 'all', sort: LibrarySort): Promise<void> {
    if (this.snapshot.availability !== 'available') return;
    const key = pageKey(collection, kind, sort);
    this.everLoaded.add(key);
    const seq = this.nextSeq(key);
    const startedGeneration = backendGeneration();
    const previous = this.snapshot.pages[key];
    this.publish({
      pages: {
        ...this.snapshot.pages,
        [key]: { status: 'loading', items: [], total: 0, revision: '', cursor: null, loadingMore: false, error: null },
      },
    });
    try {
      const data = await fetchLibraryPage(collection, kind, sort, undefined, PAGE_LIMIT, this.deps);
      if (!this.isCurrent(seq, key, startedGeneration)) return;
      this.publish({
        pages: {
          ...this.snapshot.pages,
          [key]: {
            status: 'ready',
            items: data.items,
            total: data.total,
            revision: data.revision,
            cursor: data.nextCursor ?? null,
            loadingMore: false,
            error: null,
          },
        },
        memberships: this.mergeMembershipRows(data.items, collection, data.revision),
      });
    } catch (error) {
      if (!this.isCurrent(seq, key, startedGeneration)) return;
      if (previous && previous.status === 'ready') {
        this.publish({
          pages: {
            ...this.snapshot.pages,
            [key]: { ...previous, stale: true, error: libraryErrorCopy(error) },
          },
        });
        return;
      }
      this.publish({
        pages: {
          ...this.snapshot.pages,
          [key]: { status: 'error', items: [], total: 0, revision: '', cursor: null, loadingMore: false, error: libraryErrorCopy(error) },
        },
      });
    }
  }

  // loadMore fetches the next cursor page, deduplicates canonical ids against
  // what is already loaded, and applies only a response that is at least as
  // new as the loaded page. A stale/mismatched cursor is a server 400: the
  // loaded grid stays and a truthful retry (from page one) is offered.
  async loadMore(collection: LibraryCollection, kind: LibraryMediaKind | 'all', sort: LibrarySort): Promise<void> {
    const key = pageKey(collection, kind, sort);
    const page = this.snapshot.pages[key];
    if (!page || page.status !== 'ready' || !page.cursor || page.loadingMore) return;
    const seq = this.nextSeq(key);
    const startedGeneration = backendGeneration();
    this.publish({ pages: { ...this.snapshot.pages, [key]: { ...page, loadingMore: true } } });
    try {
      const data = await fetchLibraryPage(collection, kind, sort, page.cursor, PAGE_LIMIT, this.deps);
      if (!this.isCurrent(seq, key, startedGeneration)) return;
      // Repair-pass rule (Fix 3): if the household revision changed between
      // cursor pages, the two pages are different snapshots and appending
      // would mix them. Discard the fetched page and reload from page one so
      // the grid is always one consistent snapshot.
      if (data.revision !== page.revision) {
        await this.loadPage(collection, kind, sort);
        return;
      }
      const seen = new Set(page.items.map((item) => item.canonicalId));
      const fresh = data.items.filter((item) => !seen.has(item.canonicalId));
      this.publish({
        pages: {
          ...this.snapshot.pages,
          [key]: {
            status: 'ready',
            items: [...page.items, ...fresh],
            total: data.total,
            revision: data.revision,
            cursor: data.nextCursor ?? null,
            loadingMore: false,
            error: null,
          },
        },
        memberships: this.mergeMembershipRows(data.items, collection, data.revision),
      });
    } catch (error) {
      if (!this.isCurrent(seq, key, startedGeneration)) return;
      const currentPage = this.snapshot.pages[key];
      if (!currentPage || currentPage.status !== 'ready') return;
      const staleCursor = error instanceof LibraryServiceError && error.code === 'invalid_request';
      this.publish({
        pages: {
          ...this.snapshot.pages,
          [key]: {
            ...currentPage,
            loadingMore: false,
            // A rejected cursor is truthfully stale: reset to page one on
            // retry instead of silently mixing scopes.
            cursor: staleCursor ? null : currentPage.cursor,
            error: staleCursor
              ? 'The page moved while you were reading. Reload from the first page.'
              : libraryErrorCopy(error),
          },
        },
      });
    }
  }

  // invalidateCollection drops every overview/page cache for the collection
  // (post-mutation) so the next ensure refetches fresh server state.
  invalidateCollection(collection: LibraryCollection): void {
    const overviews = { ...this.snapshot.overviews };
    for (const key of Object.keys(overviews)) {
      if (key.startsWith(`${collection}|`)) delete overviews[key];
    }
    const pages = { ...this.snapshot.pages };
    for (const key of Object.keys(pages)) {
      if (key.startsWith(`${collection}|`)) delete pages[key];
    }
    this.publish({ overviews, pages });
  }

  // reconcileMemberships is the truthful server-backed removal reconciliation
  // (repair pass Fix 2): the sync asks the server for the confirmed flags of
  // every LOCALLY-KNOWN title in one bounded request. A returned entry at a
  // newer revision reconciles that title's flags; an id the server OMITS (at
  // a newer revision) is proven absent — its locally-confirmed flags are
  // cleared. This makes a removal by ANOTHER client visible even when other
  // titles remain in the collection, without inferring absence from bounded
  // overview previews.
  async reconcileMemberships(): Promise<void> {
    if (this.snapshot.availability !== 'available') return;
    const known = Object.keys(this.snapshot.memberships);
    if (known.length === 0) return;
    const startedGeneration = backendGeneration();
    try {
      const data = await fetchLibraryMemberships(known, this.deps);
      if (backendGeneration() !== startedGeneration) return; // old-origin response
      const memberships = { ...this.snapshot.memberships };
      const returned = new Set(data.memberships.map((entry) => entry.canonicalId));
      for (const entry of data.memberships) {
        const existing = memberships[entry.canonicalId];
        if (existing && isNewerRevision(existing.revision ?? '', data.revision)) continue;
        memberships[entry.canonicalId] = {
          watchLater: entry.watchLater,
          favourite: entry.favourite,
          revision: data.revision,
        };
      }
      for (const id of known) {
        if (returned.has(id)) continue;
        const existing = memberships[id];
        if (existing && isNewerRevision(existing.revision ?? '', data.revision)) continue;
        memberships[id] = { watchLater: false, favourite: false, revision: data.revision };
      }
      this.publish({ memberships });
    } catch {
      // Reconciliation failure never blocks: the next poll retries.
    }
  }

  // refreshAll refetches every resource this origin has ever loaded (ready
  // caches AND caches invalidated by a local write), so sync polls always
  // reconcile the surfaces the user has touched. A single refresh runs at a
  // time. An overlapping call is NOT lost: it queues exactly one follow-up
  // pass so a poll that collides with an in-flight refresh still reconciles
  // (a dropped poll would double the effective sync interval and violate the
  // ≤20s cross-client visibility bound). Reads that fail keep their labelled
  // stale snapshots.
  private refreshInFlight = false;
  private refreshQueued = false;
  private everLoaded = new Set<string>();

  async refreshAll(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    if (this.snapshot.availability !== 'available') return;
    this.refreshInFlight = true;
    try {
      do {
        this.refreshQueued = false;
        // The sync ALWAYS reconciles BOTH collections' overviews (two batched
        // reads): cross-client changes to either flag must become visible
        // through bounded polling, including on clients that never opened the
        // other collection's screen.
        const keys = new Set([
          ...Object.keys(this.snapshot.overviews),
          ...Object.keys(this.snapshot.pages),
          ...this.everLoaded,
          overviewKey('watch-later', 'recent'),
          overviewKey('favourites', 'recent'),
        ]);
        const jobs: Array<Promise<void>> = [];
        for (const key of keys) {
          const parts = key.split('|');
          if (parts.length === 2) {
            jobs.push(this.loadOverview(parts[0] as LibraryCollection, parts[1] as LibrarySort));
          } else if (parts.length === 3) {
            jobs.push(this.loadPage(parts[0] as LibraryCollection, parts[1] as LibraryMediaKind | 'all', parts[2] as LibrarySort));
          }
        }
        await Promise.all(jobs);
        // Cross-client removal reconciliation runs WITH each poll so a removed
        // title becomes visible within the documented bounded interval.
        await this.reconcileMemberships();
      } while (this.refreshQueued && !this.disposed);
    } finally {
      this.refreshInFlight = false;
    }
  }

  // --- Writes ---------------------------------------------------------------

  // toggle flips one field for one title. Rapid/repeated clicks serialize per
  // title/field: each click computes its target from the LATEST known target
  // at enqueue time and is applied after the previous write settles. No
  // offline queue: a click while unreachable fails truthfully.
  toggle(canonicalId: string, field: LibraryCollection): void {
    if (this.snapshot.availability !== 'available') return;
    const pendingKey = flagKey(field, canonicalId);
    const queued = Boolean(this.snapshot.pending[pendingKey]);
    const membership = this.snapshot.memberships[canonicalId];
    const confirmed = field === 'watch-later'
      ? membership?.watchLater ?? false
      : membership?.favourite ?? false;
    const target = queued ? !(this.lastTargets.get(pendingKey) ?? confirmed) : !confirmed;
    this.lastTargets.set(pendingKey, target);
    this.publish({ pending: { ...this.snapshot.pending, [pendingKey]: true as const } });
    this.enqueueWrite(canonicalId, field, target, pendingKey, backendGeneration());
  }

  // retry re-issues the last intended target after a failed write.
  retry(canonicalId: string, field: LibraryCollection): void {
    const pendingKey = flagKey(field, canonicalId);
    if (this.snapshot.pending[pendingKey]) return;
    const target = this.lastTargets.get(pendingKey);
    if (target === undefined) return;
    this.publish({ pending: { ...this.snapshot.pending, [pendingKey]: true as const } });
    this.enqueueWrite(canonicalId, field, target, pendingKey, backendGeneration());
  }

  // lastTargetFor exposes the queued/in-flight/last-intended target for a
  // title/field so pending UI can read the actual intent (never a guess).
  lastTargetFor(canonicalId: string, field: LibraryCollection): boolean | undefined {
    return this.lastTargets.get(flagKey(field, canonicalId));
  }

  private enqueueWrite(
    canonicalId: string, field: LibraryCollection, target: boolean, pendingKey: string, generation: number,
  ): void {
    const run = (this.writeQueues.get(pendingKey) ?? Promise.resolve())
      .then(() => this.performWrite(canonicalId, field, target, pendingKey, generation))
      .catch(() => undefined); // the queue never rejects; performWrite catches
    this.writeQueues.set(pendingKey, run);
  }

  private async performWrite(
    canonicalId: string, field: LibraryCollection, target: boolean, pendingKey: string, generation: number,
  ): Promise<void> {
    if (this.disposed) return;
    try {
      const response = await putLibraryFlag(canonicalId, field, target, this.deps);
      if (backendGeneration() !== generation) {
        return; // origin switched mid-write: the response is discarded
      }
      // Reconcile from the COMPLETE server response: BOTH flags + revision.
      // Apply only when the response revision is not older than the last
      // confirmed revision FOR THIS TITLE (per-resource compare, never one
      // global number) — a late response cannot undo newer confirmed state.
      const membership = this.snapshot.memberships[canonicalId];
      if (!membership || isNewerRevision(response.revision, membership.revision)) {
        this.publish({
          memberships: {
            ...this.snapshot.memberships,
            [canonicalId]: {
              watchLater: response.watchLater,
              favourite: response.favourite,
              revision: response.revision,
            },
          },
        });
      }
      const pending = { ...this.snapshot.pending };
      delete pending[pendingKey];
      const errors = { ...this.snapshot.errors };
      delete errors[pendingKey];
      this.publish({ pending, errors });
      // Post-mutation invalidation (requirement 19): the title's membership
      // is reconciled above; Library resources refetch on next ensure.
      this.invalidateCollection(field);
    } catch (error) {
      // A FAILED response from an old origin must not surface an error on the
      // new origin's state either: drop it silently (the write outcome is
      // unknowable; Retry is always available after the switch).
      if (backendGeneration() !== generation) return;
      // Failure: drop the pending display (confirmed server state stands) and
      // surface a truthful, retryable error. The last target is kept so the
      // toggle's next activation retries exactly the intended change.
      const pending = { ...this.snapshot.pending };
      delete pending[pendingKey];
      this.publish({
        pending,
        errors: { ...this.snapshot.errors, [pendingKey]: libraryErrorCopy(error) },
      });
    }
  }

  // Confirmed membership truth from list rows: a row present in a collection
  // response means that collection holds the title AS OF the response
  // revision. A write response with a newer per-title revision always wins.
  private mergeMembershipRows(
    rows: LibraryItemRow[], collection: LibraryCollection, revision: string,
  ): Record<string, LibraryMembership> {
    const memberships = { ...this.snapshot.memberships };
    for (const row of rows) {
      const existing = memberships[row.canonicalId];
      if (existing && isNewerRevision(existing.revision ?? '', revision)) continue;
      memberships[row.canonicalId] = {
        watchLater: collection === 'watch-later' ? true : existing?.watchLater ?? false,
        favourite: collection === 'favourites' ? true : existing?.favourite ?? false,
        revision: existing && isNewerRevision(existing.revision ?? '', revision) ? existing.revision : revision,
      };
    }
    return memberships;
  }

  private nextSeq(key: string): number {
    const seq = (this.requestSeq.get(key) ?? 0) + 1;
    this.requestSeq.set(key, seq);
    return seq;
  }

  // isCurrent discards superseded fetches: an older request of the same
  // resource and any response that raced an origin switch never apply.
  private isCurrent(seq: number, key: string, startedGeneration: number): boolean {
    if (this.disposed) return false;
    if (this.requestSeq.get(key) !== seq) return false;
    if (backendGeneration() !== startedGeneration) return false;
    try {
      assertCurrentGeneration(startedGeneration);
    } catch {
      return false;
    }
    return true;
  }
}

export function libraryErrorCopy(error: unknown): string {
  if (error instanceof LibraryServiceError) {
    if (error.code === 'backend_unreachable' || error.code === 'origin_changed') {
      return 'The TorWatch server could not be reached. Check the connection and retry.';
    }
    if (error.code === 'http_503' || error.code === 'providers_unavailable') {
      return 'The server could not reach its catalog providers. Retry shortly.';
    }
    if (error.code === 'title_not_found') {
      return 'The server does not know this title yet. Open it in the catalog once, then try again.';
    }
    return error.message;
  }
  return 'The library operation failed. Retry shortly.';
}
