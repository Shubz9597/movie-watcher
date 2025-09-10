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
import CarouselRow from "@/components/rails/CarouselRow";

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

// ===================== Continue Rail (new) =====================

const VOD = "http://localhost:4001";

type ContinueItem = {
  seriesId: string;
  season: number;
  episode: number;
  position_s: number;
  duration_s: number;
  percent: number;         // 0..100
  updated_at: string;      // ISO
};

function kindFromSeriesId(seriesId: string): "movie" | "tv" | "anime" {
  if (seriesId.startsWith("tmdb:movie:")) return "movie";
  if (seriesId.startsWith("tmdb:tv:")) return "tv";
  if (seriesId.startsWith("mal:") || seriesId.startsWith("anilist:")) return "anime";
  return "tv";
}

function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  const KEY = "mw_device_id";
  const existing = localStorage.getItem(KEY);
  if (existing && existing !== "null" && existing !== "undefined") {
    return existing;
  }
  const newId =
    (crypto as any)?.randomUUID?.() ??
    (Math.random().toString(36).slice(2) + Date.now().toString(36));
  localStorage.setItem(KEY, newId);
  return newId;
}

function ContinueRail() {
  const router = useRouter();
  const subjectId = useMemo(getDeviceId, []);
  const [rows, setRows] = useState<ContinueItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!subjectId) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`${VOD}/v1/continue?subjectId=${encodeURIComponent(subjectId)}&limit=12`, { signal: ctrl.signal, cache: "no-store" })
      .then(r => r.json())
      .then((xs: ContinueItem[]) => setRows(xs))
      .catch(() => { })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [subjectId]);

  const dismiss = async (it: ContinueItem) => {
    await fetch(`${VOD}/v1/continue/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subjectId,
        seriesId: it.seriesId,
        season: it.season,
        episode: it.episode,
      }),
    }).catch(() => { });
    setRows(xs => xs.filter(x => !(x.seriesId === it.seriesId && x.season === it.season && x.episode === it.episode)));
  };

  const resumeWeb = async (it: ContinueItem) => {
    const kind = kindFromSeriesId(it.seriesId);
    try {
      const body = {
        seriesId: it.seriesId,
        seriesTitle: "",
        kind,
        season: kind === "movie" ? 0 : it.season,
        episode: kind === "movie" ? 0 : it.episode,
        profileHash: "caps:h264|v1",
        estRuntimeMin: kind === "movie" ? 120 : 42,
      };
      const res = await fetch(`${VOD}/v1/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("start failed");
      const json = await res.json();
      const magnet: string = json?.pick?.magnet || "";
      const fileIndex: number | undefined = json?.pick?.fileIndex ?? undefined;

      const qs = new URLSearchParams();
      if (magnet) qs.set("src", magnet);
      if (fileIndex != null) qs.set("fileIndex", String(fileIndex));
      qs.set("cat", kind);
      qs.set("seriesId", it.seriesId);
      qs.set("season", String(it.season));
      qs.set("episode", String(it.episode));
      router.push(`/watch?${qs.toString()}`);
    } catch (e) {
      console.error("resume web failed", e);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="text-base font-semibold">Continue watching</div>
        <div className="flex gap-3 overflow-x-auto">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="w-[220px] h-[110px] rounded-xl bg-slate-800/40 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!rows.length) return null;

  return (
    <div className="space-y-2">
      <div className="text-base font-semibold">Continue watching</div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {rows.map((it) => {
          const kind = kindFromSeriesId(it.seriesId);
          const pct = Math.round(it.percent);
          return (
            <div
              key={`${it.seriesId}-${it.season}-${it.episode}`}
              className="min-w-[260px] max-w-[260px] rounded-xl bg-[#0F141A] border border-slate-800 p-3 flex flex-col gap-2"
            >
              <div className="text-sm font-medium truncate" title={it.seriesId}>
                {it.seriesId}
              </div>
              <div className="text-xs opacity-70">
                {kind !== "movie"
                  ? <>S{String(it.season).padStart(2, "0")}E{String(it.episode).padStart(2, "0")} · {pct}%</>
                  : <>{pct}%</>
                }
              </div>
              <div className="h-1 w-full bg-slate-800 rounded overflow-hidden">
                <div className="h-full bg-cyan-600" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center gap-2 mt-1">
                <button
                  className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-500"
                  onClick={() => void resumeWeb(it)}
                >
                  Resume
                </button>
                <a
                  className="px-3 py-1.5 rounded-md bg-slate-700 text-white text-xs hover:bg-slate-600"
                  href={`${VOD}/v1/resume.m3u?subjectId=${encodeURIComponent(subjectId)}&seriesId=${encodeURIComponent(it.seriesId)}&kind=${kind}`}
                  download
                >
                  Open in VLC
                </a>
                <button
                  className="ml-auto px-2 py-1 rounded-md bg-slate-800 text-slate-300 text-xs hover:bg-slate-700"
                  onClick={() => void dismiss(it)}
                  title="Remove from Continue"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =================== End Continue Rail (new) ===================

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

  // Freeze detail-prefetch around kind switches to prevent accidental id calls
  const [prefetchFreeze, setPrefetchFreeze] = useState(false);

  useEffect(() => {
    setKind(urlKind);
    // freeze prefetch briefly after kind changes (covers both click and URL changes)
    setPrefetchFreeze(true);
    const t = setTimeout(() => setPrefetchFreeze(false), 800);
    return () => clearTimeout(t);
  }, [urlKind]);

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

  // ===== homepage rails (popular/trending) =====
  const [movies, setMovies] = useState<MovieCard[]>([]);
  const [moviesLoading, setMoviesLoading] = useState(true);

  const [series, setSeries] = useState<MovieCard[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);

  const [anime, setAnime] = useState<MovieCard[]>([]);
  const [animeLoading, setAnimeLoading] = useState(true);

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

  // reset page + items on filter/kind changes (avoid empty-state flicker by setting loading immediately)
  useEffect(() => {
    if (skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setItems([]);
      setLoading(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipDebounceOnce]);

  useEffect(() => {
    if (!skipDebounceOnce) {
      if (page !== 1) setPage(1);
      setItems([]);
      setLoading(true);
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
    fetchDetailFor(k, id).catch(() => { });
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

  useEffect(() => {
    const ac = new AbortController();

    async function loadRow<T extends MovieCard[]>(
      url: string,
      setData: (xs: MovieCard[]) => void,
      setBusy: (b: boolean) => void
    ) {
      try {
        setBusy(true);
        const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
        const j = await res.json().catch(() => ({}));
        setData(Array.isArray(j?.results) ? j.results as MovieCard[] : []);
      } catch {
        setData([]);
      } finally {
        setBusy(false);
      }
    }

    const mURL = `${LIST_ENDPOINTS.movie}?page=1&sort=trending`;
    const sURL = `${LIST_ENDPOINTS.tv}?page=1&sort=trending`;
    const aURL = `${LIST_ENDPOINTS.anime}?page=1&sort=trending`;

    loadRow(mURL, setMovies, setMoviesLoading);
    loadRow(sURL, setSeries, setSeriesLoading);
    loadRow(aURL, setAnime, setAnimeLoading);

    return () => ac.abort();
  }, []); // run once on mount

  return (
    <div className="space-y-6">
      {/* NEW: Continue rail at the very top */}
      <ContinueRail />

      <div className="space-y-8">
        <CarouselRow
          title="Movies – Trending"
          items={movies}
          loading={moviesLoading}
          onOpen={(id) => openItem("movie", id)}
          onPrefetch={(id) => prefetchItem("movie", id)}
          seeAllHref={`/see-all?title=${encodeURIComponent("Movies – Trending")}&api=${encodeURIComponent(`${LIST_ENDPOINTS.movie}?sort=trending`)}`}
        />

        <CarouselRow
          title="Series – Trending"
          items={series}
          loading={seriesLoading}
          onOpen={(id) => openItem("tv", id)}
          onPrefetch={(id) => prefetchItem("tv", id)}
          seeAllHref={`/see-all?title=${encodeURIComponent("Series – Trending")}&api=${encodeURIComponent(`${LIST_ENDPOINTS.tv}?sort=trending`)}`}
        />

        <CarouselRow
          title="Anime – Trending"
          items={anime}
          loading={animeLoading}
          onOpen={(id) => openItem("anime", id)}
          onPrefetch={(id) => prefetchItem("anime", id)}
          seeAllHref={`/see-all?title=${encodeURIComponent("Anime – Trending")}&api=${encodeURIComponent(`${LIST_ENDPOINTS.anime}?sort=trending`)}`}
        />
      </div>

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
