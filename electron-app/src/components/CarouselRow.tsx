import * as React from 'react';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import PosterCard from './PosterCard';
import type { MovieCard } from '../lib/types';

type Props = {
  title: string;
  subtitle?: string;
  items: MovieCard[];
  loading?: boolean;
  onOpen: (movie: MovieCard) => void;
  onPrefetch?: (movie: MovieCard) => void;
  maxItems?: number;
  seeAllHref?: string;
  navigate?: (path: string, params?: Record<string, string>) => void;
  emptyMessage?: string;
  error?: string | null;
  onRetry?: () => void;
  onOpenSettings?: () => void;
};

export default function CarouselRow({
  title,
  subtitle,
  items,
  loading,
  onOpen,
  onPrefetch,
  maxItems = 15,
  seeAllHref,
  navigate,
  emptyMessage = 'Nothing to show right now.',
  error,
  onRetry,
  onOpenSettings,
}: Props) {
  const visible = React.useMemo(() => items.slice(0, maxItems), [items, maxItems]);
  const railRef = React.useRef<HTMLUListElement>(null);
  const [scrollState, setScrollState] = React.useState({ previous: false, next: false });

  const updateScrollState = React.useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const remaining = rail.scrollWidth - rail.clientWidth - rail.scrollLeft;
    setScrollState({
      previous: rail.scrollLeft > 2,
      next: remaining > 2,
    });
  }, []);

  React.useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const frame = window.requestAnimationFrame(updateScrollState);
    rail.addEventListener('scroll', updateScrollState, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(rail);

    return () => {
      window.cancelAnimationFrame(frame);
      rail.removeEventListener('scroll', updateScrollState);
      observer.disconnect();
    };
  }, [updateScrollState, visible.length, seeAllHref]);

  const moveRail = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * rail.clientWidth, behavior: 'smooth' });
  };

  const handleSeeAll = () => {
    if (!seeAllHref || !navigate) return;

    try {
      const url = new URL(seeAllHref, 'http://localhost');
      const nextTitle = url.searchParams.get('title') || title;
      const api = url.searchParams.get('api') || '';
      const kind = url.searchParams.get('kind') || 'movie';
      navigate('see-all', { title: nextTitle, api, kind });
    } catch {
      const match = seeAllHref.match(/title=([^&]+).*api=([^&]+).*kind=([^&]+)/);
      if (match) {
        navigate('see-all', {
          title: decodeURIComponent(match[1]),
          api: decodeURIComponent(match[2]),
          kind: match[3],
        });
      }
    }
  };

  return (
    <section className="border-t border-white/[0.08] py-8 md:py-10">
      <div className="mb-5">
        <div className="min-w-0">
          <p className="type-secondary mb-2 font-medium text-white/65">Now in rotation</p>
          <h2 className="type-section-title text-white">{title}</h2>
          {subtitle ? <p className="measure-compact type-body mt-2 text-white/70">{subtitle}</p> : null}
        </div>
      </div>

      {loading ? (
        <RailSkeleton />
      ) : visible.length ? (
        <div className="carousel-shell relative">
          <ul
            ref={railRef}
            className="carousel-rail hide-scrollbar pb-2"
            aria-label={`${title} carousel`}
          >
            {visible.map((movie, index) => (
              <li key={`${movie.sourceProvider || 'unknown'}-${movie.sourceKind || 'unknown'}-${movie.id}`} className="carousel-slide">
                <PosterCard
                  movie={movie}
                  rank={index + 1}
                  onOpen={onOpen}
                  onPrefetch={onPrefetch}
                />
              </li>
            ))}
            {seeAllHref && navigate ? (
              <li className="carousel-slide">
                <button
                  type="button"
                  onClick={handleSeeAll}
                  className="group block w-full text-left focus-visible:outline-none"
                  aria-label={`View all ${title}`}
                >
                  <span className="flex aspect-[2/3] w-full items-center justify-center rounded-lg border border-white/[0.14] bg-white/[0.035] text-white/65 transition duration-300 group-hover:-translate-y-1 group-hover:border-white/35 group-hover:bg-white/[0.07] group-hover:text-white group-focus-visible:ring-2 group-focus-visible:ring-white/60">
                    <ArrowRight className="h-8 w-8 transition-transform duration-300 group-hover:translate-x-1" strokeWidth={1.35} />
                  </span>
                  <span className="mt-3 block text-base font-medium leading-6 text-white/90 transition group-hover:text-white">
                    View all
                  </span>
                  <span className="type-caption mt-1 block text-white/60">Complete list</span>
                </button>
              </li>
            ) : null}
          </ul>

          {scrollState.previous ? (
            <button
              type="button"
              onClick={() => moveRail(-1)}
              className="carousel-control carousel-control--previous"
              aria-label={`Previous ${title}`}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : null}
          {scrollState.next ? (
            <button
              type="button"
              onClick={() => moveRail(1)}
              className="carousel-control carousel-control--next"
              aria-label={`Next ${title}`}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      ) : error ? (
        <div className="flex min-h-56 flex-col items-center justify-center border border-dashed border-amber-200/20 px-6 text-center" role="alert">
          <p className="measure-compact type-body text-amber-100/90">{error}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="min-h-11 rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Try again
              </button>
            ) : null}
            {onOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="min-h-11 rounded-full bg-white px-4 py-2 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Open settings
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="type-body flex h-56 items-center justify-center border border-dashed border-white/15 text-white/70">
          {emptyMessage}
        </div>
      )}
    </section>
  );
}

function RailSkeleton() {
  return (
    <div className="carousel-shell overflow-hidden">
      <ul className="carousel-rail pointer-events-none">
      {Array.from({ length: 8 }).map((_, index) => (
        <li key={index} className="carousel-slide">
          <div className="aspect-[2/3] animate-pulse rounded-lg bg-white/[0.06]" />
          <div className="mt-3 h-3 w-2/3 animate-pulse rounded bg-white/[0.06]" />
          <div className="mt-2 h-2.5 w-1/3 animate-pulse rounded bg-white/[0.04]" />
        </li>
      ))}
      </ul>
    </div>
  );
}
