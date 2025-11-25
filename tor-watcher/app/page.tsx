"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import FilterBar from "@/components/filters/filter-bar";
import MovieGrid from "@/components/movies/movie-grid";
import SkeletonGrid from "@/components/state/skeleton-grid";
import EmptyState from "@/components/state/empty-state";
import type { MovieCard, Filters } from "@/lib/types";
import { useDebounce } from "@/lib/hooks/use-debounce";
import CarouselRow from "@/components/rails/CarouselRow";
import { Button } from "@/components/ui/button";
import { Play, Sparkles } from "lucide-react";

export type Kind = "movie" | "tv" | "anime";

const LIST_ENDPOINTS: Record<Kind, string> = {
  movie: "/api/tmdb/movie",
  tv: "/api/tmdb/tv/shows",
  anime: "/api/anime/titles",
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
  const canUseUUID = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function";
  const newId = canUseUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
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

  useEffect(() => {
    setKind(urlKind);
  }, [urlKind]);

  const updateKind = useCallback((next: Kind) => {
    if (next === kind) return;
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    sp.set("kind", next);
    sp.set("page", "1");
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [kind, pathname, router, searchParams]);

  // ===== list paging/filter state =====
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MovieCard[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);

  // ===== homepage rails (popular/trending) =====
  const [movies, setMovies] = useState<MovieCard[]>([]);
  const [moviesLoading, setMoviesLoading] = useState(true);

  const [series, setSeries] = useState<MovieCard[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);

  const [anime, setAnime] = useState<MovieCard[]>([]);
  const [animeLoading, setAnimeLoading] = useState(true);

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
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
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

  const openItem = useCallback((k: Kind, id: number) => {
    if (kind !== k) updateKind(k);
    router.push(`/title/${k}/${id}`);
  }, [kind, router, updateKind]);

  function safePrefetch(url: string) {
    try {
      const maybe = router.prefetch(url);
      if (maybe && typeof (maybe as Promise<void>).catch === "function") {
        (maybe as Promise<void>).catch(() => { /* ignore */ });
      }
    } catch (err) {
      console.warn("prefetch skipped", err);
    }
  }

  function prefetchItem(k: Kind, id: number) {
    safePrefetch(`/title/${k}/${id}`);
  }

  function handleFilterChange(next: Filters) {
    setFilters(next);
    setSkipDebounceOnce(true);
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
  }, [kind, openItem, updateKind]);

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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  const heroHighlights = [
    {
      title: "Instant playback",
      desc: "Search any movie, show, or anime and jump directly into the best available torrent stream.",
    },
    {
      title: "Continue watching",
      desc: "Stop mid-episode? Pick up exactly where you left off thanks to the persistent progress rail.",
    },
    {
      title: "Verified sources",
      desc: "Every card shown here already has seeds, so you never waste time chasing dead links.",
    },
  ];

  const browseHeading = kind === "movie" ? "Browse movies" : kind === "tv" ? "Browse series" : "Browse anime";

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
                  router.push(
                    `/see-all?title=${encodeURIComponent("Movies – Trending")}&api=${encodeURIComponent(`${LIST_ENDPOINTS.movie}?sort=trending`)}&kind=movie`,
                  )
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

      <ContinueRail />

      <div className="space-y-8">
        <CarouselRow
          title="Movies – Trending"
          subtitle="Crowd favorites with active seeds."
          accent="cyan"
          items={movies}
          loading={moviesLoading}
          onOpen={(id) => openItem("movie", id)}
          onPrefetch={(id) => prefetchItem("movie", id)}
          seeAllHref={`/see-all?title=${encodeURIComponent("Movies – Trending")}&api=${encodeURIComponent(`${LIST_ENDPOINTS.movie}?sort=trending`)}&kind=movie`}
        />

        <CarouselRow
          title="Series – Trending"
          subtitle="Season drops and binge-ready arcs."
          accent="purple"
          items={series}
          loading={seriesLoading}
          onOpen={(id) => openItem("tv", id)}
          onPrefetch={(id) => prefetchItem("tv", id)}
          seeAllHref={`/see-all?title=${encodeURIComponent("Series – Trending")}&api=${encodeURIComponent(`${LIST_ENDPOINTS.tv}?sort=trending`)}&kind=tv`}
        />

        <CarouselRow
          title="Anime – Trending"
          subtitle="Simulcasts, movies, and evergreen classics."
          accent="rose"
          items={anime}
          loading={animeLoading}
          onOpen={(id) => openItem("anime", id)}
          onPrefetch={(id) => prefetchItem("anime", id)}
          seeAllHref={`/see-all?title=${encodeURIComponent("Anime – Trending")}&api=${encodeURIComponent(`${LIST_ENDPOINTS.anime}?sort=trending`)}&kind=anime`}
        />
      </div>

    </div>
  );
}
