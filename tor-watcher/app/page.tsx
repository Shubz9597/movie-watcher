"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import FilterBar from "@/components/filters/filter-bar";
import MovieGrid from "@/components/movies/movie-grid";
import MovieQuickView from "@/components/movies/movie-quick-view";
import SkeletonGrid from "@/components/state/skeleton-grid";
import EmptyState from "@/components/state/empty-state";
import type { MovieCard, MovieDetail, Filters } from "@/lib/types";
import { useDebounce } from "@/lib/hooks/use-debounce";

export type Kind = "movie" | "tv" | "anime";

type QuickViewPayload = (MovieDetail & { tmdbId?: number }) | null;

const LIST_ENDPOINTS: Record<Kind, string> = {
  movie: "/api/tmdb/movie",
  tv: "/api/tmdb/tv",
  anime: "/api/anime/titles",
};

const DETAIL_ENDPOINTS: Record<Kind, string> = {
  movie: "/api/tmdb/movie",
  tv: "/api/tmdb/tv",
  anime: "/api/anime/title",
};

function SegmentedKind({ kind, onChange }: { kind: Kind; onChange: (k: Kind) => void }) {
  const btn = (k: Kind, label: string) => (
    <button
      key={k}
      type="button"
      onClick={() => onChange(k)}
      className={[
        "px-3 py-1.5 text-sm rounded-xl transition",
        "ring-1",
        k === kind
          ? "bg-cyan-600/20 text-cyan-200 ring-cyan-500/40"
          : "bg-[#0F141A] text-slate-300 ring-slate-800 hover:bg-slate-800/40",
      ].join(" ")}
      aria-pressed={k === kind}
    >
      {label}
    </button>
  );

  return (
    <div className="inline-flex items-center gap-1 rounded-2xl bg-[#0B0F14] p-1 ring-1 ring-slate-800">
      {btn("movie", "Movies")}
      {btn("tv", "TV Shows")}
      {btn("anime", "Anime")}
    </div>
  );
}

export default function HomePage() {
  // ===== URL-driven kind =====
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const urlKind = (searchParams.get("kind") as Kind) || "movie";
  const [kind, setKind] = useState<Kind>(urlKind);
  useEffect(() => setKind(urlKind), [urlKind]);

  function updateKind(next: Kind) {
    if (next === kind) return;
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    sp.set("kind", next);
    sp.set("page", "1");
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }

  // ===== list paging/filter state =====
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MovieCard[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<QuickViewPayload>(null);
  const [activeKind, setActiveKind] = useState<Kind>("movie");
  const [quickLoading, setQuickLoading] = useState(false);

  // simple client cache across the session (per kind)
  const detailCache = useRef<Map<string, MovieDetail>>(new Map());
  const inflight = useRef<Map<string, Promise<MovieDetail>>>(new Map());

  const [filters, setFilters] = useState<Filters>({
    genreId: 0,
    sort: "trending",
    quality: "any",
    yearRange: [2020, new Date().getFullYear()],
    torrentOnly: false,
    query: "",
  });

  const [skipDebounceOnce, setSkipDebounceOnce] = useState(false);

  const liveNonQueryKey = JSON.stringify({
    genreId: filters.genreId,
    sort: filters.sort,
    yearRange: filters.yearRange,
    torrentOnly: filters.torrentOnly,
    kind,
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
          kind,
        }
      : (JSON.parse(debouncedNonQueryKey) as {
          genreId: number;
          sort: Filters["sort"];
          yearRange: [number, number];
          torrentOnly: boolean;
          kind: Kind;
        });

    if (src.genreId) u.set("genreId", String(src.genreId));
    u.set("sort", src.sort);
    if (src.yearRange?.length === 2) {
      u.set("yearMin", String(src.yearRange[0]));
      u.set("yearMax", String(src.yearRange[1]));
    }
    if (src.torrentOnly) u.set("torrentOnly", "1");

    const q = filters.query.trim();
    if (q) u.set("query", q);

    return u.toString();
  }, [page, debouncedNonQueryKey, skipDebounceOnce, filters.genreId, filters.sort, filters.yearRange, filters.torrentOnly, filters.query, kind]);

  // reset page + items on filter/kind changes
  useEffect(() => {
    if (skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipDebounceOnce]);

  useEffect(() => {
    if (!skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedNonQueryKey]);

  // fetch list (uses kind-specific endpoint)
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);

    fetch(`${LIST_ENDPOINTS[kind]}?${queryParams}`, { signal: ctrl.signal })
      .then((res) => res.json())
      .then((data) => {
        if (ctrl.signal.aborted) return;
        const results: MovieCard[] = data?.results ?? [];
        if (page === 1) setItems(results);
        else setItems((prev) => [...prev, ...results]);

        const pages = data?.total_pages ?? 1;
        setHasMore(page < pages);
        setLoading(false);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("List fetch failed", err);
        setHasMore(false);
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [page, queryParams, kind]);

  useEffect(() => {
    if (!skipDebounceOnce) return;
    if (debouncedNonQueryKey === liveNonQueryKey) setSkipDebounceOnce(false);
  }, [debouncedNonQueryKey, liveNonQueryKey, skipDebounceOnce]);

  // client-side cache + in-flight de-dupe (keyed by kind:id)
  async function fetchDetailFor(k: Kind, id: number): Promise<MovieDetail> {
    const key = `${k}:${id}`;
    const cached = detailCache.current.get(key);
    if (cached) return cached;

    const existing = inflight.current.get(key);
    if (existing) return existing;

    const p = (async () => {
      const base = DETAIL_ENDPOINTS[k];
      const res = await fetch(`${base}/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data: MovieDetail = { ...json, torrents: [] };
      detailCache.current.set(key, data);
      return data;
    })();

    inflight.current.set(key, p);
    try {
      const d = await p;
      return d;
    } finally {
      inflight.current.delete(key);
    }
  }

  async function openItem(k: Kind, id: number) {
    setActiveKind(k);
    setOpen(true);
    setQuickLoading(true);
    try {
      const data = await fetchDetailFor(k, id);
      setActive({ ...data, tmdbId: id });
    } catch (e) {
      console.error("Detail fetch failed", e);
      setActive({ id, title: "Unavailable", overview: "Failed to load details.", torrents: [] } as MovieDetail);
    } finally {
      setQuickLoading(false);
    }
  }

  function prefetchItem(k: Kind, id: number) {
    fetchDetailFor(k, id).catch(() => {});
  }

  // Wire up search dialog events (open-movie/open-tv)
  useEffect(() => {
    const onOpenMovie = (e: Event) => {
      const ce = e as CustomEvent<{ id: number }>; const id = ce.detail?.id;
      if (typeof id === "number") {
        if (kind !== "movie") updateKind("movie");
        openItem("movie", id);
      }
    };
    const onOpenTv = (e: Event) => {
      const ce = e as CustomEvent<{ id: number }>; const id = ce.detail?.id;
      if (typeof id === "number") {
        if (kind !== "tv") updateKind("tv");
        openItem("tv", id);
      }
    };

    window.addEventListener("open-movie", onOpenMovie as EventListener);
    window.addEventListener("open-tv", onOpenTv as EventListener);
    return () => {
      window.removeEventListener("open-movie", onOpenMovie as EventListener);
      window.removeEventListener("open-tv", onOpenTv as EventListener);
    };
  }, [kind]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <SegmentedKind kind={kind} onChange={updateKind} />
      </div>

      <FilterBar value={filters} onChange={setFilters} onApply={() => setSkipDebounceOnce(true)} />

      {loading && page === 1 ? (
        <SkeletonGrid count={18} />
      ) : items.length === 0 ? (
        <EmptyState title="No matches" action="Try Trending, Sci‑Fi, or 4K" description="Try adjusting filters." />
      ) : (
        <>
          <MovieGrid items={items} onOpen={(id) => openItem(kind, id)} onPrefetch={(id) => prefetchItem(kind, id)} />

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
          if (!v) setActive(null);
        }}
        data={active}
        loading={quickLoading}
        kind={activeKind}
      />
    </div>
  );
}