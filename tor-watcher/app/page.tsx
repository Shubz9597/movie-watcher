"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import FilterBar from "@/components/filters/filter-bar";
import MovieGrid from "@/components/movies/movie-grid";
import MovieQuickView from "@/components/movies/movie-quick-view";
import SkeletonGrid from "@/components/state/skeleton-grid";
import EmptyState from "@/components/state/empty-state";
import type { MovieCard, MovieDetail, Filters } from "@/lib/types";
import { useDebounce } from "@/lib/hooks/use-debounce";

type QuickViewPayload = MovieDetail & { tmdbId?: number };

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [movies, setMovies] = useState<MovieCard[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<QuickViewPayload | null>(null);
  const [quickLoading, setQuickLoading] = useState(false);

  // simple client cache across the session
  const detailCache = useRef<Map<number, MovieDetail>>(new Map());
  const inflight = useRef<Map<number, Promise<MovieDetail>>>(new Map());

  const [filters, setFilters] = useState<Filters>({
    genreId: 0,
    sort: "trending",
    quality: "any",
    yearRange: [2020, new Date().getFullYear()],
    torrentOnly: false,
    query: "", // UI-only for now
  });

  // one-shot bypass after Advanced → Apply
  const [skipDebounceOnce, setSkipDebounceOnce] = useState(false);

  const liveNonQueryKey = JSON.stringify({
    genreId: filters.genreId,
    sort: filters.sort,
    yearRange: filters.yearRange,
    torrentOnly: filters.torrentOnly,
  });

  const debouncedNonQueryKeyRaw = useDebounce(liveNonQueryKey, 600);
  const debouncedNonQueryKey = debouncedNonQueryKeyRaw || liveNonQueryKey;

  const queryParams = useMemo(() => {
    const u = new URLSearchParams();
    u.set("page", String(page));

    const src = skipDebounceOnce
      ? {
          genreId: filters.genreId,
          sort: filters.sort,
          yearRange: filters.yearRange,
          torrentOnly: filters.torrentOnly,
        }
      : (JSON.parse(debouncedNonQueryKey) as {
          genreId: number;
          sort: Filters["sort"];
          yearRange: [number, number];
          torrentOnly: boolean;
        });

    if (src.genreId) u.set("genreId", String(src.genreId));
    u.set("sort", src.sort);
    if (src.yearRange?.length === 2) {
      u.set("yearMin", String(src.yearRange[0]));
      u.set("yearMax", String(src.yearRange[1]));
    }
    if (src.torrentOnly) u.set("torrentOnly", "1");

    return u.toString();
  }, [page, debouncedNonQueryKey, skipDebounceOnce, filters.genreId, filters.sort, filters.yearRange, filters.torrentOnly]);

  useEffect(() => {
    if (skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setMovies([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipDebounceOnce]);

  useEffect(() => {
    if (!skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setMovies([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedNonQueryKey]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);

    fetch(`/api/tmdb/movies?${queryParams}`, { signal: ctrl.signal })
      .then((res) => res.json())
      .then((data) => {
        if (ctrl.signal.aborted) return;
        if (page === 1) setMovies(data.results ?? []);
        else setMovies((prev) => [...prev, ...(data.results ?? [])]);

        const pages = data.total_pages ?? 1;
        setHasMore(page < pages);
        setLoading(false);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("TMDb fetch failed", err);
        setHasMore(false);
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [page, queryParams]);

  useEffect(() => {
    if (!skipDebounceOnce) return;
    if (debouncedNonQueryKey === liveNonQueryKey) {
      setSkipDebounceOnce(false);
    }
  }, [debouncedNonQueryKey, liveNonQueryKey, skipDebounceOnce]);

  // client-side cache + in-flight de-dupe
  async function fetchDetail(id: number): Promise<MovieDetail> {
    const cached = detailCache.current.get(id);
    if (cached) return cached;

    const existing = inflight.current.get(id);
    if (existing) return existing;

    const p = (async () => {
      const res = await fetch(`/api/tmdb/movie/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data: MovieDetail = { ...json, torrents: [] };
      detailCache.current.set(id, data);
      return data;
    })();

    inflight.current.set(id, p);
    try {
      const d = await p;
      return d;
    } finally {
      inflight.current.delete(id);
    }
  }

  async function openMovie(id: number) {
    setOpen(true);
    setQuickLoading(true);
    try {
      const data = await fetchDetail(id);
      setActive({ ...data, tmdbId: id });
    } catch (e) {
      console.error("Detail fetch failed", e);
      setActive({ id, title: "Unavailable", overview: "Failed to load details.", torrents: [] } as MovieDetail);
    } finally {
      setQuickLoading(false);
    }
  }

  function prefetchMovie(id: number) {
    fetchDetail(id).catch(() => {});
  }

  return (
    <div className="space-y-4">
      <FilterBar
        value={filters}
        onChange={setFilters}
        onApply={() => setSkipDebounceOnce(true)}
      />

      {loading && page === 1 ? (
        <SkeletonGrid count={18} />
      ) : movies.length === 0 ? (
        <EmptyState
          title="No matches"
          action="Try Trending, Sci-Fi, or 4K"
          description="Try adjusting filters."
        />
      ) : (
        <>
          {/* MovieGrid should render TMDB % on cards; IMDb stays in Quick View */}
          <MovieGrid items={movies} onOpen={openMovie} onPrefetch={prefetchMovie} />

          {hasMore && !loading && (
            <div className="flex justify-center mt-4">
              <button
                className="px-6 py-2 rounded-xl bg-[#0F141A] text-slate-200 border border-slate-700 hover:bg-slate-800 transition"
                onClick={() => setPage((p) => p + 1)}
                disabled={loading}
              >
                Load More
              </button>
            </div>
          )}

          {loading && page > 1 && (
            <p className="text-center text-sm text-slate-400 mt-4">Loading more…</p>
          )}

          {!hasMore && !loading && (
            <p className="text-center text-xs text-slate-600 mt-4">You’ve reached the end.</p>
          )}
        </>
      )}

      <MovieQuickView
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setActive(null); // ✅ clear payload on close
        }}
        data={active}
        loading={quickLoading}
      />
    </div>
  );
}