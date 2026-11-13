// RecommendationRow + RecommendationsAllPage (feature 002 M4.2): the shared
// Home recommendation section and its See-all view, rendered by desktop AND
// phone/browser entries from one source.
//
// Behavior (plan.md, design-system): favourite-based results carry the
// server's truthful reason ("Because you favourited X"); cold start/no seeds
// render the server's labelled "Popular picks" fallback; failures show a
// bounded Retry row that never blocks or replaces the rest of Home; a server
// without the recommendations capability renders nothing at all. Qualified
// opaque canonical ids drive navigation.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, EyeOff, ListFilter, RotateCw, Sparkles } from 'lucide-react';
import { PageBackButton } from './PageBackButton';
import { ACTION_SECONDARY_CLASS, FOCUS_RING_CLASS } from '../../lib/design-tokens';
import { titleRouteParams } from '../../lib/canonical-route';
import { LibraryToggle } from './LibraryToggle';
import { SelectionSurface } from '../primitives';
import {
  fetchRecommendations,
  liveRecommendationCapabilities,
  type RecommendationItem,
  type RecommendationsData,
} from '../../lib/services/recommendation-service';
import {
  fetchRecommendationStats,
  recommendationStatsLine,
  reportSeen,
  sendNotInterested,
} from '../../lib/services/recommendation-feedback';
import { backendGeneration, subscribeOrigin } from '../../lib/connection-service';

// generationChanged: a response that raced an origin switch is discarded.
function generationChanged(started: number): boolean {
  return backendGeneration() !== started;
}

type Navigate = (path: string, params?: Record<string, string>) => void;
type RecommendationKind = 'all' | RecommendationItem['type'];

const RECOMMENDATION_FILTERS: ReadonlyArray<{ value: RecommendationKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'series', label: 'Series' },
  { value: 'anime', label: 'Anime' },
];

export type RowState = {
  status: 'loading' | 'ready' | 'error' | 'hidden';
  data: RecommendationsData | null;
  error: string | null;
  /** The server learns from seen cards and "not interested". */
  learning?: boolean;
};

// useRecommendations loads the section once per mount with generation-guarded
// requests. Origin switches bump the shared generation: in-flight responses
// are discarded, already-loaded recommendations are CLEARED, and the section
// refetches from the new origin (repair pass Fix 4).
function useRecommendations(deps?: { fetchImpl?: typeof fetch }) {
  const [state, setState] = useState<RowState>({ status: 'loading', data: null, error: null });
  const generationRef = useRef(0);
  // rerender-dependencies: subscribe to the primitive, not the `deps`
  // object — callers pass it inline, so object identity changes every
  // parent render and an object dep would refetch on each one.
  const fetchImpl = deps?.fetchImpl;

  const load = useCallback(async () => {
    const startedGeneration = generationRef.current = backendGeneration();
    setState((current) => ({ ...current, status: 'loading', error: null }));
    try {
      const capabilities = await liveRecommendationCapabilities({ fetchImpl });
      if (!capabilities.available) {
        // Older server: no recommendation section at all (never a fake row).
        setState({ status: 'hidden', data: null, error: null });
        return;
      }
      const data = await fetchRecommendations({ fetchImpl });
      if (generationChanged(startedGeneration)) return; // stale/cross-origin discard
      setState({ status: 'ready', data, error: null, learning: capabilities.learning });
    } catch (error) {
      if (generationChanged(startedGeneration)) return;
      setState({ status: 'error', data: null, error: String((error as Error)?.message ?? error) });
    }
  }, [fetchImpl]);

  useEffect(() => { void load(); }, [load]);

  // Repair pass Fix 4: an origin switch clears loaded recommendations and
  // refetches against the new origin. The subscription is detached on unmount.
  useEffect(() => {
    const unsubscribe = subscribeOrigin(() => {
      setState({ status: 'loading', data: null, error: null });
      void load();
    });
    return unsubscribe;
  }, [load]);

  return { state, retry: load };
}

// useSeenOnScreen reports a card once it has been at least 60% on screen for
// a second (what the profile actually saw, not what was loaded).
function useSeenOnScreen(canonicalId: string, position: number, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reported = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (reported) return;
      if (entry?.isIntersecting && entry.intersectionRatio >= 0.6) {
        timer ??= setTimeout(() => {
          reported = true;
          reportSeen(canonicalId, position);
          observer.disconnect();
        }, 1000);
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }, { threshold: [0, 0.6, 1] });
    observer.observe(element);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [canonicalId, position, enabled]);
  return ref;
}

// useNotInterested: cards turned down leave the row at once; the last one
// can be taken back for a few seconds.
function useNotInterested(enabled: boolean) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [last, setLast] = useState<RecommendationItem | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!last) return undefined;
    const timer = setTimeout(() => setLast(null), 8000);
    return () => clearTimeout(timer);
  }, [last]);
  const dismiss = useCallback((item: RecommendationItem) => {
    if (!enabled) return;
    setFailed(false);
    setHidden((current) => new Set(current).add(item.canonicalId));
    setLast(item);
    void sendNotInterested(item.canonicalId, item.title).then((ok) => {
      if (ok) return;
      setHidden((current) => {
        const next = new Set(current);
        next.delete(item.canonicalId);
        return next;
      });
      setLast(null);
      setFailed(true);
    });
  }, [enabled]);
  const undo = useCallback(() => {
    if (!last) return;
    const item = last;
    setLast(null);
    setHidden((current) => {
      const next = new Set(current);
      next.delete(item.canonicalId);
      return next;
    });
    void sendNotInterested(item.canonicalId, item.title, true);
  }, [last]);
  return { hidden, last, failed, dismiss, undo };
}

function NotInterestedNote({ last, failed, undo }: { last: RecommendationItem | null; failed: boolean; undo: () => void }) {
  if (failed) {
    return <p className="type-secondary mb-3 text-white/70" role="status">Couldn’t save that. Try again in a moment.</p>;
  }
  if (!last) return null;
  return (
    <div className="mb-3 flex items-center gap-3" role="status">
      <p className="type-secondary min-w-0 truncate text-white/75">You won’t see {last.title} here again.</p>
      <button type="button" onClick={undo} className={`shrink-0 rounded-lg px-2 text-sm font-semibold text-[var(--cinema-accent,#e7bd82)] min-h-11 ${FOCUS_RING_CLASS}`}>
        Undo
      </button>
    </div>
  );
}

function RecommendationCard({ item, navigate, index, learning = false, onNotInterested }: {
  item: RecommendationItem;
  navigate: Navigate;
  index: number;
  learning?: boolean;
  onNotInterested?: (item: RecommendationItem) => void;
}) {
  const seenRef = useSeenOnScreen(item.canonicalId, index, learning);
  return (
    <div className="relative" ref={seenRef}>
      <button
        type="button"
        onClick={() => navigate('title', titleRouteParams(item.canonicalId))}
        aria-label={`${item.title}, ${item.reason.text || 'Popular pick'}`}
        className={`group block w-full rounded-lg text-left ${FOCUS_RING_CLASS}`}
      >
        <span className="relative block aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/[0.08] bg-[var(--surface-raised)]">
          {item.artwork?.poster ? (
            <img
              src={item.artwork.poster}
              alt=""
              width="342"
              height="513"
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105"
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.08] to-white/[0.025]">
              <Sparkles className="h-6 w-6 opacity-30" aria-hidden="true" />
            </span>
          )}
        </span>
        {/* Text sits below the artwork (readable on any poster), matching
            the other rails. The reason names the seed title only. */}
        <span className="mt-2 line-clamp-2 block text-sm font-medium leading-snug text-white/90 group-hover:text-white">{item.title}</span>
        <span className="type-caption mt-1 block capitalize text-white/60">
          {item.type === 'series' ? 'Series' : item.type}{item.year ? ` · ${item.year}` : ''}
        </span>
        {/* Truthful reason: favourite-grounded vs Popular pick are
            distinguishable in text, never by color alone. */}
        <span className="type-caption mt-0.5 line-clamp-2 block text-white/60">
          {item.reason.text}
        </span>
        <span className="sr-only">Recommendation {index + 1}</span>
      </button>
      {/* Same Watch Later / Favourites overlays as every other rail: the
          card is a sibling of the toggles (never nested buttons). */}
      <div className="absolute right-1.5 top-1.5 z-10 flex flex-col gap-1.5">
        <LibraryToggle canonicalId={item.canonicalId} field="watch-later" variant="overlay" />
        <LibraryToggle canonicalId={item.canonicalId} field="favourites" variant="overlay" />
      </div>
      {learning && onNotInterested ? (
        <button
          type="button"
          onClick={() => onNotInterested(item)}
          aria-label={`Not interested in ${item.title}`}
          title="Not interested"
          className={`absolute left-1.5 top-1.5 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white/75 transition hover:text-white ${FOCUS_RING_CLASS}`}
        >
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function SectionHeader({ fallback, degraded, navigate }: { fallback: boolean; degraded: boolean; navigate: Navigate }) {
  return (
    <div className="shelf-heading mb-3">
      <div className="min-w-0">
      {/* M1.4 UI pass: the decorative icon is gone — cleaner Netflix-style
          section headers. */}
      <h2 className="type-row-title text-white">
        <span>
        {fallback ? 'Popular picks' : 'Recommended for your household'}
        </span>
      </h2>
      {degraded ? <p className="type-secondary mt-1 text-white/60" role="note">May be out of date</p> : null}
      </div>
      <button
        type="button"
        onClick={() => navigate('recommendations')}
        className={`shelf-see-all rounded-lg text-sm text-white/75 hover:text-white ${FOCUS_RING_CLASS}`}
        aria-label="See all recommendations"
      >
        See all
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// RecommendationRowView is the pure presentation for one RowState — exported
// so tests/captures can render exact states deterministically (SSR never runs
// the loading effect).
export function RecommendationRowView({ state, retry, navigate, loadingPlaceholder = 'skeleton' }: {
  state: RowState;
  retry: () => void;
  navigate: Navigate;
  // 'skeleton' reserves the rail layout while loading (Home: no CLS).
  // 'none' renders nothing while loading — used where the host page must
  // open instantly and this slow section pops in when ready (SearchPage).
  loadingPlaceholder?: 'skeleton' | 'none';
}) {
  if (state.status === 'hidden') return null; // older server: section absent
  if (state.status === 'loading' && loadingPlaceholder === 'none') return null;
  if (state.status === 'loading') {
    return (
      <section aria-label="Recommendations" className="tw-cull border-t border-white/[0.08] py-8 md:py-10">
        <div className="mb-4 flex items-center justify-between">
          <div className="h-6 w-56 animate-pulse rounded bg-white/10" />
        </div>
        <div className="hide-scrollbar flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="aspect-[2/3] w-[148px] shrink-0 animate-pulse rounded-lg bg-white/[0.06] sm:w-[164px] md:w-[178px] xl:w-[190px]" />
          ))}
        </div>
      </section>
    );
  }
  if (state.status === 'error') {
    // Bounded failure row: Home continues regardless; Retry refetches.
    return (
      <section aria-label="Recommendations unavailable" className="border-t border-white/[0.08] py-6">
        <div role="alert">
          <p className="type-body text-white/85">Couldn’t load recommendations.</p>
          <button
            type="button"
            onClick={() => void retry()}
            aria-label="Retry recommendations"
            className={`mt-3 ${ACTION_SECONDARY_CLASS}`}
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </button>
        </div>
      </section>
    );
  }

  return <ReadyRow state={state} navigate={navigate} />;
}

function ReadyRow({ state, navigate }: { state: RowState; navigate: Navigate }) {
  const learning = Boolean(state.learning);
  const { hidden, last, failed, dismiss, undo } = useNotInterested(learning);
  const data = state.data;
  if (!data || data.items.length === 0) return null; // truthful empty: no fabricated row
  const items = data.items.filter((item) => !hidden.has(item.canonicalId));

  return (
    <section aria-label={data.fallback ? 'Popular picks' : 'Recommendations for your household'} className="tw-cull border-t border-white/[0.08] py-8 md:py-10">
      <SectionHeader fallback={data.fallback} degraded={data.degraded} navigate={navigate} />
      <NotInterestedNote last={last} failed={failed} undo={undo} />
      <div className="hide-scrollbar flex gap-4 overflow-x-auto pb-2">
        {items.map((item, index) => (
          <div key={item.canonicalId} className="w-[148px] shrink-0 sm:w-[164px] md:w-[178px] xl:w-[190px]">
            <RecommendationCard item={item} navigate={navigate} index={index} learning={learning} onNotInterested={data.fallback ? undefined : dismiss} />
          </div>
        ))}
      </div>
    </section>
  );
}

// RecommendationRow composes the loading hook with the pure view.
// Memoized: the featured-hero rotation timer re-renders Home periodically;
// this section must not re-render (and re-paint) with it.
export const RecommendationRow = memo(function RecommendationRow({ navigate, deps, loadingPlaceholder }: {
  navigate: Navigate;
  deps?: { fetchImpl?: typeof fetch };
  loadingPlaceholder?: 'skeleton' | 'none';
}) {
  const { state, retry } = useRecommendations(deps);
  return <RecommendationRowView state={state} retry={retry} navigate={navigate} loadingPlaceholder={loadingPlaceholder} />;
});

// RecommendationsAllPageView: the pure See-all presentation for one RowState.
export function RecommendationsAllPageView({ state, retry, navigate }: {
  state: RowState;
  retry: () => void;
  navigate: Navigate;
}) {
  const [filter, setFilter] = useState<RecommendationKind>('all');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const learning = Boolean(state.learning);
  const { hidden, last, failed, dismiss, undo } = useNotInterested(learning);
  const [statsLine, setStatsLine] = useState<string | null>(null);
  useEffect(() => {
    if (!learning) return undefined;
    let active = true;
    void fetchRecommendationStats().then((stats) => { if (active) setStatsLine(recommendationStatsLine(stats)); });
    return () => { active = false; };
  }, [learning]);
  const allItems = state.data?.items ?? [];
  const items = useMemo(() => allItems.filter((item) => !hidden.has(item.canonicalId)), [allItems, hidden]);
  const counts = useMemo(() => ({
    all: items.length,
    movie: items.filter((item) => item.type === 'movie').length,
    series: items.filter((item) => item.type === 'series').length,
    anime: items.filter((item) => item.type === 'anime').length,
  }), [items]);
  const visibleItems = filter === 'all' ? items : items.filter((item) => item.type === filter);

  const chooseFilter = (next: RecommendationKind) => {
    setFilter(next);
    setMobileFiltersOpen(false);
  };

  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8 lg:px-12">
      <PageBackButton />
      <h1 className="type-section-title mt-2 text-white">
        {state.data?.fallback ? 'Popular picks' : 'Recommended for your household'}
      </h1>
      <div className={`mt-4 items-center justify-end gap-4 md:hidden ${items.length ? 'flex' : 'hidden'}`}>
        <button
          type="button"
          onClick={() => setMobileFiltersOpen(true)}
          className={`inline-flex min-h-12 shrink-0 items-center gap-2 rounded-lg px-2 text-sm text-white/75 hover:text-white ${FOCUS_RING_CLASS}`}
          aria-haspopup="dialog"
        >
          <ListFilter className="h-4 w-4" aria-hidden="true" />
          {RECOMMENDATION_FILTERS.find((option) => option.value === filter)?.label}
        </button>
      </div>

      <div className="mt-5 hidden gap-1 border-b border-white/[0.08] md:flex" role="group" aria-label="Filter recommendations by title type">
        {RECOMMENDATION_FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => chooseFilter(option.value)}
            aria-pressed={filter === option.value}
            className={`relative min-h-12 px-4 text-sm transition ${filter === option.value ? 'text-white' : 'text-white/55 hover:text-white'} ${FOCUS_RING_CLASS}`}
          >
            {option.label} <span className="text-numeric ml-1 text-xs opacity-60">{counts[option.value]}</span>
            <span aria-hidden="true" className={`absolute inset-x-3 bottom-0 h-0.5 bg-white transition-opacity ${filter === option.value ? 'opacity-100' : 'opacity-0'}`} />
          </button>
        ))}
      </div>

      <SelectionSurface open={mobileFiltersOpen} title="Filter recommendations" onClose={() => setMobileFiltersOpen(false)}>
        <div className="grid gap-2">
          {RECOMMENDATION_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => chooseFilter(option.value)}
              aria-pressed={filter === option.value}
              className={`flex min-h-12 items-center justify-between rounded-lg px-4 text-sm transition ${filter === option.value ? 'bg-white text-black' : 'bg-white/[0.05] text-white/75'} ${FOCUS_RING_CLASS}`}
            >
              <span>{option.label}</span>
              <span className="flex items-center gap-3">
                <span className="text-numeric opacity-60">{counts[option.value]}</span>
                {filter === option.value ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
              </span>
            </button>
          ))}
        </div>
      </SelectionSurface>

      {state.status === 'loading' ? (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6" role="status" aria-label="Loading recommendations">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="aspect-[2/3] animate-pulse rounded-lg bg-white/[0.06]" />
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div className="mt-6" role="alert">
          {/* Bounded friendly copy: raw error strings never render to users. */}
          <p className="type-body text-white/85">Couldn’t load recommendations.</p>
          <button
            type="button"
            onClick={() => void retry()}
            aria-label="Retry recommendations"
            className={`mt-3 ${ACTION_SECONDARY_CLASS}`}
          >
            Retry
          </button>
        </div>
      ) : state.data && state.data.items.length > 0 ? (
        <>
          {state.data.degraded ? (
            <p className="type-secondary mt-2 text-white/60" role="note">May be out of date</p>
          ) : null}
          {statsLine ? <p className="type-secondary mt-2 text-white/55">{statsLine}</p> : null}
          <div className="mt-4"><NotInterestedNote last={last} failed={failed} undo={undo} /></div>
          {visibleItems.length > 0 ? <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {visibleItems.map((item, index) => (
              <RecommendationCard key={item.canonicalId} item={item} navigate={navigate} index={index} learning={learning} onNotInterested={state.data?.fallback ? undefined : dismiss} />
            ))}
          </div> : (
            <div className="mt-6" role="status">
              <p className="type-body text-white/70">No {RECOMMENDATION_FILTERS.find((option) => option.value === filter)?.label.toLowerCase()} here.</p>
              <button type="button" onClick={() => chooseFilter('all')} className={`mt-3 ${ACTION_SECONDARY_CLASS}`}>
                Show all
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="type-body mt-6 text-white/70" role="status">
          No recommendations right now. Favourite titles to get suggestions.
        </p>
      )}
    </section>
  );
}

// RecommendationsAllPage composes the loading hook with the pure view.
export function RecommendationsAllPage({ navigate, deps }: { navigate: Navigate; deps?: { fetchImpl?: typeof fetch } }) {
  const { state, retry } = useRecommendations(deps);
  return <RecommendationsAllPageView state={state} retry={retry} navigate={navigate} />;
}
