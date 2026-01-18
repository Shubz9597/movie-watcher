import React, { useEffect, useState, useMemo, useRef } from 'react';
import CarouselRow from '../components/CarouselRow';
import { Button } from '../components/ui/button';
import { Play, Sparkles } from 'lucide-react';
import type { MovieCard } from '../lib/types';
import { getMovies, getTvShows } from '../lib/services/tmdb-service';
import { getAnimeList, searchAnime } from '../lib/services/jikan-service';
import { cardFromTmdbMovie, cardFromTmdbTv, cardFromJikan } from '../lib/adapters/media';
import { getContinueList } from '../lib/services/continue-service';

function getDeviceId(): string {
  const KEY = 'mw_device_id';
  const existing = localStorage.getItem(KEY);
  if (existing && existing !== 'null' && existing !== 'undefined') {
    return existing;
  }
  const canUseUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const newId = canUseUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem(KEY, newId);
  return newId;
}

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
};

// Module-level cache to prevent duplicate calls across React Strict Mode re-renders
const continueFetchCache = new Map<string, { timestamp: number; data: ContinueItem[] }>();
const CONTINUE_CACHE_TTL = 5000; // 5 seconds cache

function ContinueRail({ navigate }: { navigate: (path: string, params?: Record<string, string>) => void }) {
  const subjectId = useMemo(getDeviceId, []);
  const [rows, setRows] = useState<ContinueItem[]>([]);
  const [loading, setLoading] = useState(true);
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
    await fetch('http://localhost:4001/v1/continue/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId,
        seriesId: it.seriesId,
        season: it.season,
        episode: it.episode,
      }),
    }).catch(() => {});
    setRows((xs) =>
      xs.filter((x) => !(x.seriesId === it.seriesId && x.season === it.season && x.episode === it.episode))
    );
  };

  const resumeWeb = async (it: ContinueItem) => {
    const kind = it.kind || (it.seriesId?.startsWith('tmdb:movie:') ? 'movie' : it.seriesId?.startsWith('mal:') ? 'anime' : 'tv');
    try {
      const body = {
        seriesId: it.seriesId,
        seriesTitle: '',
        kind,
        season: kind === 'movie' ? 0 : it.season,
        episode: kind === 'movie' ? 0 : it.episode,
        profileHash: 'caps:h264|v1',
        estRuntimeMin: kind === 'movie' ? 120 : 42,
      };
      const res = await fetch('http://localhost:4001/v1/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('start failed');
      const json = await res.json();
      const magnet: string = json?.pick?.magnet || '';
      const fileIndex: number | undefined = json?.pick?.fileIndex ?? undefined;

      const params: Record<string, string> = {
        cat: kind,
        seriesId: it.seriesId,
        season: String(it.season),
        episode: String(it.episode),
        title: it.title || 'Unknown',
      };
      if (magnet) params.magnet = magnet;
      if (fileIndex != null) params.fileIndex = String(fileIndex);
      navigate('watch', params);
    } catch (e) {
      console.error('resume web failed', e);
    }
  };

  if (loading) {
    return (
      <section className="rounded-3xl border border-white/10 bg-gradient-to-br from-[#0a1520] via-[#060d14] to-[#040810] p-5 md:p-7 shadow-2xl shadow-black/30">
        <div className="mb-4">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Pick up where you left off</p>
          <h2 className="text-2xl font-semibold text-white">Continue Watching</h2>
        </div>
        <div className="flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="min-w-[180px] max-w-[180px] flex-shrink-0">
              <div className="aspect-[2/3] rounded-2xl bg-slate-800/40 animate-pulse" />
              <div className="mt-2 flex gap-1.5">
                <div className="flex-1 h-7 rounded-lg bg-slate-800/40 animate-pulse" />
                <div className="w-8 h-7 rounded-lg bg-slate-800/40 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (!rows.length) return null;

  return (
    <section className="rounded-3xl border border-white/10 bg-gradient-to-br from-[#0a1520] via-[#060d14] to-[#040810] p-5 md:p-7 shadow-2xl shadow-black/30">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Pick up where you left off</p>
        <h2 className="text-2xl font-semibold text-white">Continue Watching</h2>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-700">
        {rows.map((it) => {
          const kind = it.kind || (it.seriesId?.startsWith('tmdb:movie:') ? 'movie' : it.seriesId?.startsWith('mal:') ? 'anime' : 'tv');
          const pct = Math.round(it.percent);
          const displayTitle = it.title || it.seriesId;
          return (
            <div
              key={`${it.seriesId}-${it.season}-${it.episode}`}
              className="group relative min-w-[180px] max-w-[180px] flex-shrink-0"
            >
              <button
                type="button"
                onClick={() => void resumeWeb(it)}
                className="relative aspect-[2/3] w-full overflow-hidden rounded-2xl border border-slate-800/60 bg-[#0b111f] shadow-lg shadow-black/40 transition-all duration-300 group-hover:-translate-y-1 group-hover:border-cyan-500/40"
              >
                {it.posterPath ? (
                  <img
                    src={it.posterPath}
                    alt={displayTitle}
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
                    <span className="text-4xl opacity-30">🎬</span>
                  </div>
                )}

                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent opacity-90" />

                <div className="absolute inset-x-0 bottom-0 h-1 bg-slate-800/80">
                  <div className="h-full bg-cyan-500 transition-all" style={{ width: `${pct}%` }} />
                </div>

                <div className="absolute left-2 top-2">
                  <span className="rounded-md bg-black/70 px-2 py-1 text-[10px] font-medium text-white/90 backdrop-blur-sm">
                    {kind !== 'movie'
                      ? `S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}`
                      : `${pct}%`}
                  </span>
                </div>

                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-cyan-500/90 text-black shadow-lg shadow-cyan-500/30">
                    <Play className="h-5 w-5 ml-0.5" />
                  </div>
                </div>

                <div className="absolute inset-x-2 bottom-3 space-y-0.5">
                  <div className="text-sm font-semibold leading-tight text-white line-clamp-2">{displayTitle}</div>
                  {it.year && <div className="text-[10px] text-slate-300">{it.year}</div>}
                </div>
              </button>

              <div className="mt-2 flex items-center gap-1.5">
                <a
                  className="flex-1 rounded-lg bg-slate-800/80 px-2 py-1.5 text-center text-[10px] font-medium text-slate-300 hover:bg-slate-700 transition-colors"
                  href={`http://localhost:4001/v1/resume.m3u?subjectId=${encodeURIComponent(subjectId)}&seriesId=${encodeURIComponent(it.seriesId)}&kind=${kind}`}
                  download
                  title="Open in VLC"
                >
                  VLC
                </a>
                <button
                  className="rounded-lg bg-slate-800/80 px-2 py-1.5 text-[10px] font-medium text-slate-400 hover:bg-red-900/50 hover:text-red-300 transition-colors"
                  onClick={() => void dismiss(it)}
                  title="Remove from Continue"
                >
                  ✕
                </button>
              </div>
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

  const [series, setSeries] = useState<MovieCard[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);

  const [anime, setAnime] = useState<MovieCard[]>([]);
  const [animeLoading, setAnimeLoading] = useState(true);

  // Module-level request tracking to prevent duplicate calls (persists across React Strict Mode)
  const activeRequests = {
    movies: null as AbortController | null,
    tv: null as AbortController | null,
    anime: null as AbortController | null,
  };

  useEffect(() => {
    const ac = new AbortController();

    async function loadMovies() {
      // Skip if already fetching
      if (activeRequests.movies) {
        console.log('[HomePage] Movies request already in flight, skipping');
        return;
      }
      const requestAc = new AbortController();
      activeRequests.movies = requestAc;
      try {
        setMoviesLoading(true);
        console.log('[HomePage] Fetching movies');
        const data = await getMovies(1, 'trending');
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        const cards = (data.results || []).map(cardFromTmdbMovie);
        console.log('[HomePage] Received', cards.length, 'movies');
        setMovies(cards);
      } catch (err) {
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        console.error('[HomePage] Error loading movies:', err);
        setMovies([]);
      } finally {
        if (!ac.signal.aborted && !requestAc.signal.aborted) {
          setMoviesLoading(false);
        }
        activeRequests.movies = null;
      }
    }

    async function loadTv() {
      // Skip if already fetching
      if (activeRequests.tv) {
        console.log('[HomePage] TV request already in flight, skipping');
        return;
      }
      const requestAc = new AbortController();
      activeRequests.tv = requestAc;
      try {
        setSeriesLoading(true);
        console.log('[HomePage] Fetching TV shows');
        const data = await getTvShows(1, 'trending');
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        const cards = (data.results || []).map(cardFromTmdbTv);
        console.log('[HomePage] Received', cards.length, 'TV shows');
        setSeries(cards);
      } catch (err) {
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        console.error('[HomePage] Error loading TV:', err);
        setSeries([]);
      } finally {
        if (!ac.signal.aborted && !requestAc.signal.aborted) {
          setSeriesLoading(false);
        }
        activeRequests.tv = null;
      }
    }

    async function loadAnime() {
      // Skip if already fetching
      if (activeRequests.anime) {
        console.log('[HomePage] Anime request already in flight, skipping');
        return;
      }
      const requestAc = new AbortController();
      activeRequests.anime = requestAc;
      try {
        setAnimeLoading(true);
        console.log('[HomePage] Fetching anime');
        const data = await getAnimeList(1, 'bypopularity');
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        const cards = ((data.data || []) as any[]).map(cardFromJikan);
        console.log('[HomePage] Received', cards.length, 'anime');
        setAnime(cards);
      } catch (err) {
        if (ac.signal.aborted || requestAc.signal.aborted) return;
        console.error('[HomePage] Error loading anime:', err);
        setAnime([]);
      } finally {
        if (!ac.signal.aborted && !requestAc.signal.aborted) {
          setAnimeLoading(false);
        }
        activeRequests.anime = null;
      }
    }

    loadMovies();
    loadTv();
    loadAnime();

    return () => {
      ac.abort();
      // Abort any active requests
      if (activeRequests.movies) {
        activeRequests.movies.abort();
        activeRequests.movies = null;
      }
      if (activeRequests.tv) {
        activeRequests.tv.abort();
        activeRequests.tv = null;
      }
      if (activeRequests.anime) {
        activeRequests.anime.abort();
        activeRequests.anime = null;
      }
    };
  }, []);

  const heroHighlights = [
    {
      title: 'Instant playback',
      desc: 'Search any movie, show, or anime and jump directly into the best available torrent stream.',
    },
    {
      title: 'Continue watching',
      desc: 'Stop mid-episode? Pick up exactly where you left off thanks to the persistent progress rail.',
    },
    {
      title: 'Verified sources',
      desc: 'Every card shown here already has seeds, so you never waste time chasing dead links.',
    },
  ];

  const openItem = (k: 'movie' | 'tv' | 'anime', id: number) => {
    navigate('title', { kind: k, id: String(id) });
  };

  const prefetchItem = (k: 'movie' | 'tv' | 'anime', id: number) => {
    // Prefetch logic if needed
  };

  return (
    <div className="space-y-10">
      <section className="rounded-3xl border border-white/10 bg-gradient-to-br from-[#050a1a] via-[#060c1f] to-[#0b142b] p-6 shadow-2xl shadow-black/40 md:p-10">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="flex-1 space-y-4">
            <div className="inline-flex items-center gap-2 text-sm font-medium text-cyan-300">
              <Sparkles className="h-4 w-4" />
              Curated torrents, always online.
            </div>
            <h1 className="text-4xl font-semibold text-white md:text-5xl">
              Find something binge-worthy in seconds.
            </h1>
            <p className="text-base text-slate-300 md:text-lg">
              We aggregate TMDb metadata with live torrent availability, so every card you see is ready to stream.
              Jump back in or discover a new obsession.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                className="rounded-2xl bg-cyan-500 px-6 py-3 text-base font-semibold text-black shadow-lg shadow-cyan-500/30 hover:bg-cyan-400"
                onClick={() =>
                  navigate('see-all', {
                    title: 'Movies – Trending',
                    api: 'tmdb:trending:movie',
                    kind: 'movie',
                  })
                }
              >
                <Play className="mr-2 h-4 w-4" />
                Watch something now
              </Button>
            </div>
          </div>
          <div className="grid flex-1 gap-4 text-sm text-white sm:grid-cols-2">
            {heroHighlights.map((item) => (
              <div key={item.title} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4">
                <div className="text-base font-semibold">{item.title}</div>
                <p className="mt-1 text-slate-200 text-sm leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ContinueRail navigate={navigate} />

      <div className="space-y-8">
        <CarouselRow
          title="Movies – Trending"
          subtitle="Crowd favorites with active seeds."
          accent="cyan"
          items={movies}
          loading={moviesLoading}
          onOpen={(id) => openItem('movie', id)}
          onPrefetch={(id) => prefetchItem('movie', id)}
          seeAllHref={`/see-all?title=${encodeURIComponent('Movies – Trending')}&api=${encodeURIComponent('tmdb:trending:movie')}&kind=movie`}
          navigate={navigate}
        />

        <CarouselRow
          title="Series – Trending"
          subtitle="Season drops and binge-ready arcs."
          accent="purple"
          items={series}
          loading={seriesLoading}
          onOpen={(id) => openItem('tv', id)}
          onPrefetch={(id) => prefetchItem('tv', id)}
          seeAllHref={`/see-all?title=${encodeURIComponent('Series – Trending')}&api=${encodeURIComponent('tmdb:trending:tv')}&kind=tv`}
          navigate={navigate}
        />

        <CarouselRow
          title="Anime – Trending"
          subtitle="Simulcasts, movies, and evergreen classics."
          accent="rose"
          items={anime}
          loading={animeLoading}
          onOpen={(id) => openItem('anime', id)}
          onPrefetch={(id) => prefetchItem('anime', id)}
          seeAllHref={`/see-all?title=${encodeURIComponent('Anime – Trending')}&api=${encodeURIComponent('jikan:top:anime')}&kind=anime`}
          navigate={navigate}
        />
      </div>
    </div>
  );
}



