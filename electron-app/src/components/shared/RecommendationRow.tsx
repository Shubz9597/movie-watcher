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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, ListFilter, RotateCw, Sparkles } from 'lucide-react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import { titleRouteParams } from '../../lib/canonical-route';
import { SelectionSurface } from '../primitives';
import {
  fetchRecommendations,
  hasLiveRecommendationsCapability,
  type RecommendationItem,
  type RecommendationsData,
} from '../../lib/services/recommendation-service';
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
};

// useRecommendations loads the section once per mount with generation-guarded
// requests. Origin switches bump the shared generation: in-flight responses
// are discarded, already-loaded recommendations are CLEARED, and the section
// refetches from the new origin (repair pass Fix 4).
function useRecommendations(deps?: { fetchImpl?: typeof fetch }) {
  const [state, setState] = useState<RowState>({ status: 'loading', data: null, error: null });
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const startedGeneration = generationRef.current = backendGeneration();
    setState((current) => ({ ...current, status: 'loading', error: null }));
    try {
      if (!(await hasLiveRecommendationsCapability(deps))) {
        // Older server: no recommendation section at all (never a fake row).
        setState({ status: 'hidden', data: null, error: null });
        return;
      }
      const data = await fetchRecommendations(deps);
      if (generationChanged(startedGeneration)) return; // stale/cross-origin discard
      setState({ status: 'ready', data, error: null });
    } catch (error) {
      if (generationChanged(startedGeneration)) return;
      setState({ status: 'error', data: null, error: String((error as Error)?.message ?? error) });
    }
  }, [deps]);

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

function RecommendationCard({ item, navigate, index }: {
  item: RecommendationItem;
  navigate: Navigate;
  index: number;
}) {
  return (
    <button
      type="button"
      onClick={() => navigate('title', titleRouteParams(item.canonicalId))}
      aria-label={`${item.title}${item.reason.code === 'seed_genre' ? `, ${item.reason.text}` : ', popular pick'}`}
      className={`group relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] ${FOCUS_RING_CLASS}`}
    >
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
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.08] to-white/[0.025]">
          <Sparkles className="h-6 w-6 opacity-30" aria-hidden="true" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6 text-left">
        <span className="line-clamp-2 text-xs font-medium leading-4 text-white">{item.title}</span>
        <span className="mt-0.5 block text-[10px] capitalize leading-3 text-white/60">
          {item.type === 'series' ? 'Series' : item.type}{item.year ? ` · ${item.year}` : ''}
        </span>
        {/* Truthful reason: favourite-grounded vs Popular pick are
            distinguishable in text, never by color alone. */}
        <span className="mt-0.5 line-clamp-1 block text-[10px] leading-3 text-white/60">
          {item.reason.text}
        </span>
      </div>
      <span className="sr-only">Recommendation {index + 1}</span>
    </button>
  );
}

function SectionHeader({ fallback, degraded, navigate }: { fallback: boolean; degraded: boolean; navigate: Navigate }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        {fallback ? 'Popular picks' : 'Recommended for your household'}
        {degraded ? <span className="text-xs font-normal text-white/50" role="note">(degraded — the server is serving its last computed list)</span> : null}
      </h2>
      <button
        type="button"
        onClick={() => navigate('recommendations')}
        className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm text-white/65 hover:text-white ${FOCUS_RING_CLASS}`}
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
export function RecommendationRowView({ state, retry, navigate }: {
  state: RowState;
  retry: () => void;
  navigate: Navigate;
}) {
  if (state.status === 'hidden') return null; // older server: section absent
  if (state.status === 'loading') {
    return (
      <section aria-label="Recommendations" className="border-t border-white/[0.08] py-8 md:py-10">
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
        <div className="rounded-lg border border-red-300/20 bg-red-950/30 px-4 py-3" role="alert">
          <p className="text-sm text-red-100">Recommendations could not be loaded. Everything else keeps working.</p>
          <button
            type="button"
            onClick={() => void retry()}
            aria-label="Retry recommendations"
            className={`mt-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-4 text-sm text-white/85 hover:border-white/35 ${FOCUS_RING_CLASS}`}
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </button>
        </div>
      </section>
    );
  }

  const data = state.data;
  if (!data || data.items.length === 0) return null; // truthful empty: no fabricated row

  return (
    <section aria-label={data.fallback ? 'Popular picks' : 'Recommendations for your household'} className="border-t border-white/[0.08] py-8 md:py-10">
      <SectionHeader fallback={data.fallback} degraded={data.degraded} navigate={navigate} />
      <div className="hide-scrollbar flex gap-4 overflow-x-auto pb-2">
        {data.items.map((item, index) => (
          <div key={item.canonicalId} className="w-[148px] shrink-0 sm:w-[164px] md:w-[178px] xl:w-[190px]">
            <RecommendationCard item={item} navigate={navigate} index={index} />
          </div>
        ))}
      </div>
    </section>
  );
}

// RecommendationRow composes the loading hook with the pure view.
export function RecommendationRow({ navigate, deps }: { navigate: Navigate; deps?: { fetchImpl?: typeof fetch } }) {
  const { state, retry } = useRecommendations(deps);
  return <RecommendationRowView state={state} retry={retry} navigate={navigate} />;
}

// RecommendationsAllPageView: the pure See-all presentation for one RowState.
export function RecommendationsAllPageView({ state, retry, navigate }: {
  state: RowState;
  retry: () => void;
  navigate: Navigate;
}) {
  const [filter, setFilter] = useState<RecommendationKind>('all');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const items = state.data?.items ?? [];
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
      <button
        type="button"
        onClick={() => navigate('home')}
        className={`inline-flex min-h-11 items-center rounded-full text-sm text-white/65 hover:text-white ${FOCUS_RING_CLASS}`}
      >
        <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
        Home
      </button>
      <h1 className="type-section-title mt-2 text-white">
        {state.data?.fallback ? 'Popular picks' : 'Recommended for your household'}
      </h1>
      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-sm leading-6 text-white/60">A mixed set of movies, series, and anime chosen for this household.</p>
        <button
          type="button"
          onClick={() => setMobileFiltersOpen(true)}
          className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 px-4 text-sm text-white/75 md:hidden ${FOCUS_RING_CLASS}`}
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
            className={`relative min-h-11 px-4 text-sm transition ${filter === option.value ? 'text-white' : 'text-white/55 hover:text-white'} ${FOCUS_RING_CLASS}`}
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
              className={`flex min-h-12 items-center justify-between rounded-xl px-4 text-sm transition ${filter === option.value ? 'bg-white text-black' : 'bg-white/[0.05] text-white/75'} ${FOCUS_RING_CLASS}`}
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
        <div className="mt-6 rounded-lg border border-red-300/20 bg-red-950/30 px-4 py-3" role="alert">
          {/* Bounded friendly copy: raw error strings never render to users. */}
          <p className="text-sm text-red-100">Recommendations could not be loaded. Everything else keeps working.</p>
          <button
            type="button"
            onClick={() => void retry()}
            aria-label="Retry recommendations"
            className={`mt-3 min-h-11 rounded-full border border-white/15 px-5 text-sm text-white/85 hover:border-white/35 ${FOCUS_RING_CLASS}`}
          >
            Retry
          </button>
        </div>
      ) : state.data && state.data.items.length > 0 ? (
        <>
          {state.data.degraded ? (
            <p className="mt-2 text-xs text-white/45" role="note">Degraded — the server is serving its last computed list.</p>
          ) : null}
          {visibleItems.length > 0 ? <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {visibleItems.map((item, index) => (
              <RecommendationCard key={item.canonicalId} item={item} navigate={navigate} index={index} />
            ))}
          </div> : (
            <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-8 text-center" role="status">
              <p className="text-sm text-white/65">No {filter} recommendations are in this set yet.</p>
              <button type="button" onClick={() => chooseFilter('all')} className={`mt-3 min-h-11 rounded-full px-4 text-sm text-white hover:bg-white/[0.06] ${FOCUS_RING_CLASS}`}>
                Show all recommendations
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/55" role="status">
          No recommendations right now. Favourite a few titles and the server will suggest similar ones.
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
