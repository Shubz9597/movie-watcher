import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import type { MovieCard } from '../lib/types';

const PREFETCH_DELAY_MS = 300;

export default function PosterCard({
  movie,
  rank,
  onOpen,
  onPrefetch,
}: {
  movie: MovieCard;
  rank?: number;
  onOpen: (movie: MovieCard) => void;
  onPrefetch?: (movie: MovieCard) => void;
}) {
  const timerRef = useRef<number | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);

  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  }, []);

  const startPrefetchTimer = () => {
    if (!onPrefetch || timerRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onPrefetch(movie);
    }, PREFETCH_DELAY_MS);
  };

  const clearPrefetchTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const score =
    typeof movie.tmdbRatingPct === 'number'
      ? movie.tmdbRatingPct
      : typeof movie.rating === 'number'
        ? Math.round(movie.rating * 10)
        : undefined;
  const posterUrl = movie.posterPath
    ? movie.posterPath.startsWith('http')
      ? movie.posterPath
      : `https://image.tmdb.org/t/p/w342${movie.posterPath}`
    : null;

  return (
    <button
      type="button"
      onClick={() => onOpen(movie)}
      onMouseEnter={startPrefetchTimer}
      onMouseLeave={clearPrefetchTimer}
      onFocus={startPrefetchTimer}
      onBlur={clearPrefetchTimer}
      aria-label={`Open ${movie.title}`}
      className="group block w-full text-left focus-visible:outline-none"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] transition duration-300 group-hover:-translate-y-1 group-hover:border-white/30 group-focus-visible:ring-2 group-focus-visible:ring-white/60">
        {posterUrl && !posterFailed ? (
          <img
            src={posterUrl}
            alt=""
            width="342"
            height="513"
            className="h-full w-full object-cover transition duration-500 ease-out group-hover:scale-[1.03]"
            loading="lazy"
            decoding="async"
            onError={() => setPosterFailed(true)}
          />
        ) : (
          <div className="type-body flex h-full items-center justify-center px-4 text-center text-white/70">
            Artwork unavailable
          </div>
        )}

        <div className="absolute inset-0 bg-black/0 transition group-hover:bg-black/25" />

        {typeof rank === 'number' ? (
          <span className="font-label absolute left-2.5 top-2.5 rounded bg-black/80 px-2 py-1 text-xs text-white/90 backdrop-blur-md">
            {String(rank).padStart(2, '0')}
          </span>
        ) : null}

        {movie.isNew ? (
          <span className="font-label absolute bottom-2.5 left-2.5 rounded bg-[#ff7a17] px-2 py-1 text-xs text-black">
            New
          </span>
        ) : null}

        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black">
            <Play className="ml-0.5 h-4 w-4 fill-current" />
          </span>
        </span>
      </div>

      <div className="mt-3 min-w-0">
        <h3 className="truncate text-base font-medium leading-6 text-white/90 transition group-hover:text-white">
          {movie.title}
        </h3>
        <div className="type-caption text-numeric mt-1 flex items-center gap-2 text-white/70">
          {movie.year ? <span>{movie.year}</span> : null}
          {movie.year && typeof score === 'number' ? <span aria-hidden="true">·</span> : null}
          {typeof score === 'number' ? <span>{score}%</span> : null}
          {movie.originalLanguage && movie.originalLanguage.toLowerCase() !== 'en' ? (
            <span className="font-label ml-auto">{movie.originalLanguage}</span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
