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

export default function SearchPage(props: { navigate: (path: string, params?: Record<string, string>) => void }) {
  const { navigate } = props;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [results, setResults] = React.useState<Basic[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
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
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      const [tmdbResult, animeResult] = await Promise.allSettled([
        catalogGateway.searchMulti(debounced, 1),
        catalogGateway.searchAnime(debounced, 1, 12),
      ]);
      if (cancelled) return;
      const merged: Basic[] = [];
      if (tmdbResult.status === 'fulfilled') {
        for (const card of [...(tmdbResult.value.movie ?? []), ...(tmdbResult.value.tv ?? [])]) {
          if (isTmdbAnime(card)) continue;
          merged.push({
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
      }
      if (animeResult.status === 'fulfilled') {
        for (const item of selectAniListCatalog(
          animeResult.value.items.map((card) => ({
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
        )) {
          merged.push(item);
        }
      }
      const failed = [tmdbResult, animeResult].filter((r) => r.status === 'rejected').length;
      if (failed === 2) setError('Search is unavailable right now. Check the connection and retry.');
      else if (failed === 1) setError('Some sources could not be reached ” showing what is available.');
      setResults(rankSearchResults(merged, debounced));
      setLoading(false);
    })().catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError('Search failed. Check the connection and retry.');
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, debounced]);

  const openTitle = (kind: SearchKind, item: Basic): void => {
    // Remember the search that produced this result (shared storage key with
    // the legacy dialog shape: kind + item + timestamp).
    if (query.trim()) {
      const entry: RecentEntry = { kind, item, searchedAt: Date.now() };
      const next = uniqueRecentSearches([entry, ...recent], MAX_RECENT);
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
  };

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
          <RecommendationRow navigate={navigate} />
        </div>
      ) : (
        <div className="mt-8">
          <div className="min-h-6 text-sm" role="status">
            {loading ? <span className="text-white/60">Searching…</span> : null}
            {!loading && error ? <span className="text-[#ffc285]">{error}</span> : null}
            {!loading && !error && results.length ? (
              <span className="text-white/55">{results.length} results for “{debounced}”</span>
            ) : null}
            {!loading && !error && !results.length ? (
              <span className="text-white/55">No results for “{debounced}”. Try a different spelling.</span>
            ) : null}
          </div>
          <ul className="search-result-grid mt-5 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 md:grid-cols-6 md:gap-x-4 lg:grid-cols-7 xl:grid-cols-8">
            {results.map((item) => {
              const kind: SearchKind =
                item.sourceProvider === 'anilist' ? 'anime' : item.sourceKind === 'tv' ? 'tv' : 'movie';
              const card = {
                id: item.id,
                title: item.title,
                posterPath: item.posterUrl ?? null,
                backdropUrl: item.backdropUrl ?? null,
                year: item.year,
                rating: item.rating ?? null,
                originalLanguage: item.originalLanguage,
                genreIds: item.genreIds,
              };
              return (
                <li key={`${kind}-${item.id}`}>
                  <PosterCard movie={card} onOpen={() => openTitle(kind, item)} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      </div>
    </div>
  );
}
