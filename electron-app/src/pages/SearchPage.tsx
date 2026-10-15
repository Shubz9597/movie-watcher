// SearchPage (M1.4 UI pass): full-page search replacing the old modal.
// Netflix-inspired: the page IS the search ” focused input, recent searches
// and recommendations when idle, a poster-grid of results while typing.
// Reuses the same catalog plumbing as the legacy dialog (catalogGateway +
// AniList selection + IMDb-free Basic mapping) and the same recent-searches
// storage key, so nothing is duplicated server-side.
import * as React from 'react';
import { History, Search, X } from 'lucide-react';
import PosterCard from '../components/PosterCard';
import { RecommendationRow } from '../components/shared/RecommendationRow';
import { catalogGateway } from '../lib/services/catalog-gateway';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
import { loadTitlePage } from '../lib/route-loaders';
import { resultLabel } from '../lib/search-franchise';
import { uniqueRecentSearches } from '../lib/search-order';

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
  /** For a TMDb-backed anime: its TMDb media type. */
  mediaKind?: 'movie' | 'tv';
  sourceLabel?: string;
  malId?: number | null;
  format?: string;
  popularity?: number;
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
        return;
    }
    let cancelled = false;
    setTmdbState(PENDING_SOURCE);
    // One search, shown in the server's order: Stremio's results first, each
    // show once (its AniList seasons fold into it). Each card keeps its own
    // provider, so a show opens as the show and an AniList-only entry as
    // that entry.
    catalogGateway.searchOrdered(debounced).then(
      (cards) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const items: Basic[] = [];
        for (const card of cards) {
          const provider = card.sourceProvider === 'anilist' ? 'anilist' as const : 'tmdb' as const;
          const key = `${provider}:${card.sourceKind}:${card.id}`;
          if (!card.id || seen.has(key)) continue;
          seen.add(key);
          items.push({
            id: card.id,
            title: card.title,
            year: card.year,
            rating: card.rating ?? null,
            posterUrl: card.posterPath ?? null,
            backdropUrl: card.backdropUrl ?? null,
            originalLanguage: card.originalLanguage,
            genreIds: card.genreIds,
            sourceProvider: provider,
            sourceKind: card.sourceKind ?? 'movie',
            mediaKind: String((card as { catalogId?: string }).catalogId ?? '').startsWith('tmdb:movie:') ? 'movie' : 'tv',
            malId: card.malId ?? null,
            format: card.format,
            popularity: card.popularity,
          });
        }
        setTmdbState({ status: 'ready', items });
      },
      () => { if (!cancelled) setTmdbState(FAILED_SOURCE); },
    );
    return () => { cancelled = true; };
  }, [active, debounced]);

  const searching = tmdbState.status === 'pending';
  const failed = tmdbState.status === 'failed';
  const results = tmdbState.items;

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
      params.mediaKind = item.mediaKind ?? (item.sourceKind === 'movie' ? 'movie' : 'tv');
    }
    navigate('title', params);
  }, [navigate]);

  // Stable per-item cards + callbacks: a keystroke re-renders this component,
  // but every memoized PosterCard now bails out (no fresh objects/closures).
  // The server's order is kept (no re-ranking or franchise regrouping);
  // each result only gets its label.
  const organized = React.useMemo(
    () => results.map((item) => ({ item, label: resultLabel(item) })),
    [results],
  );
  const cards = React.useMemo(
    () =>
      organized.map((entry) => {
        const item = entry.item;
        const kind: SearchKind =
          item.sourceProvider === 'anilist' || item.sourceKind === 'anime' ? 'anime' : item.sourceKind === 'tv' ? 'tv' : 'movie';
        return {
          key: `${kind}-${item.id}`,
          label: entry.label,
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
    [organized, openTitle],
  );

  return (
    <div className="search-page mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col px-5 pt-4 md:px-8">
      {/* Search field: always visible, 16px (iOS no-zoom), clearable. */}
      <div className="mt-1 flex min-h-12 shrink-0 items-center gap-3 rounded-lg border border-white/15 bg-white/[0.05] pl-4 pr-1 focus-within:border-white/40">
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
          className="min-h-12 w-full bg-transparent text-base text-white placeholder:text-white/50 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery('')}
            className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white/70 hover:text-white ${FOCUS_RING_CLASS}`}
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
                  className={`min-h-12 rounded-lg px-2 text-sm text-white/70 hover:text-white ${FOCUS_RING_CLASS}`}
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
                      className={`flex min-h-12 items-center gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-4 text-sm text-white/85 transition hover:border-white/40 hover:text-white ${FOCUS_RING_CLASS}`}
                    >
                      <History className="h-4 w-4 text-white/50" aria-hidden="true" />
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
            {!searching && failed ? <span className="text-[#ffc285]">Search is unavailable.</span> : null}
            {!searching && !failed && results.length ? (
              <span className="text-white/60">Results for “{debounced}”</span>
            ) : null}
            {!searching && !failed && !results.length ? (
              <span className="text-white/60">No results for “{debounced}”</span>
            ) : null}
          </div>
          <ul className="search-result-grid mt-5 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-4 lg:grid-cols-7 xl:grid-cols-8">
            {cards.map((entry) => (
              <li key={entry.key}>
                <PosterCard movie={entry.card} label={entry.label} onOpen={entry.onOpen} />
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
    </div>
  );
}

