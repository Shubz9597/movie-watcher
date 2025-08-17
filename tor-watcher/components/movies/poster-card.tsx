// components/movies/poster-card.tsx
"use client";

import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MovieCard } from "@/lib/types";
import { useRef } from "react";
import { Flame } from "lucide-react";

const PREFETCH_DELAY_MS = 300;

export default function PosterCard({
  movie,
  onOpen,
  onPrefetch,
}: {
  movie: MovieCard;
  onOpen: (id: number) => void;
  onPrefetch?: (id: number) => void;
}) {
  const timerRef = useRef<number | null>(null);

  const startPrefetchTimer = () => {
    if (!onPrefetch || timerRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onPrefetch?.(movie.id);
    }, PREFETCH_DELAY_MS);
  };
  const clearPrefetchTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const topCast =
    movie.topCast && movie.topCast.length
      ? movie.topCast.slice(0, 3).join(", ")
      : null;

  const tmdbPct =
    typeof movie.tmdbRatingPct === "number"
      ? movie.tmdbRatingPct
      : typeof movie.rating === "number"
      ? Math.round(movie.rating * 10)
      : undefined;

  const lang = (movie.originalLanguage || "en").toUpperCase();

  return (
    <button
      type="button"
      onClick={() => onOpen(movie.id)}
      onMouseEnter={startPrefetchTimer}
      onMouseLeave={clearPrefetchTimer}
      onFocus={startPrefetchTimer}
      onBlur={clearPrefetchTimer}
      aria-label={`Open quick view for ${movie.title}`}
      className="group text-left focus:outline-none"
    >
      <Card className="overflow-hidden rounded-2xl border-slate-800 bg-[#0F141A] ring-1 ring-slate-800
                       transition hover:scale-[1.02] hover:ring-cyan-600/40 focus:ring-2 focus:ring-cyan-500">
        {/* Poster */}
        <div className="relative aspect-[2/3] w-full">
          <Image
            src={movie.posterPath ?? "/placeholder.svg"}
            alt={movie.title}
            fill
            sizes="(max-width: 640px) 45vw, (max-width: 1024px) 22vw, 14vw"
            className="object-cover transition-opacity group-hover:opacity-90"
            priority={false}
          />

          {/* TL: NEW + language (hide EN) */}
          <div className="absolute left-2 top-2 flex flex-col gap-1 items-start">
            {movie.isNew && (
              <Badge className="bg-cyan-500 text-black hover:bg-cyan-400">NEW</Badge>
            )}
            {lang !== "EN" && (
              <span className="rounded-md bg-black/70 px-2 py-[2px] text-[11px] text-white border border-white/10">
                {lang}
              </span>
            )}
          </div>

          {/* TR: TMDB % and 🔥 popularity */}
          <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
            {typeof tmdbPct === "number" && (
              <span
                title="TMDB User Score (vote_average × 10)"
                className="rounded-md bg-black/70 px-2 py-[2px] text-[11px] font-medium text-white border border-white/10"
              >
                🔥 {tmdbPct}%
              </span>
            )}
            {typeof movie.tmdbPopularity === "number" && (
              <span
                title="TMDB Popularity"
                className="rounded-md bg-black/70 px-2 py-[2px] text-[11px] text-white border border-white/10 inline-flex items-center gap-1"
              >
                <Flame className="h-3 w-3" />
                {Math.round(movie.tmdbPopularity)}
              </span>
            )}
          </div>
        </div>

        {/* Text */}
        <CardContent className="px-3 py-3 text-slate-300">
          <div className="flex items-baseline justify-between gap-2">
            <span className="line-clamp-1 text-sm font-medium text-slate-100">
              {movie.title}
            </span>
            {movie.year && (
              <span className="shrink-0 text-[11px] text-slate-400">{movie.year}</span>
            )}
          </div>
          {topCast && (
            <div className="mt-1 line-clamp-1 text-[12px] text-slate-400">{topCast}</div>
          )}
        </CardContent>
      </Card>
    </button>
  );
}
