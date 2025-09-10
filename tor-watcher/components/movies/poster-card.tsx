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
      aria-label={`Open quick view for ${movie.title}`}
      className="block w-full text-left focus:outline-none"
    >
      {/* Poster-forward card. No group hover; hover is local to this card only. */}
      <Card className="w-full overflow-hidden rounded-2xl border-slate-800 bg-[#0F141A] ring-1 ring-slate-800 transition-shadow hover:ring-2 hover:ring-white/25 focus:ring-2 focus:ring-cyan-500">
        {/* Poster frame (2:3) — any transform stays inside this box */}
        <div className="relative aspect-[2/3] w-full overflow-hidden">
          <Image
            src={movie.posterPath ?? "/placeholder.svg"}
            alt={movie.title}
            fill
            sizes="(max-width: 640px) 45vw, (max-width: 1024px) 22vw, 14vw"
            className="object-cover transition-transform duration-300 ease-out hover:scale-[1.03]"
            priority={false}
          />

          {/* TL: NEW + language (hide EN) */}
          <div className="absolute left-2 top-2 flex items-start gap-1">
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

        {/* Minimal text: single-line title so poster stays the hero */}
        <CardContent className="px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium leading-tight text-slate-100">
              {movie.title}
            </span>
            {movie.year && (
              <span className="shrink-0 text-[11px] text-slate-400">{movie.year}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </button>
  );
}
