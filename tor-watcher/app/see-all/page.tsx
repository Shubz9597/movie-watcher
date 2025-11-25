"use client";

import * as React from "react";
import { useSearchParams, useRouter } from "next/navigation";
import PosterCard from "@/components/movies/poster-card";
import type { MovieCard } from "@/lib/types";

type Kind = "movie" | "tv" | "anime";

type AnyListResponse =
  | MovieCard[]
  | {
      results?: MovieCard[];
      items?: MovieCard[];
      page?: number;
      total_pages?: number;
      totalPages?: number;
    };

function normalize(res: AnyListResponse) {
  if (Array.isArray(res)) return { items: res, totalPages: undefined };
  const items: MovieCard[] = res.items && res.items.length ? res.items : res.results ?? [];
  const totalPages: number | undefined = typeof res.totalPages === "number" ? res.totalPages : res.total_pages;
  return { items, totalPages };
}

// Only allow same-origin **relative** paths like "/api/xyz"; block "http://", "//", etc.
function isSafeRelativeApi(url: string) {
  return url.startsWith("/") && !url.startsWith("//");
}

function appendPageParam(api: string, page: number) {
  const hasQuery = api.includes("?");
  return `${api}${hasQuery ? "&" : "?"}page=${page}`;
}

export default function SeeAllPage() {
  const sp = useSearchParams();
  const router = useRouter();

  const title = sp.get("title") ?? "Browse";
  const api = sp.get("api") ?? ""; // <- relative API path to fetch, you pass this from the rail
  const urlKind = (sp.get("kind") as Kind) || "movie";
  const resolvedKind: Kind = urlKind === "tv" ? "tv" : urlKind === "anime" ? "anime" : "movie";

  const [page, setPage] = React.useState(1);
  const [items, setItems] = React.useState<MovieCard[]>([]);
  const [totalPages, setTotalPages] = React.useState<number | undefined>(undefined);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset when API changes
  React.useEffect(() => {
    setPage(1);
    setItems([]);
    setTotalPages(undefined);
    setError(null);
  }, [api]);

  React.useEffect(() => {
    if (!api || !isSafeRelativeApi(api)) {
      setError("Invalid or missing API for See All.");
      return;
    }
    let canceled = false;
    const controller = new AbortController();

    async function run() {
      try {
        setLoading(true);
        setError(null);
        const url = appendPageParam(api, page);
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const json = (await res.json()) as AnyListResponse;
        if (canceled) return;
        const { items: newItems, totalPages: tp } = normalize(json);
        setItems((prev) => (page === 1 ? newItems : [...prev, ...newItems]));
        if (typeof tp === "number") setTotalPages(tp);
        if (newItems.length === 0 && typeof tp !== "number") setTotalPages(page);
      } catch (e) {
        if (canceled) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        const message = e instanceof Error ? e.message : "Failed to load.";
        setError(message);
        if (page > 1) setTotalPages(page - 1);
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    run();

    return () => {
      canceled = true;
      controller.abort();
    };
  }, [api, page]);

  const canLoadMore =
    !loading &&
    api &&
    (typeof totalPages === "number" ? page < totalPages : true); // unknown total → allow until empty page stops it

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-[#050a1a] via-[#050d1d] to-[#0a1428] p-6 shadow-2xl shadow-black/50 md:flex md:items-center md:justify-between">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">See all</p>
          <h1 className="text-3xl font-semibold text-white">{title}</h1>
          <p className="text-sm text-slate-300">Curated picks filtered by your last selection.</p>
        </div>
        <div className="mt-4 flex items-center gap-2 md:mt-0">
          <button
            onClick={() => router.back()}
            className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10"
          >
            ← Back
          </button>
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-black shadow-lg shadow-cyan-500/30 hover:bg-cyan-400"
          >
            Scroll top
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900/40 bg-red-500/10 px-4 py-4 text-sm text-red-200">{error}</div>
      ) : (
        <div className="grid gap-5">
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4 sm:gap-5">
            {items.map((m, idx) => (
              <li key={`${m.id}-${idx}`}>
                <PosterCard movie={m} onOpen={() => router.push(`/title/${resolvedKind}/${m.id}`)} />
              </li>
            ))}
            {items.length === 0 && loading &&
              Array.from({ length: 12 }).map((_, i) => (
                <li key={`sk-${i}`} className="aspect-[2/3] rounded-2xl bg-slate-800/40 animate-pulse" />
              ))}
          </ul>

          <div className="flex justify-center py-3">
            {loading ? (
              <button
                disabled
                className="inline-flex items-center gap-2 rounded-full bg-cyan-500/40 px-6 py-2 text-sm font-semibold text-black/70 shadow-lg shadow-cyan-500/20"
              >
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-black/40 border-r-transparent" />
                Loading…
              </button>
            ) : canLoadMore ? (
              <button
                onClick={() => setPage((p) => p + 1)}
                className="inline-flex items-center gap-2 rounded-full bg-cyan-500 px-6 py-2 text-sm font-semibold text-black shadow-lg shadow-cyan-500/30 transition hover:bg-cyan-400"
              >
                Load more results
              </button>
            ) : (
              <p className="text-sm text-slate-400">You’ve reached the end.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
