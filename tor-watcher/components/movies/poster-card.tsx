"use client";

import Image from "next/image";
import type { MovieCard } from "@/lib/types";
import { useRef } from "react";
import { Flame, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";

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
  const year = movie.year ? String(movie.year) : undefined;

  return (
    <button
      type="button"
      onClick={() => onOpen(movie.id)}
      onMouseEnter={startPrefetchTimer}
      onMouseLeave={clearPrefetchTimer}
      aria-label={`Open quick view for ${movie.title}`}
      className="group relative block w-full text-left focus:outline-none"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-3xl border border-slate-900/60 bg-[#0b111f] shadow-lg shadow-black/40 transition-all duration-300 group-hover:-translate-y-1 group-hover:border-cyan-500/40">
        <div className="absolute inset-0">
          <Image
            src={movie.posterPath ?? "/placeholder.svg"}
            alt={movie.title}
            fill
            sizes="(max-width: 640px) 45vw, (max-width: 1024px) 22vw, 14vw"
            className="object-cover transition-transform duration-700 ease-out group-hover:scale-105"
            priority={false}
          />
        </div>

        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent opacity-90 transition duration-300 group-hover:opacity-100" />

        <div className="absolute left-3 top-3 flex items-start gap-2 text-[11px] text-white">
          {movie.isNew && (
            <Badge className="bg-cyan-500 text-black shadow-lg shadow-cyan-500/30">NEW</Badge>
          )}
          {lang !== "EN" && (
            <span className="rounded-md border border-white/20 bg-black/60 px-2 py-[2px] uppercase tracking-wide text-[10px]">
              {lang}
            </span>
          )}
        </div>

        <div className="absolute right-3 top-3 flex flex-col items-end gap-1 text-[11px] text-white">
          {typeof tmdbPct === "number" && (
            <span className="rounded-full border border-white/20 bg-black/70 px-2 py-[2px] font-semibold shadow">
              {tmdbPct}% score
            </span>
          )}
          {typeof movie.tmdbPopularity === "number" && (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-2 py-[2px]">
              <Flame className="h-3 w-3 text-amber-400" />
              {Math.round(movie.tmdbPopularity)}
            </span>
          )}
        </div>

        <div className="absolute inset-x-3 bottom-3 space-y-1">
          <div className="text-base font-semibold leading-tight text-white line-clamp-2">
            {movie.title}
          </div>
          <div className="flex items-center justify-between text-xs text-slate-200">
            <span className="flex items-center gap-1">
              {year ? <span>{year}</span> : null}
              {year && movie.originalLanguage ? <span className="opacity-60">•</span> : null}
              {movie.originalLanguage ? movie.originalLanguage.toUpperCase() : null}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
