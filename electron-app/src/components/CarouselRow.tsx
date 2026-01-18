import * as React from 'react';
import PosterCard from './PosterCard';
import type { MovieCard } from '../lib/types';

type Props = {
  title: string;
  subtitle?: string;
  items: MovieCard[];
  loading?: boolean;
  onOpen: (id: number) => void;
  onPrefetch?: (id: number) => void;
  maxItems?: number;
  seeAllHref?: string;
  accent?: 'cyan' | 'purple' | 'rose';
  navigate?: (path: string, params?: Record<string, string>) => void;
};

export default function CarouselRow({
  title,
  subtitle,
  items,
  loading,
  onOpen,
  onPrefetch,
  maxItems = 10,
  seeAllHref,
  accent = 'cyan',
  navigate,
}: Props) {
  const visible = React.useMemo(() => items.slice(0, maxItems), [items, maxItems]);

  const accentBg: Record<'cyan' | 'purple' | 'rose', string> = {
    cyan: 'bg-gradient-to-br from-[#031b2a] via-[#050d18] to-[#05070f]',
    purple: 'bg-gradient-to-br from-[#1b0f2e] via-[#0f0a1f] to-[#04050a]',
    rose: 'bg-gradient-to-br from-[#2b0f19] via-[#13060c] to-[#050407]',
  } as const;

  const handleSeeAll = () => {
    if (seeAllHref && navigate) {
      // Parse seeAllHref to extract params
      try {
        const url = new URL(seeAllHref, 'http://localhost');
        const title = url.searchParams.get('title') || title;
        const api = url.searchParams.get('api') || '';
        const kind = url.searchParams.get('kind') || 'movie';
        navigate('see-all', { title, api, kind });
      } catch {
        // If parsing fails, try to extract from href
        const match = seeAllHref.match(/title=([^&]+).*api=([^&]+).*kind=([^&]+)/);
        if (match && navigate) {
          navigate('see-all', {
            title: decodeURIComponent(match[1]),
            api: decodeURIComponent(match[2]),
            kind: match[3],
          });
        }
      }
    }
  };

  return (
    <section className={`rounded-3xl border border-white/10 ${accentBg[accent]} p-5 md:p-7 shadow-2xl shadow-black/30`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Spotlight</p>
          <h2 className="text-2xl font-semibold text-white">{title}</h2>
          {subtitle ? <p className="text-sm text-slate-300">{subtitle}</p> : null}
        </div>
        {seeAllHref ? (
          <button
            onClick={handleSeeAll}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/10"
          >
            See all
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="translate-x-[1px]"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        ) : null}
      </div>

      {loading ? (
        <RailSkeleton />
      ) : (
        <ul className="grid gap-4 sm:gap-5 grid-cols-[repeat(auto-fill,minmax(168px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(196px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {visible.map((m) => (
            <li key={m.id}>
              <PosterCard movie={m} onOpen={onOpen} onPrefetch={onPrefetch} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RailSkeleton() {
  return (
    <ul className="grid gap-4 sm:gap-5 grid-cols-[repeat(auto-fill,minmax(168px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(196px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
      {Array.from({ length: 10 }).map((_, i) => (
        <li key={i} className="aspect-[2/3] rounded-2xl bg-slate-800/40 animate-pulse" />
      ))}
    </ul>
  );
}



