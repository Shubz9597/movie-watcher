"use client";

import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MovieCard } from "@/lib/types";
import { useRef } from "react";

const PREFETCH_DELAY_MS = 300;

export default function PosterCard({
  movie,
  onOpen,
  onPrefetch,
}: {
  movie: MovieCard;                 // MovieCard has optional topCast?: string[]
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

  return (
    <button
      type="button"
      onClick={() => onOpen(movie.id)}
      onMouseEnter={startPrefetchTimer}
      onMouseLeave={clearPrefetchTimer}
      onFocus={startPrefetchTimer}   // keyboard users
      onBlur={clearPrefetchTimer}
      aria-label={`Open quick view for ${movie.title}`}
      className="group text-left focus:outline-none"
    >
      <Card
        className="overflow-hidden rounded-2xl border-slate-800 bg-[#0F141A] ring-1 ring-slate-800
                   transition hover:scale-[1.02] hover:ring-cyan-600/40 focus:ring-2 focus:ring-cyan-500"
      >
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
          <div className="absolute left-2 top-2 flex gap-1">
            {movie.isNew && (
              <Badge className="bg-cyan-500 text-black hover:bg-cyan-400">NEW</Badge>
            )}
            {typeof movie.rating === "number" && (
              <span className="rounded-full bg-black/70 px-2 py-0.5 text-[11px] leading-none text-slate-100">
                ★ {movie.rating.toFixed(1)}
              </span>
            )}
          </div>
        </div>

        {/* Text content — bigger now */}
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
            <div className="mt-1 line-clamp-1 text-[12px] text-slate-400">
              {topCast}
            </div>
          )}
        </CardContent>
      </Card>
    </button>
  );
}