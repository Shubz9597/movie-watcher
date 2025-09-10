"use client";

import * as React from "react";
import { useSearchParams, useRouter } from "next/navigation";
import PosterCard from "@/components/movies/poster-card";
import type { MovieCard } from "@/lib/types";

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
  if (Array.isArray(res)) return { items: res as MovieCard[], totalPages: undefined };
  const obj = res as any;
  const items: MovieCard[] = obj.items ?? obj.results ?? [];
  const totalPages: number | undefined = obj.totalPages ?? obj.total_pages;
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
        const json: AnyListResponse = await res.json();
        if (canceled) return;
        const { items: newItems, totalPages: tp } = normalize(json);
        setItems((prev) => (page === 1 ? newItems : [...prev, ...newItems]));
        if (typeof tp === "number") setTotalPages(tp);
        // If backend doesn't return total pages, we'll rely on "Load more" until a page returns 0.
        if (newItems.length === 0 && typeof tp !== "number") setTotalPages(page); // stop further loads
      } catch (e: any) {
        if (canceled || e?.name === "AbortError") return;
        setError(e?.message ?? "Failed to load.");
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
    <div className="space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-slate-100">
          {title}
        </h1>
        <button
          onClick={() => router.back()}
          className="text-sm md:text-base text-slate-300 hover:text-white"
        >
          ← Back
        </button>
      </div>

      {/* Grid */}
      {error ? (
        <div className="text-sm text-red-400">{error}</div>
      ) : (
        <ul className="grid gap-4 sm:gap-5 grid-cols-[repeat(auto-fill,minmax(168px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(196px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {items.map((m) => (
            <li key={m.id}>
              <PosterCard movie={m} onOpen={() => router.push(`/title/${m.id}`)} />
            </li>
          ))}
          {/* Initial skeletons */}
          {items.length === 0 && loading &&
            Array.from({ length: 12 }).map((_, i) => (
              <li key={`sk-${i}`} className="aspect-[2/3] rounded-2xl bg-slate-800/40 animate-pulse" />
            ))}
        </ul>
      )}

      {/* Load more */}
      <div className="flex justify-center py-4">
        {canLoadMore ? (
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-slate-800 text-slate-100 hover:bg-slate-700 disabled:opacity-60"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
