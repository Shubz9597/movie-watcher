// SearchPage (M1.4 UI pass): full-page search replacing the old modal.
// Netflix-inspired: the page IS the search ” focused input, recent searches
// and recommendations when idle, a poster-grid of results while typing.
// Reuses the same catalog plumbing as the legacy dialog (catalogGateway +
// AniList selection + IMDb-free Basic mapping) and the same recent-searches
// storage key, so nothing is duplicated server-side.
import * as React from 'react';
import { Search, X } from 'lucide-react';
import PosterCard from '../components/PosterCard';
import { RecommendationRow } from '../components/shared/RecommendationRow';
import { PageBack } from '../components/shared/PageBack';
import { catalogGateway } from '../lib/services/catalog-gateway';
import { isTmdbAnime, selectAniListCatalog } from '../lib/anime-catalog';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
import { loadTitlePage } from '../lib/route-loaders';
import { rankSearchResults, uniqueRecentSearches } from '../lib/search-order';

type Basic = {
  id: number;
  title: string;
  year?: number;
  rating?: number | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  originalLanguage?: string;
  genreIds?: number[];
  sourceProvider?: 'tmdb' | 'anilist';
  sourceKind?: 'movie' | 'tv' | 'anime';
  sourceLabel?: string;
  malId?: number | null;
};

type SearchKind = 'movie' | 'tv' | 'anime';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;
const RECENT_STORAGE_KEY = 'moviewatcher.global-search.recent';
const MAX_RECENT = 8;

type RecentEntry = { kind: SearchKind; item: Basic; searchedAt: number };

function loadRecent(): RecentEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? uniqueRecentSearches(parsed.filter(entry =>
      entry && ['movie', 'tv', 'anime'].includes(entry.kind) && Number.isFinite(entry.searchedAt)
      && entry.item && Number.isFinite(entry.item.id) && typeof entry.item.title === 'string'), MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecent(entries: RecentEntry[]): void {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(uniqueRecentSearches(entries, MAX_RECENT)));
  } catch {
    // storage full/blocked ” recent searches are a nicety, never fatal
  }
}

// Per-source progress: the slowest API must not hold the whole grid back —
// each source's results render as they settle (progressive, not all-or-nothing).
type SourceStatus = 'idle' | 'pending' | 'ready' | 'failed';
type SourceState = { status: SourceStatus; items: Basic[] };
const IDLE_SOURCE: SourceState = { status: 'idle', items: [] };
const PENDING_SOURCE: SourceState = { status: 'pending', items: [] };
const FAILED_SOURCE: SourceState = { status: 'failed', items: [] };

export default function SearchPage(props: { navigate: (path: string, params?: Record<string, string>) => void }) {
  const { navigate } = props;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [tmdbState, setTmdbState] = React.useState<SourceState>(IDLE_SOURCE);
  const [animeState, setAnimeState] = React.useState<SourceState>(IDLE_SOURCE);
  const [recent, setRecent] = React.useState<RecentEntry[]>(() => loadRecent());

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const active = debounced.length >= MIN_CHARS;

  React.useEffect(() => {
    if (!active) {
      setTmdbState(IDLE_SOURCE);
      setAnimeState(IDLE_SOURCE);
        return;
    }
    let cancelled = false;
    setTmdbState(PENDING_SOURCE);
    setAnimeState(PENDING_SOURCE);
    const mapTmdb = (cards: NonNullable<Awaited<ReturnType<typeof catalogGateway.searchMulti>>>) => {
      const mapped: Basic[] = [];
      for (const card of [...(cards.movie ?? []), ...(cards.tv ?? [])]) {
        if (isTmdbAnime(card)) continue;
        mapped.push({
          id: card.id,
          title: card.title,
          year: card.year,
          rating: card.rating ?? null,
          posterUrl: card.posterPath ?? null,
          backdropUrl: card.backdropUrl ?? null,
          originalLanguage: card.originalLanguage,
          genreIds: card.genreIds,
          sourceProvider: 'tmdb',
          sourceKind: card.sourceKind ?? 'movie',
        });
      }
      return mapped;
    };
    const mapAnime = (items: Awaited<ReturnType<typeof catalogGateway.searchAnime>>['items']) =>
      selectAniListCatalog(
        items.map((card) => ({
          id: card.id,
          title: card.title,
          year: card.year,
          rating: card.rating ?? null,
          posterUrl: card.posterPath ?? null,
          backdropUrl: card.backdropUrl ?? null,
          originalLanguage: card.originalLanguage,
          genreIds: card.genreIds,
          sourceProvider: 'anilist' as const,
          sourceKind: 'anime' as const,
        })),
        12,
      ).map((item) => ({
        id: item.id,
        title: item.title,
        year: item.year,
        rating: item.rating ?? null,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        originalLanguage: item.originalLanguage,
        genreIds: item.genreIds,
        sourceProvider: 'anilist' as const,
        sourceKind: 'anime' as const,
      }));
    // Both searches run concurrently; each renders as IT settles, so the
    // slower source can never block the faster one behind a full-page skeleton.
    catalogGateway.searchMulti(debounced, 1).then(
      (cards) => { if (!cancelled) setTmdbState({ status: 'ready', items: mapTmdb(cards) }); },
      () => { if (!cancelled) setTmdbState(FAILED_SOURCE); },
    );
    catalogGateway.searchAnime(debounced, 1, 12).then(
      (page) => { if (!cancelled) setAnimeState({ status: 'ready', items: mapAnime(page.items) }); },
      () => { if (!cancelled) setAnimeState(FAILED_SOURCE); },
    );
    return () => { cancelled = true; };
  }, [active, debounced]);

  const searching = tmdbState.status === 'pending' || animeState.status === 'pending';
  const failedCount = (tmdbState.status === 'failed' ? 1 : 0) + (animeState.status === 'failed' ? 1 : 0);
  const results = React.useMemo(
    () => rankSearchResults([...tmdbState.items, ...animeState.items], debounced),
    [tmdbState, animeState, debounced],
  );

  // rerender-memo: read the frequently-changing values through a ref so the
  // per-item callbacks (and thus the memoized PosterCards) stay stable while
  // the user types.
  const openTitleState = React.useRef({ query, recent });
  openTitleState.current = { query, recent };
  const openTitle = React.useCallback((kind: SearchKind, item: Basic): void => {
    const { query: currentQuery, recent: currentRecent } = openTitleState.current;
    // Remember the search that produced this result (shared storage key with
    // the legacy dialog shape: kind + item + timestamp).
    if (currentQuery.trim()) {
      const entry: RecentEntry = { kind, item, searchedAt: Date.now() };
      const next = uniqueRecentSearches([entry, ...currentRecent], MAX_RECENT);
      setRecent(next);
      saveRecent(next);
    }
    void loadTitlePage();
    const params: Record<string, string> = { kind, id: String(item.id) };
    if (kind === 'anime' && item.malId) params.malId = String(item.malId);
    if (kind === 'anime' && item.sourceProvider === 'tmdb') {
      params.provider = 'tmdb';
      params.mediaKind = item.sourceKind === 'movie' ? 'movie' : 'tv';
    }
    navigate('title', params);
  }, [navigate]);

  // Stable per-item cards + callbacks: a keystroke re-renders this component,
  // but every memoized PosterCard now bails out (no fresh objects/closures).
  const cards = React.useMemo(
    () =>
      results.map((item) => {
        const kind: SearchKind =
          item.sourceProvider === 'anilist' ? 'anime' : item.sourceKind === 'tv' ? 'tv' : 'movie';
        return {
          key: `${kind}-${item.id}`,
          card: {
            id: item.id,
            title: item.title,
            posterPath: item.posterUrl ?? null,
            backdropUrl: item.backdropUrl ?? null,
            year: item.year,
            rating: item.rating ?? null,
            originalLanguage: item.originalLanguage,
            genreIds: item.genreIds,
          },
          onOpen: () => openTitle(kind, item),
        };
      }),
    [results, openTitle],
  );

  return (
    <div className="search-page mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col px-5 pt-4 md:px-8">
      <PageBack label="Home" onBack={() => navigate('home')} />

      {/* Search field: always visible, 16px (iOS no-zoom), clearable. */}
      <div className="mt-3 flex min-h-13 shrink-0 items-center gap-3 rounded-2xl border border-white/15 bg-white/[0.05] px-4 py-3 focus-within:border-white/40">
        <Search className="h-5 w-5 shrink-0 text-white/50" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Movies, series, anime…"
          aria-label="Search titles"
          className="w-full bg-transparent text-base text-white placeholder:text-white/35 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery('')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8" aria-label="Search results" role="region">
      {!active ? (
        <div className="mt-8 space-y-10">
          {recent.length ? (
            <section aria-label="Recent searches">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">Recent searches</h2>
                <button
                  type="button"
                  onClick={() => {
                    setRecent([]);
                    saveRecent([]);
                  }}
                  className="text-sm text-white/55 underline decoration-white/25 underline-offset-4 hover:text-white"
                >
                  Clear
                </button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {recent.map((entry) => (
                  <li key={`${entry.kind}-${entry.item.id}-${entry.searchedAt}`}>
                    <button
                      type="button"
                      onClick={() => openTitle(entry.kind, entry.item)}
                      className={`flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-4 text-sm text-white/85 transition hover:border-white/40 hover:text-white ${FOCUS_RING_CLASS}`}
                    >
                      <Search className="h-3.5 w-3.5 text-white/45" aria-hidden="true" />
                      <span className="max-w-[14rem] truncate">{entry.item.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {/* The recommendations fetch is the slowest call on this page; do
              not hold the idle page on its skeleton — the section pops in
              when it arrives, after the input and recents are interactive. */}
          <RecommendationRow navigate={navigate} loadingPlaceholder="none" />
        </div>
      ) : (
        <div className="mt-8">
          <div className="min-h-6 text-sm" role="status">
            {/* Progressive: partial results show while the slower source is
                still in flight — the fast source never waits behind it. */}
            {searching ? <span className="text-white/60">{results.length ? 'Showing more results…' : 'Searching…'}</span> : null}
            {!searching && failedCount === 2 ? <span className="text-[#ffc285]">Search is unavailable right now. Check the connection and retry.</span> : null}
            {!searching && failedCount === 1 ? <span className="text-[#ffc285]">Some sources could not be reached — showing what is available.</span> : null}
            {!searching && failedCount === 0 && results.length ? (
              <span className="text-white/55">{results.length} results for “{debounced}”</span>
            ) : null}
            {!searching && failedCount === 0 && !results.length ? (
              <span className="text-white/55">No results for “{debounced}”. Try a different spelling.</span>
            ) : null}
          </div>
          <ul className="search-result-grid mt-5 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-4 lg:grid-cols-7 xl:grid-cols-8">
            {cards.map(({ key, card, onOpen }) => (
              <li key={key}>
                <PosterCard movie={card} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
    </div>
  );
}

