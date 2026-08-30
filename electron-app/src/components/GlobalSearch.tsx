import * as React from 'react';
import { Clapperboard, Film, History, LoaderCircle, MonitorPlay, RefreshCw, Tv } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { cardFromAniList, cardFromTmdbMovie, cardFromTmdbTv, type Card } from '../lib/adapters/media';
import { isTmdbAnime, selectAniListCatalog } from '../lib/anime-catalog';
import { loadSeeAllPage, loadTitlePage } from '../lib/route-loaders';

type SearchKind = 'movie' | 'tv' | 'anime';
type ResultFilter = 'all' | SearchKind;
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
type SearchResults = Record<SearchKind, Basic[]>;
type SuggestedTitle = { kind: SearchKind; item: Basic };
type RecentSearch = SuggestedTitle & { searchedAt: number };

const EMPTY_RESULTS: SearchResults = { movie: [], tv: [], anime: [] };
const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;
const MAX_ITEMS_PER_GROUP = 6;
const MAX_RECENT_SEARCHES = 4;
const SUGGESTION_COUNT = 4;
const RECENT_STORAGE_KEY = 'moviewatcher.global-search.recent';

const GENRES = [
  { label: 'Action', movie: 28, tv: 10759 },
  { label: 'Comedy', movie: 35, tv: 35 },
  { label: 'Crime', movie: 80, tv: 80 },
  { label: 'Drama', movie: 18, tv: 18 },
  { label: 'Mystery', movie: 9648, tv: 9648 },
  { label: 'Sci-fi', movie: 878, tv: 10765 },
] as const;

const RESULT_FILTERS: Array<{ value: ResultFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'Series' },
  { value: 'anime', label: 'Anime' },
];

class LRU<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly max = 50) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }
}

const cache = new LRU<string, SearchResults>();

export default function GlobalSearch({
  navigate,
  open,
  onOpenChange,
}: {
  navigate: (path: string, params?: Record<string, string>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResults>(EMPTY_RESULTS);
  const [resultFilter, setResultFilter] = React.useState<ResultFilter>('all');
  const [genreKind, setGenreKind] = React.useState<'movie' | 'tv'>('movie');
  const [recentSearches, setRecentSearches] = React.useState<RecentSearch[]>(loadRecentSearches);
  const [suggestions, setSuggestions] = React.useState<SuggestedTitle[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = React.useState(false);
  const [suggestionShuffle, setSuggestionShuffle] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const latestRequest = React.useRef(0);

  React.useEffect(() => {
    if (!open) return;
    const nextQuery = query.trim();
    if (nextQuery.length < MIN_CHARS) {
      setDebouncedQuery('');
      setResults(EMPTY_RESULTS);
      setResultFilter('all');
      setError(null);
      setLoading(false);
      return;
    }

    const timer = window.setTimeout(() => setDebouncedQuery(nextQuery), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void (async () => {
      setSuggestionsLoading(true);
      const [{ getMovies, getTvShows }, { getTrendingAnime }] = await Promise.all([
        import('../lib/services/tmdb-service'),
        import('../lib/services/anilist-service'),
      ]);
      const [movieResult, tvResult, animeResult] = await Promise.allSettled([
        getMovies(1, 'trending'),
        getTvShows(1, 'trending'),
        getTrendingAnime(1, 12),
      ]);

      if (cancelled) return;

      const pool: SuggestedTitle[] = [];
      if (movieResult.status === 'fulfilled') {
        pool.push(...(movieResult.value.results || [])
          .map(cardFromTmdbMovie)
          .filter((item: Card) => !isTmdbAnime(item))
          .slice(0, 10)
          .map((item: Card) => ({ kind: 'movie' as const, item: basicFromCard(item) })));
      }
      if (tvResult.status === 'fulfilled') {
        pool.push(...(tvResult.value.results || [])
          .map(cardFromTmdbTv)
          .filter((item: Card) => !isTmdbAnime(item))
          .slice(0, 10)
          .map((item: Card) => ({ kind: 'tv' as const, item: basicFromCard(item) })));
      }
      if (animeResult.status === 'fulfilled') {
        pool.push(...selectAniListCatalog((animeResult.value.media || []).map(cardFromAniList), 10)
          .map((item: Card) => ({ kind: 'anime' as const, item: basicFromCard(item) })));
      }

      setSuggestions(pickSuggestions(pool));
      setSuggestionsLoading(false);
    })().catch((reason: unknown) => {
      if (cancelled) return;
      console.error('[GlobalSearch] Suggestions failed:', reason);
      setSuggestions([]);
      setSuggestionsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [open, suggestionShuffle]);

  React.useEffect(() => {
    if (!open || debouncedQuery.length < MIN_CHARS) return;

    const cacheKey = debouncedQuery.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached) {
      setResults(cached);
      setLoading(false);
      return;
    }

    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;

    void (async () => {
      setLoading(true);
      setError(null);
      const [{ searchMulti }, { searchAnime }] = await Promise.all([
        import('../lib/services/tmdb-service'),
        import('../lib/services/anilist-service'),
      ]);
      const [tmdbResult, animeResult] = await Promise.allSettled([
        searchMulti(debouncedQuery, 1),
        searchAnime(debouncedQuery, 1, MAX_ITEMS_PER_GROUP),
      ]);

      if (latestRequest.current !== requestId) return;

      const tmdbMovies: Basic[] = tmdbResult.status === 'fulfilled'
        ? (tmdbResult.value.movie ?? []).map((item: Basic) => ({ ...item, title: item.title || 'Untitled' }))
        : [];
      const tmdbTv: Basic[] = tmdbResult.status === 'fulfilled'
        ? (tmdbResult.value.tv ?? []).map((item: Basic) => ({ ...item, title: item.title || 'Untitled' }))
        : [];
      const aniListAnime: Basic[] = animeResult.status === 'fulfilled'
        ? (animeResult.value.media ?? []).map((item) => ({
            id: item.id,
            title: item.title?.english || item.title?.userPreferred || item.title?.romaji || item.title?.native || 'Untitled',
            year: item.startDate?.year || undefined,
            rating: typeof item.averageScore === 'number' ? item.averageScore / 10 : undefined,
            posterUrl: item.coverImage?.large || item.coverImage?.extraLarge || item.coverImage?.medium || null,
            originalLanguage: item.countryOfOrigin?.toLocaleLowerCase() || undefined,
            genreIds: [16],
            sourceProvider: 'anilist',
            sourceKind: 'anime',
            sourceLabel: 'AniList',
            malId: item.idMal ?? null,
          }))
        : [];

      const nextResults: SearchResults = {
        movie: tmdbMovies.filter((item) => !isTmdbAnime(item)).slice(0, MAX_ITEMS_PER_GROUP),
        tv: tmdbTv.filter((item) => !isTmdbAnime(item)).slice(0, MAX_ITEMS_PER_GROUP),
        anime: selectAniListCatalog(aniListAnime, MAX_ITEMS_PER_GROUP),
      };
      const failedSources = [tmdbResult, animeResult].filter((result) => result.status === 'rejected').length;
      if (failedSources === 2) {
        setError('Search is unavailable. Check your connection or Settings.');
      } else if (failedSources === 1) {
        setError('Some sources could not be reached. Showing the results that are available.');
      }

      setResults(nextResults);
      cache.set(cacheKey, nextResults);
      setLoading(false);
    })().catch((reason: unknown) => {
      if (latestRequest.current !== requestId) return;
      console.error('[GlobalSearch] Search failed:', reason);
      setError('Search is unavailable. Check your connection or Settings.');
      setResults(EMPTY_RESULTS);
      setLoading(false);
    });
  }, [open, debouncedQuery]);

  const reset = () => {
    setQuery('');
    setDebouncedQuery('');
    setResults(EMPTY_RESULTS);
    setResultFilter('all');
    setLoading(false);
    setError(null);
  };

  const remember = (kind: SearchKind, item: Basic) => {
    setRecentSearches((current) => {
      const next = [
        { kind, item, searchedAt: Date.now() },
        ...current.filter((entry) => recentKey(entry.kind, entry.item) !== recentKey(kind, item)),
      ].slice(0, MAX_RECENT_SEARCHES);
      saveRecentSearches(next);
      return next;
    });
  };

  const closeAndNavigate = (kind: SearchKind, item: Basic) => {
    remember(kind, item);
    void loadTitlePage();
    onOpenChange(false);
    reset();
    const params: Record<string, string> = { kind, id: String(item.id) };
    if (kind === 'anime' && item.malId) params.malId = String(item.malId);
    if (kind === 'anime' && item.sourceProvider === 'tmdb') {
      params.provider = 'tmdb';
      params.mediaKind = item.sourceKind === 'movie' ? 'movie' : 'tv';
    }
    navigate('title', params);
  };

  const closeAndBrowse = (title: string, api: string, kind: SearchKind) => {
    void loadSeeAllPage();
    onOpenChange(false);
    reset();
    navigate('see-all', { title, api, kind });
  };

  const clearRecent = () => {
    setRecentSearches([]);
    saveRecentSearches([]);
  };

  const hasResults = results.movie.length + results.tv.length + results.anime.length > 0;
  const visibleKinds: SearchKind[] = resultFilter === 'all' ? ['movie', 'tv', 'anime'] : [resultFilter];
  const visibleCount = visibleKinds.reduce((count, kind) => count + results[kind].length, 0);
  const showDiscovery = query.trim().length < MIN_CHARS;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[8vh] max-h-[84vh] w-[calc(100%-2rem)] max-w-4xl translate-y-0 gap-0 overflow-hidden rounded-xl border-white/15 bg-[#0c0c0c] p-0 shadow-none sm:max-w-4xl"
      >
        <DialogTitle className="sr-only">Search the TorWatch library</DialogTitle>
        <DialogDescription className="sr-only">
          Search across movies, series, and anime, or browse recent titles, suggestions, and genres.
        </DialogDescription>

        <Command shouldFilter={false} className="rounded-none bg-transparent text-white [&_[cmdk-group-heading]]:font-label [&_[cmdk-group-heading]]:px-5 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-white/60">
          <div className="border-b border-white/[0.08] px-2 py-2">
            <CommandInput
              autoFocus
              aria-label="Search movies, series, and anime"
              placeholder="Search a title, cast, or keyword"
              className="h-14 text-base text-white placeholder:text-white/60"
              value={query}
              onValueChange={setQuery}
            />
          </div>

          <CommandList aria-busy={loading} className="app-scrollbar max-h-[67vh] overflow-y-auto px-2 pb-2">
            {showDiscovery ? (
              <>
                <section className="border-b border-white/[0.08] px-3 py-4" aria-labelledby="recent-searches-heading">
                  <div className="mb-2 flex min-h-8 items-center justify-between gap-4 px-2">
                    <h2 id="recent-searches-heading" className="type-secondary font-medium text-white/80">Recent searches</h2>
                    {recentSearches.length ? (
                      <button type="button" onClick={clearRecent} className="min-h-8 rounded-full px-2.5 text-xs text-white/60 transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50">
                        Clear
                      </button>
                    ) : null}
                  </div>
                  {recentSearches.length ? (
                    <div className="grid gap-1 sm:grid-cols-2">
                      {recentSearches.map((entry) => (
                        <CommandItem
                          key={recentKey(entry.kind, entry.item)}
                          value={`recent-${recentKey(entry.kind, entry.item)}`}
                          onSelect={() => closeAndNavigate(entry.kind, entry.item)}
                          className="rounded-lg px-2 py-2.5 text-white/75 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/55">
                            <History className="h-4 w-4" strokeWidth={1.7} />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">{entry.item.title}</span>
                          <span className="type-caption text-white/55">{kindLabel(entry.kind)}</span>
                        </CommandItem>
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-white/60">
                      <History className="h-4 w-4 shrink-0" strokeWidth={1.7} />
                      Titles you open from search will stay here for a quick return.
                    </div>
                  )}
                </section>

                <section className="border-b border-white/[0.08] px-3 py-5" aria-labelledby="suggested-titles-heading">
                  <div className="mb-3 flex items-start justify-between gap-4 px-2">
                    <div>
                      <h2 id="suggested-titles-heading" className="type-secondary font-medium text-white/80">Worth a look</h2>
                      <p className="type-caption mt-1 text-white/55">Shuffled from titles trending this week.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSuggestionShuffle((value) => value + 1)}
                      disabled={suggestionsLoading}
                      className="flex min-h-9 items-center gap-2 rounded-full border border-white/12 px-3 text-xs text-white/65 transition hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-wait disabled:opacity-45"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Shuffle
                    </button>
                  </div>

                  {suggestionsLoading ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="status" aria-label="Loading suggestions">
                      {Array.from({ length: SUGGESTION_COUNT }, (_, index) => (
                        <div key={index} className="animate-pulse overflow-hidden rounded-lg bg-white/[0.04]">
                          <div className="aspect-[16/10] bg-white/[0.07]" />
                          <div className="space-y-2 p-3">
                            <div className="h-3 w-4/5 rounded bg-white/10" />
                            <div className="h-2.5 w-2/5 rounded bg-white/[0.06]" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : suggestions.length ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {suggestions.map(({ kind, item }) => (
                        <CommandItem
                          key={`suggestion-${recentKey(kind, item)}`}
                          value={`suggestion-${recentKey(kind, item)}`}
                          onSelect={() => closeAndNavigate(kind, item)}
                          className="group flex-col items-stretch gap-0 overflow-hidden rounded-lg bg-white/[0.035] p-0 data-[selected=true]:bg-white/[0.09]"
                        >
                          <div className="aspect-[16/10] overflow-hidden bg-[#181818]">
                            {item.backdropUrl || item.posterUrl ? (
                              <img src={item.backdropUrl || item.posterUrl || ''} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover object-center opacity-85 transition duration-200 group-data-[selected=true]:opacity-100" />
                            ) : (
                              <div className="flex h-full items-center justify-center text-white/25">{kindIcon(kind, 'h-5 w-5')}</div>
                            )}
                          </div>
                          <div className="min-w-0 p-3">
                            <p className="truncate text-sm text-white/85">{item.title}</p>
                            <p className="type-caption mt-1 text-white/55">{kindLabel(kind)}{item.year ? ` · ${item.year}` : ''}</p>
                          </div>
                        </CommandItem>
                      ))}
                    </div>
                  ) : (
                    <p className="px-2 py-3 text-sm text-white/60">Trending suggestions are unavailable right now. Search still works above.</p>
                  )}
                </section>

                <section className="px-3 py-5" aria-labelledby="browse-library-heading">
                  <h2 id="browse-library-heading" className="type-secondary px-2 font-medium text-white/80">Browse the library</h2>
                  <div className="mt-3 grid overflow-hidden rounded-lg border border-white/[0.09] sm:grid-cols-3 sm:divide-x sm:divide-white/[0.09]">
                    <BrowseCollection icon={Film} title="All movies" description="Popular films" onSelect={() => closeAndBrowse('Popular movies', 'tmdb:popular:movie', 'movie')} />
                    <BrowseCollection icon={Tv} title="All series" description="Popular shows" onSelect={() => closeAndBrowse('Popular series', 'tmdb:popular:tv', 'tv')} />
                    <BrowseCollection icon={MonitorPlay} title="All anime" description="Popular anime" onSelect={() => closeAndBrowse('Popular anime', 'anilist:popular:anime', 'anime')} />
                  </div>

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 px-2">
                    <div>
                      <h3 className="text-sm text-white/75">Find by genre</h3>
                      <p className="type-caption mt-1 text-white/50">Open a full collection, ranked by popularity.</p>
                    </div>
                    <div className="flex rounded-full bg-white/[0.05] p-1" role="group" aria-label="Genre collection type">
                      {(['movie', 'tv'] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => setGenreKind(kind)}
                          aria-pressed={genreKind === kind}
                          className={`min-h-8 rounded-full px-3 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${genreKind === kind ? 'bg-white text-black' : 'text-white/60 hover:text-white'}`}
                        >
                          {kind === 'movie' ? 'Movies' : 'Series'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 px-2">
                    {GENRES.map((genre) => (
                      <CommandItem
                        key={`${genreKind}-${genre.label}`}
                        value={`genre-${genreKind}-${genre.label}`}
                        onSelect={() => closeAndBrowse(`${genre.label} ${genreKind === 'movie' ? 'movies' : 'series'}`, `tmdb:genre:${genreKind}:${genre[genreKind]}`, genreKind)}
                        className="min-h-10 rounded-full border border-white/12 px-4 text-sm text-white/70 data-[selected=true]:border-white/35 data-[selected=true]:bg-white/[0.08] data-[selected=true]:text-white"
                      >
                        {genre.label}
                      </CommandItem>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {!showDiscovery && hasResults ? (
              <div className="sticky top-0 z-10 flex gap-1 border-b border-white/[0.08] bg-[#0c0c0c] px-5 py-3" role="group" aria-label="Filter search results">
                {RESULT_FILTERS.map((filter) => {
                  const count = filter.value === 'all' ? results.movie.length + results.tv.length + results.anime.length : results[filter.value].length;
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      onClick={() => setResultFilter(filter.value)}
                      aria-pressed={resultFilter === filter.value}
                      className={`min-h-9 rounded-full px-3 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 ${resultFilter === filter.value ? 'bg-white text-black' : 'text-white/60 hover:bg-white/[0.06] hover:text-white'}`}
                    >
                      {filter.label} <span className="text-numeric opacity-65">{count}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {loading && !hasResults ? (
              <div className="type-body flex items-center justify-center gap-2 py-14 text-white/65">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Searching every library…
              </div>
            ) : null}

            {!loading && !showDiscovery && !hasResults && !error ? (
              <CommandEmpty>
                <div className="px-4 py-12 text-center">
                  <p className="type-body text-white/75">No matches for “{query.trim()}”</p>
                  <p className="type-secondary mt-2 text-white/60">Try a shorter title or a different spelling.</p>
                </div>
              </CommandEmpty>
            ) : null}

            {!loading && hasResults && visibleCount === 0 ? (
              <div className="px-4 py-12 text-center">
                <p className="type-body text-white/75">No {resultFilter === 'tv' ? 'series' : resultFilter} matches</p>
                <button type="button" onClick={() => setResultFilter('all')} className="mt-3 min-h-10 rounded-full border border-white/15 px-4 text-sm text-white/70 hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50">
                  View all results
                </button>
              </div>
            ) : null}

            {error ? (
              <div className="flex items-center justify-between gap-4 px-5 py-3 text-[#ffc285]">
                <p className="type-secondary">{error}</p>
                {!hasResults ? (
                  <button
                    type="button"
                    onClick={() => void window.electronAPI?.openSetup()}
                    className="min-h-10 shrink-0 rounded-full border border-white/20 px-4 text-sm text-white/80 hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                  >
                    Open settings
                  </button>
                ) : null}
              </div>
            ) : null}

            {visibleKinds.includes('movie') ? <ResultGroup heading="Movies" icon={Clapperboard} kind="movie" items={results.movie} query={query} onSelect={closeAndNavigate} /> : null}
            {visibleKinds.includes('tv') ? <ResultGroup heading="Series" icon={Tv} kind="tv" items={results.tv} query={query} onSelect={closeAndNavigate} /> : null}
            {visibleKinds.includes('anime') ? <ResultGroup heading="Anime" icon={MonitorPlay} kind="anime" items={results.anime} query={query} onSelect={closeAndNavigate} /> : null}
          </CommandList>

          <div className="font-label flex items-center gap-5 border-t border-white/[0.08] px-5 py-3 text-xs text-white/55">
            <span>↑↓ Navigate</span>
            <span>Enter Open</span>
            <span className="ml-auto">Esc Close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function BrowseCollection({ icon: Icon, title, description, onSelect }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={`browse-${title}`} onSelect={onSelect} className="min-h-16 rounded-none border-b border-white/[0.09] px-4 py-3 text-white/75 last:border-b-0 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white sm:border-b-0">
      <Icon className="h-4 w-4 text-white/45" />
      <span>
        <span className="block text-sm">{title}</span>
        <span className="type-caption mt-0.5 block text-white/50">{description}</span>
      </span>
    </CommandItem>
  );
}

function ResultGroup({ heading, icon: Icon, kind, items, query, onSelect }: {
  heading: string;
  icon: React.ComponentType<{ className?: string }>;
  kind: SearchKind;
  items: Basic[];
  query: string;
  onSelect: (kind: SearchKind, item: Basic) => void;
}) {
  if (!items.length) return null;

  return (
    <CommandGroup heading={heading}>
      {items.map((item) => (
        <CommandItem
          key={`${kind}-${item.sourceProvider || 'unknown'}-${item.sourceKind || kind}-${item.id}`}
          value={`${kind}-${item.sourceProvider || 'unknown'}-${item.sourceKind || kind}-${item.id}-${item.title}`}
          onSelect={() => onSelect(kind, item)}
          className="group rounded-lg px-3 py-2.5 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-white"
        >
          <div className="h-14 w-10 shrink-0 overflow-hidden rounded border border-white/10 bg-[#171717]">
            {item.posterUrl ? (
              <img src={item.posterUrl} alt="" width="40" height="56" loading="lazy" decoding="async" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-white/20"><Icon className="h-4 w-4" /></div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-white/85">{highlight(item.title, query)}</p>
            <div className="type-caption text-numeric mt-1 flex items-center gap-2 text-white/60">
              {item.year ? <span>{item.year}</span> : null}
              {item.year && typeof item.rating === 'number' ? <span>·</span> : null}
              {typeof item.rating === 'number' ? <span>{item.rating.toFixed(1)}</span> : null}
            </div>
          </div>
          <span className="font-label text-white/55 transition group-data-[selected=true]:text-white/85">{kindLabel(kind)}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function basicFromCard(card: Card): Basic {
  return {
    id: card.id,
    title: card.title || 'Untitled',
    year: card.year,
    rating: card.rating,
    posterUrl: card.posterPath,
    backdropUrl: card.backdropUrl,
    originalLanguage: card.originalLanguage,
    genreIds: card.genreIds,
    sourceProvider: card.sourceProvider,
    sourceKind: card.sourceKind,
    sourceLabel: card.sourceLabel,
    malId: card.malId,
  };
}

function recentKey(kind: SearchKind, item: Basic) {
  return `${kind}-${item.sourceProvider || 'unknown'}-${item.sourceKind || kind}-${item.id}`;
}

function kindLabel(kind: SearchKind) {
  if (kind === 'tv') return 'Series';
  if (kind === 'anime') return 'Anime';
  return 'Movie';
}

function kindIcon(kind: SearchKind, className: string) {
  if (kind === 'tv') return <Tv className={className} />;
  if (kind === 'anime') return <MonitorPlay className={className} />;
  return <Clapperboard className={className} />;
}

function shuffle<T>(items: T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function pickSuggestions(items: SuggestedTitle[]): SuggestedTitle[] {
  const firstFromEachKind = (['movie', 'tv', 'anime'] as const)
    .map((kind) => shuffle(items.filter((entry) => entry.kind === kind))[0])
    .filter((entry): entry is SuggestedTitle => Boolean(entry));
  const selectedKeys = new Set(firstFromEachKind.map((entry) => recentKey(entry.kind, entry.item)));
  const remaining = shuffle(items.filter((entry) => !selectedKeys.has(recentKey(entry.kind, entry.item))));
  return shuffle([...firstFromEachKind, ...remaining.slice(0, SUGGESTION_COUNT - firstFromEachKind.length)]);
}

function loadRecentSearches(): RecentSearch[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentSearch).slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

function saveRecentSearches(searches: RecentSearch[]) {
  try {
    if (searches.length) {
      window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(searches));
    } else {
      window.localStorage.removeItem(RECENT_STORAGE_KEY);
    }
  } catch {
    // Search remains usable if local storage is unavailable.
  }
}

function isRecentSearch(value: unknown): value is RecentSearch {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RecentSearch>;
  return (
    (candidate.kind === 'movie' || candidate.kind === 'tv' || candidate.kind === 'anime')
    && typeof candidate.searchedAt === 'number'
    && Boolean(candidate.item)
    && typeof candidate.item?.id === 'number'
    && typeof candidate.item?.title === 'string'
  );
}

function highlight(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (index < 0 || !query.trim()) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-transparent text-[#ffc285]">{text.slice(index, index + query.trim().length)}</mark>
      {text.slice(index + query.trim().length)}
    </>
  );
}
