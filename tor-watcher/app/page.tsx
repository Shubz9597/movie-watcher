"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import FilterBar from "@/components/filters/filter-bar";
import MovieGrid from "@/components/movies/movie-grid";
import MovieQuickView from "@/components/movies/movie-quick-view";
import SkeletonGrid from "@/components/state/skeleton-grid";
import EmptyState from "@/components/state/empty-state";
import type {  MovieCard, MovieDetail, Filters } from "@/lib/types";
import { useDebounce } from "@/lib/hooks/use-debounce";



export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [movies, setMovies] = useState<MovieCard[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<MovieDetail | null>(null);
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

  // One-shot bypass after Advanced → Apply (use live filters immediately once)
  const [skipDebounceOnce, setSkipDebounceOnce] = useState(false);

  // Build the *live* key for non-text filters
  const liveNonQueryKey = JSON.stringify({
    genreId: filters.genreId,
    sort: filters.sort,
    yearRange: filters.yearRange,
    torrentOnly: filters.torrentOnly,
  });

  // Debounce it
  const debouncedNonQueryKeyRaw = useDebounce(liveNonQueryKey, 600);

  // Fallback to live key on first render so we don't call bare `?page=1`
  const debouncedNonQueryKey = debouncedNonQueryKeyRaw || liveNonQueryKey;

  // Build params (use live when skipping; otherwise use debounced snapshot)
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
    u.set("sort", src.sort); // always include sort to avoid bare `?page=1`
    if (src.yearRange?.length === 2) {
      u.set("yearMin", String(src.yearRange[0]));
      u.set("yearMax", String(src.yearRange[1]));
    }
    if (src.torrentOnly) u.set("torrentOnly", "1");

    return u.toString();
  }, [
    page,
    debouncedNonQueryKey,
    skipDebounceOnce,
    filters.genreId,
    filters.sort,
    filters.yearRange,
    filters.torrentOnly,
  ]);

  // Immediate reset on Apply (so Apply fetch uses page=1 and clears list)
  useEffect(() => {
    if (skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setMovies([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipDebounceOnce]);

  // Debounced reset for normal (non-Apply) changes
  useEffect(() => {
    if (!skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setMovies([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedNonQueryKey]);

  // Fetch (IMPORTANT: do NOT depend on skipDebounceOnce)
  useEffect(() => {
  const ctrl = new AbortController();
  setLoading(true);

  fetch(`/api/tmdb/movies?${queryParams}`, { signal: ctrl.signal })
    .then((res) => res.json())
    .then((data) => {
      if (ctrl.signal.aborted) return; // ignore aborted response

      if (page === 1) setMovies(data.results ?? []);
      else setMovies((prev) => [...prev, ...(data.results ?? [])]);

      const pages = data.total_pages ?? 1;
      setTotalPages(pages);
      setHasMore(page < pages);
      setLoading(false);
    })
    .catch((err) => {
      if (err?.name === "AbortError") return; // expected
      console.error("TMDb fetch failed", err);
      setHasMore(false);
      setLoading(false);
    });

  return () => ctrl.abort();
}, [page, queryParams]);

  // Turn off skipDebounceOnce AFTER debounce catches up (no extra fetch)
  useEffect(() => {
    if (!skipDebounceOnce) return;
    if (debouncedNonQueryKey === liveNonQueryKey) {
      setSkipDebounceOnce(false);
    }
  }, [debouncedNonQueryKey, liveNonQueryKey, skipDebounceOnce]);

  
   // client-side cache + in-flight de-dupe
  async function fetchDetail(id: number): Promise<MovieDetail> {
    // serve from cache
    const cached = detailCache.current.get(id);
    if (cached) return cached;

    // de-dupe in-flight
    const existing = inflight.current.get(id);
    if (existing) return existing;

    const p = (async () => {
      const res = await fetch(`/api/tmdb/movie/${id}`); // server has LRU; let it cache
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data: MovieDetail = { ...json, torrents: [] }; // torrents later
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
 
    // Called when user clicks a card
    async function openMovie(id: number) {
    setOpen(true);
    setQuickLoading(true);
    try {
      const data = await fetchDetail(id);
      setActive(data);
    } catch (e) {
      console.error("Detail fetch failed", e);
      setActive({ id, title: "Unavailable", overview: "Failed to load details.", torrents: [] } as MovieDetail);
    } finally {
      setQuickLoading(false);
    }
  }

   // Called on hover (we won’t show the modal, just warm the cache)
  function prefetchMovie(id: number) {
    // fire-and-forget; errors are fine to ignore
    fetchDetail(id).catch(() => {});
  }

  return (
    <div className="space-y-4">
      <FilterBar
        value={filters}
        onChange={setFilters}
        onApply={() => setSkipDebounceOnce(true)} // Advanced → Apply = immediate fetch once
      />

      {loading && page === 1 ? (
        <SkeletonGrid count={18} />
      ) : movies.length === 0 ? (
        <EmptyState
          title="No matches"
          action="Try Trending, Sci-Fi, or 4K"
          description={"Try adjusting filters."}
        />
      ) : (
        <>
          <MovieGrid items={movies} onOpen={openMovie}  onPrefetch={prefetchMovie} />

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
            <p className="text-center text-xs text-slate-600 mt-4">
              You’ve reached the end.
            </p>
          )}
        </>
      )}

      <MovieQuickView open={open} onOpenChange={setOpen} data={active} loading={quickLoading} />
    </div>
  );
}