import React, { useEffect, useState, useMemo, useRef } from 'react';
import CarouselRow from '../components/CarouselRow';
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import type { MovieCard } from '../lib/types';
import { getMovies, getTvShows } from '../lib/services/tmdb-service';
import { getTrendingAnime } from '../lib/services/anilist-service';
import { cardFromAniList, cardFromTmdbMovie, cardFromTmdbTv } from '../lib/adapters/media';
import { getContinueList } from '../lib/services/continue-service';
import { getDeviceId } from '../lib/device-id';
import { isTmdbAnime, selectAniListCatalog } from '../lib/anime-catalog';
import { loadTitlePage } from '../lib/route-loaders';

type ContinueItem = {
  seriesId: string;
  season: number;
  episode: number;
  position_s: number;
  duration_s: number;
  percent: number;
  updated_at: string;
  title: string;
  posterPath: string | null;
  year?: number;
  kind: 'movie' | 'tv' | 'anime';
  tmdbId?: number;
  malId?: number;
  anilistId?: number;
  sourceAvailable: boolean;
  sourceName?: string;
  upNext: boolean;
};

// Module-level cache to prevent duplicate calls across React Strict Mode re-renders
const continueFetchCache = new Map<string, { timestamp: number; data: ContinueItem[] }>();
const CONTINUE_CACHE_TTL = 5000; // 5 seconds cache
const catalogRequests = {
  movies: null as AbortController | null,
  tv: null as AbortController | null,
  anime: null as AbortController | null,
};

type FeaturedItem = MovieCard & { kind: 'movie' | 'tv' | 'anime' };

function buildFeaturedQueue(movies: MovieCard[], series: MovieCard[], anime: MovieCard[]): FeaturedItem[] {
  const candidates: FeaturedItem[] = [
    ...movies.slice(0, 6).map((item) => ({ ...item, kind: 'movie' as const })),
    ...series.slice(0, 6).map((item) => ({ ...item, kind: 'tv' as const })),
    ...anime.slice(0, 6).map((item) => ({ ...item, kind: 'anime' as const })),
  ].filter((item) => Boolean(item.title && item.backdropUrl));

  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }

  return candidates.slice(0, 8);
}

function preloadBackdrop(url?: string | null): Promise<void> {
  if (!url) return Promise.resolve();
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const timeout = window.setTimeout(finish, 5000);
    function finish() {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    }
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) resolve();
  });
}

function ContinueRail({ navigate }: { navigate: (path: string, params?: Record<string, string>) => void }) {
  const subjectId = useMemo(getDeviceId, []);
  const [rows, setRows] = useState<ContinueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [dismissingKey, setDismissingKey] = useState<string | null>(null);
  const fetchingRef = React.useRef(false);

  useEffect(() => {
    if (!subjectId || fetchingRef.current) return;
    
    // Check cache first
    const cached = continueFetchCache.get(subjectId);
    if (cached && Date.now() - cached.timestamp < CONTINUE_CACHE_TTL) {
      console.log('[ContinueRail] Using cached data');
      setRows(cached.data);
      setLoading(false);
      return;
    }

    const ctrl = new AbortController();
    fetchingRef.current = true;
    setLoading(true);
    console.log('[ContinueRail] Fetching continue list for:', subjectId);
    getContinueList(subjectId, 12)
      .then((xs: ContinueItem[]) => {
        if (ctrl.signal.aborted) return;
        console.log('[ContinueRail] Received', xs.length, 'items');
        // Cache the result
        continueFetchCache.set(subjectId, { timestamp: Date.now(), data: xs });
        setRows(xs);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        console.error('[ContinueRail] Error:', err);
        setRows([]);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          fetchingRef.current = false;
        }
      });
    return () => {
      ctrl.abort();
      fetchingRef.current = false;
    };
  }, [subjectId]);

  const dismiss = async (it: ContinueItem) => {
    const itemKey = `${it.seriesId}-${it.season}-${it.episode}`;
    if (dismissingKey) return;
    setDismissingKey(itemKey);
    setDismissError(null);
    try {
      const response = await fetch('http://localhost:4001/v1/continue/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectId,
          seriesId: it.seriesId,
          season: it.season,
          episode: it.episode,
        }),
      });
      if (!response.ok) throw new Error(`Dismiss failed (${response.status})`);
      setRows((items) => {
        const nextRows = items.filter((item) => !(
          item.seriesId === it.seriesId && item.season === it.season && item.episode === it.episode
        ));
        continueFetchCache.set(subjectId, { timestamp: Date.now(), data: nextRows });
        return nextRows;
      });
    } catch (error) {
      console.error('[ContinueRail] Could not remove item:', error);
      setDismissError('Could not remove that title. Check the backend connection and try again.');
    } finally {
      setDismissingKey(null);
    }
  };

  const openResumeSources = (it: ContinueItem) => {
    const isAnimeSeries = it.seriesId?.startsWith('mal:') || it.seriesId?.startsWith('anilist:');
    const kind = it.kind || (it.seriesId?.startsWith('tmdb:movie:') ? 'movie' : isAnimeSeries ? 'anime' : 'tv');
    const id = kind === 'anime' ? it.anilistId : it.tmdbId;
    if (!id) {
      console.error('[ContinueRail] Cannot open source list without a provider title id', it.seriesId);
      return;
    }

    const titleParams: Record<string, string> = {
      kind,
      id: String(id),
      resumeSubjectId: subjectId,
      resumeSeriesId: it.seriesId,
      resumeSeason: String(it.season),
      resumeEpisode: String(it.episode),
    };
    if (kind === 'anime' && it.malId) titleParams.malId = String(it.malId);
    navigate('title', titleParams);
  };

  if (loading) {
    return (
      <section className="border-t border-white/[0.08] py-8 md:py-10">
        <div className="mb-4">
          <p className="type-secondary mb-2 font-medium text-white/65">Your library</p>
          <h2 className="type-section-title text-white">Continue watching</h2>
        </div>
        <div className="hide-scrollbar flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="w-[148px] shrink-0 sm:w-[164px] md:w-[178px] xl:w-[190px]">
              <div className="aspect-[2/3] rounded-lg bg-white/[0.06] animate-pulse" />
              <div className="mt-2 flex gap-1.5">
                <div className="h-7 flex-1 animate-pulse rounded-lg bg-white/[0.05]" />
                <div className="h-7 w-8 animate-pulse rounded-lg bg-white/[0.05]" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (!rows.length) return null;

  return (
    <section className="border-t border-white/[0.08] py-8 md:py-10">
      <div className="mb-4">
        <p className="type-secondary mb-2 font-medium text-white/65">Your library</p>
        <h2 className="type-section-title text-white">Continue watching</h2>
      </div>
      {dismissError ? (
        <p className="type-body mb-4 rounded-lg border border-red-300/20 bg-red-950/30 px-4 py-3 text-red-100" role="alert">
          {dismissError}
        </p>
      ) : null}
      <div className="hide-scrollbar flex snap-x snap-mandatory gap-3.5 overflow-x-auto pb-2 md:gap-4">
        {rows.map((it) => {
          const isAnimeSeries = it.seriesId?.startsWith('mal:') || it.seriesId?.startsWith('anilist:');
          const kind = it.kind || (it.seriesId?.startsWith('tmdb:movie:') ? 'movie' : isAnimeSeries ? 'anime' : 'tv');
          const pct = Math.max(0, Math.min(100, Math.round(Number(it.percent) || 0)));
          const displayTitle = it.title || it.seriesId;
          return (
            <div
              key={`${it.seriesId}-${it.season}-${it.episode}`}
              className="group relative w-[148px] shrink-0 snap-start sm:w-[164px] md:w-[178px] xl:w-[190px]"
            >
              <button
                type="button"
                onClick={() => openResumeSources(it)}
                onPointerEnter={() => void loadTitlePage()}
                onFocus={() => void loadTitlePage()}
                className="relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] transition duration-300 group-hover:-translate-y-1 group-hover:border-white/30"
              >
                {it.posterPath ? (
                  <img
                    src={it.posterPath}
                    alt={displayTitle}
                    width="342"
                    height="513"
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.08] to-white/[0.025]">
                    <span className="text-4xl opacity-30">🎬</span>
                  </div>
                )}

                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent opacity-90" />

                <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
                  <div className="h-full bg-[#ff7a17] transition-all" style={{ width: `${pct}%` }} />
                </div>

                <div className="absolute left-2 top-2">
                  <span className="font-label text-numeric rounded-md bg-black/70 px-2 py-1 text-white/90 backdrop-blur-sm">
                    {kind !== 'movie'
                      ? `S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}`
                      : `${pct}%`}
                  </span>
                </div>

                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black">
                    <Play className="h-4 w-4 ml-0.5 fill-current" />
                  </div>
                </div>

                <div className="absolute inset-x-2 bottom-3 space-y-0.5">
                  <div className="line-clamp-2 text-sm font-medium leading-5 text-white">{displayTitle}</div>
                  {it.upNext ? (
                    <div className="type-caption text-white/70">Up next</div>
                  ) : it.year ? (
                    <div className="type-caption text-numeric text-white/70">{it.year}</div>
                  ) : null}
                </div>
              </button>

              <button
                type="button"
                className="absolute right-2 top-2 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white/70 backdrop-blur-sm transition hover:border-red-500 hover:bg-red-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-wait disabled:opacity-50"
                onClick={() => void dismiss(it)}
                disabled={Boolean(dismissingKey)}
                aria-label={`Remove ${displayTitle} from Continue watching`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function HomePage({ navigate }: { navigate: (path: string, params?: Record<string, string>) => void }) {
  const [movies, setMovies] = useState<MovieCard[]>([]);
  const [moviesLoading, setMoviesLoading] = useState(true);
  const [moviesError, setMoviesError] = useState<string | null>(null);

  const [series, setSeries] = useState<MovieCard[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  const [anime, setAnime] = useState<MovieCard[]>([]);
  const [animeLoading, setAnimeLoading] = useState(true);
  const [animeError, setAnimeError] = useState<string | null>(null);
  const [catalogReloadToken, setCatalogReloadToken] = useState(0);
  const [featuredItems, setFeaturedItems] = useState<FeaturedItem[]>([]);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [featuredUserPaused, setFeaturedUserPaused] = useState(false);
  const [featuredPointerPaused, setFeaturedPointerPaused] = useState(false);
  const [featuredFocusPaused, setFeaturedFocusPaused] = useState(false);
  const featuredMoveId = useRef(0);
  const featuredPaused = featuredUserPaused || featuredPointerPaused || featuredFocusPaused;

  useEffect(() => {
    const ac = new AbortController();

    async function loadMovies() {
      // Skip if already fetching
      if (catalogRequests.movies) {
        console.log('[HomePage] Movies request already in flight, skipping');
        return;
      }
      const requestAc = new AbortController();
      catalogRequests.movies = requestAc;
      try {
        setMoviesLoading(true);
        setMoviesError(null);
        console.log('[HomePage] Fetching movies');
        const data = await getMovies(1, 'trending');
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        const cards = (data.results || []).map(cardFromTmdbMovie);
        console.log('[HomePage] Received', cards.length, 'movies');
        setMovies(cards.filter((card: MovieCard) => !isTmdbAnime(card)));
      } catch (err) {
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        console.error('[HomePage] Error loading movies:', err);
        setMovies([]);
        setMoviesError('Movies could not be loaded. Check your connection or TMDb setting.');
      } finally {
        if (!ac.signal.aborted && !requestAc.signal.aborted) {
          setMoviesLoading(false);
        }
        catalogRequests.movies = null;
      }
    }

    async function loadTv() {
      // Skip if already fetching
      if (catalogRequests.tv) {
        console.log('[HomePage] TV request already in flight, skipping');
        return;
      }
      const requestAc = new AbortController();
      catalogRequests.tv = requestAc;
      try {
        setSeriesLoading(true);
        setSeriesError(null);
        console.log('[HomePage] Fetching TV shows');
        const data = await getTvShows(1, 'trending');
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        const cards = (data.results || []).map(cardFromTmdbTv);
        console.log('[HomePage] Received', cards.length, 'TV shows');
        setSeries(cards.filter((card: MovieCard) => !isTmdbAnime(card)));
      } catch (err) {
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        console.error('[HomePage] Error loading TV:', err);
        setSeries([]);
        setSeriesError('Series could not be loaded. Check your connection or TMDb setting.');
      } finally {
        if (!ac.signal.aborted && !requestAc.signal.aborted) {
          setSeriesLoading(false);
        }
        catalogRequests.tv = null;
      }
    }

    async function loadAnime() {
      // Skip if already fetching
      if (catalogRequests.anime) {
        console.log('[HomePage] Anime request already in flight, skipping');
        return;
      }
      const requestAc = new AbortController();
      catalogRequests.anime = requestAc;
      try {
        setAnimeLoading(true);
        setAnimeError(null);
        console.log('[HomePage] Fetching anime from AniList');
        const data = await getTrendingAnime(1);
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        const cards = selectAniListCatalog((data.media || []).map(cardFromAniList));
        console.log('[HomePage] Received', cards.length, 'AniList anime');
        setAnime(cards);
      } catch (err) {
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        console.error('[HomePage] Error loading anime:', err);
        setAnime([]);
        setAnimeError('Anime could not be loaded. Check the AniList connection, then try again.');
      } finally {
        if (!ac.signal.aborted && !requestAc.signal.aborted) {
          setAnimeLoading(false);
        }
        catalogRequests.anime = null;
      }
    }

    loadMovies();
    loadTv();
    loadAnime();

    return () => {
      ac.abort();
      // Abort any active requests
      if (catalogRequests.movies) {
        catalogRequests.movies.abort();
        catalogRequests.movies = null;
      }
      if (catalogRequests.tv) {
        catalogRequests.tv.abort();
        catalogRequests.tv = null;
      }
      if (catalogRequests.anime) {
        catalogRequests.anime.abort();
        catalogRequests.anime = null;
      }
    };
  }, [catalogReloadToken]);

  useEffect(() => {
    if (moviesLoading || seriesLoading || animeLoading) return;
    const queue = buildFeaturedQueue(movies, series, anime);
    let cancelled = false;

    void preloadBackdrop(queue[0]?.backdropUrl).then(() => {
      if (cancelled) return;
      featuredMoveId.current += 1;
      setFeaturedIndex(0);
      setFeaturedItems(queue);
      for (const item of queue.slice(1)) {
        void preloadBackdrop(item.backdropUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [movies, series, anime, moviesLoading, seriesLoading, animeLoading]);

  const featuredItem = featuredItems[featuredIndex % Math.max(featuredItems.length, 1)];
  const featuredLoading = !featuredItems.length && (moviesLoading || seriesLoading || animeLoading);

  useEffect(() => {
    if (featuredIndex >= featuredItems.length && featuredItems.length) setFeaturedIndex(0);
  }, [featuredIndex, featuredItems.length]);

  useEffect(() => {
    if (featuredPaused || featuredItems.length < 2) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (document.hidden) return;
      const moveId = featuredMoveId.current + 1;
      featuredMoveId.current = moveId;
      const nextIndex = (featuredIndex + 1) % featuredItems.length;
      void preloadBackdrop(featuredItems[nextIndex]?.backdropUrl).then(() => {
        if (!cancelled && featuredMoveId.current === moveId) setFeaturedIndex(nextIndex);
      });
    }, 8000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [featuredIndex, featuredItems, featuredPaused]);

  const moveFeatured = async (direction: -1 | 1) => {
    if (!featuredItems.length) return;
    const moveId = featuredMoveId.current + 1;
    featuredMoveId.current = moveId;
    const nextIndex = (featuredIndex + direction + featuredItems.length) % featuredItems.length;
    await preloadBackdrop(featuredItems[nextIndex]?.backdropUrl);
    if (featuredMoveId.current === moveId) setFeaturedIndex(nextIndex);
  };

  const openItem = (k: 'movie' | 'tv' | 'anime', item: MovieCard) => {
    const params: Record<string, string> = { kind: k, id: String(item.id) };
    if (k === 'anime' && item.malId) params.malId = String(item.malId);
    if (k === 'anime' && item.sourceProvider === 'tmdb') {
      params.provider = 'tmdb';
      params.mediaKind = item.sourceKind === 'movie' ? 'movie' : 'tv';
    }
    navigate('title', params);
  };

  const prefetchItem = (_k: 'movie' | 'tv' | 'anime', _item: MovieCard) => {
    void loadTitlePage();
  };

  return (
    <div>
      <section
        className="relative isolate min-h-[520px] overflow-hidden border-b border-white/[0.08] md:min-h-[610px]"
        onMouseEnter={() => setFeaturedPointerPaused(true)}
        onMouseLeave={() => setFeaturedPointerPaused(false)}
        onFocusCapture={() => setFeaturedFocusPaused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFeaturedFocusPaused(false);
          }
        }}
        aria-label="Trending highlights"
      >
        {featuredItem?.backdropUrl ? (
          <img
            key={`${featuredItem.kind}-${featuredItem.id}`}
            src={featuredItem.backdropUrl}
            alt=""
            fetchPriority="high"
            decoding="async"
            className="absolute inset-0 -z-20 h-full w-full object-cover object-center opacity-70"
          />
        ) : (
          <div className="absolute inset-0 -z-20 bg-[#151515]" />
        )}
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#0a0a0a] via-[#0a0a0a]/80 to-[#0a0a0a]/15" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-[#0a0a0a] via-transparent to-black/10" />

        <div className="mx-auto flex min-h-[520px] max-w-[1600px] items-end px-5 pb-12 pt-20 md:min-h-[610px] md:px-8 md:pb-16 xl:px-12">
          <div className="max-w-2xl">
            <p className="type-secondary mb-5 font-medium text-white/70">
              {featuredLoading
                ? 'Loading highlights'
                : `Trending now · ${featuredItem?.kind === 'tv' ? 'Series' : featuredItem?.kind === 'anime' ? 'Anime' : 'Film'}`}
            </p>
            {featuredLoading ? (
              <div aria-label="Loading featured title">
                <div className="h-16 w-3/4 animate-pulse rounded bg-white/10 md:h-20" />
                <div className="mt-6 h-4 w-full max-w-xl animate-pulse rounded bg-white/[0.07]" />
                <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-white/[0.07]" />
              </div>
            ) : (
              <>
                <h1 className="type-feature-title text-white">
                  {featuredItem?.title || 'Find your next great watch.'}
                </h1>
                <div className="type-secondary text-numeric mt-5 flex items-center gap-3 text-white/70">
                  {featuredItem?.year ? <span>{featuredItem.year}</span> : null}
                  {featuredItem?.year && typeof featuredItem?.tmdbRatingPct === 'number' ? <span>·</span> : null}
                  {typeof featuredItem?.tmdbRatingPct === 'number' ? (
                    <span>{featuredItem.tmdbRatingPct}% viewer score</span>
                  ) : null}
                </div>
                {featuredItem?.overview ? (
                  <p className="measure-compact mt-5 line-clamp-3 text-base leading-7 text-white/70 md:text-lg">
                    {featuredItem.overview}
                  </p>
                ) : null}
              </>
            )}

            <div className="mt-8 flex flex-wrap gap-3">
              {featuredItem ? (
                <button
                  type="button"
                  onClick={() => openItem(featuredItem.kind, featuredItem)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                >
                  <Play className="h-4 w-4 fill-current" />
                  View title
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const kind = featuredItem?.kind || 'movie';
                  navigate('see-all', {
                    title: kind === 'tv' ? 'Trending series' : kind === 'anime' ? 'Trending anime' : 'Trending movies',
                    api: kind === 'tv' ? 'tmdb:trending:tv' : kind === 'anime' ? 'anilist:trending:anime' : 'tmdb:trending:movie',
                    kind,
                  });
                }}
                className="group inline-flex min-h-11 items-center gap-2 rounded-full border border-white/25 bg-black/10 px-5 py-2.5 text-sm text-white transition hover:border-white/50 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
              >
                Browse {featuredItem?.kind === 'tv' ? 'series' : featuredItem?.kind === 'anime' ? 'anime' : 'movies'}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
          </div>
        </div>

        {featuredItems.length > 1 ? (
          <>
            <div className="absolute right-5 top-5 flex items-center gap-2 md:right-8 md:top-8 xl:right-12">
              <span className="font-label text-numeric mr-1 text-white/70">
                {String(featuredIndex + 1).padStart(2, '0')} / {String(featuredItems.length).padStart(2, '0')}
              </span>
              <button
                type="button"
                onClick={() => setFeaturedUserPaused((paused) => !paused)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/20 text-white/70 backdrop-blur transition hover:border-white/45 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label={featuredUserPaused ? 'Resume featured title rotation' : 'Pause featured title rotation'}
                aria-pressed={featuredUserPaused}
              >
                {featuredUserPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => void moveFeatured(-1)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/20 text-white/70 backdrop-blur transition hover:border-white/45 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label="Previous featured title"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void moveFeatured(1)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/20 text-white/70 backdrop-blur transition hover:border-white/45 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                aria-label="Next featured title"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

          </>
        ) : null}
      </section>

      <div className="mx-auto max-w-[1600px] px-5 md:px-8 xl:px-12">
        <ContinueRail navigate={navigate} />

        <div>
          <CarouselRow
          title="Movies – Trending"
          subtitle="The films getting the most attention right now."
          items={movies}
          loading={moviesLoading}
          error={moviesError}
          onRetry={() => setCatalogReloadToken((token) => token + 1)}
          onOpenSettings={() => void window.electronAPI?.openSetup()}
          onOpen={(item) => openItem('movie', item)}
          onPrefetch={(item) => prefetchItem('movie', item)}
          seeAllHref={`/see-all?title=${encodeURIComponent('Movies – Trending')}&api=${encodeURIComponent('tmdb:trending:movie')}&kind=movie`}
          navigate={navigate}
        />

          <CarouselRow
          title="Series – Trending"
          subtitle="Current favorites, from premieres to returning seasons."
          items={series}
          loading={seriesLoading}
          error={seriesError}
          onRetry={() => setCatalogReloadToken((token) => token + 1)}
          onOpenSettings={() => void window.electronAPI?.openSetup()}
          onOpen={(item) => openItem('tv', item)}
          onPrefetch={(item) => prefetchItem('tv', item)}
          seeAllHref={`/see-all?title=${encodeURIComponent('Series – Trending')}&api=${encodeURIComponent('tmdb:trending:tv')}&kind=tv`}
          navigate={navigate}
        />

          <CarouselRow
          title="Anime – Trending this season"
          subtitle="Current releases getting the most audience attention."
          items={anime}
          loading={animeLoading && !anime.length}
          error={animeError}
          onRetry={() => setCatalogReloadToken((token) => token + 1)}
          emptyMessage="Anime providers are temporarily unavailable. Reopen the app or try again shortly."
          onOpen={(item) => openItem('anime', item)}
          onPrefetch={(item) => prefetchItem('anime', item)}
          seeAllHref={`/see-all?title=${encodeURIComponent('Anime – Trending')}&api=${encodeURIComponent('anilist:trending:anime')}&kind=anime`}
          navigate={navigate}
        />
        </div>
      </div>
    </div>
  );
}



