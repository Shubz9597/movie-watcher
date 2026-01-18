import { useEffect, useState } from 'react';
import PosterCard from '../components/PosterCard';
import type { MovieCard } from '../lib/types';
import { getMovies, getTvShows } from '../lib/services/tmdb-service';
import { getAnimeList, searchAnime } from '../lib/services/jikan-service';
import { cardFromTmdbMovie, cardFromTmdbTv, cardFromJikan } from '../lib/adapters/media';

export default function SeeAllPage({
  navigate,
  title,
  api,
  kind,
}: {
  navigate: (path: string, params?: Record<string, string>) => void;
  title: string;
  api: string;
  kind: string;
}) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<MovieCard[]>([]);
  const [totalPages, setTotalPages] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function load() {
      if (!api) return;
      setLoading(true);
      try {
        console.log('[SeeAllPage] Loading', api, 'page', page);

        // Parse API identifier: "tmdb:trending:movie", "jikan:top:anime", etc.
        const [service, type, category] = api.split(':');

        if (service === 'tmdb') {
          if (category === 'movie') {
            const data = await getMovies(page, type === 'trending' ? 'trending' : 'popular');
            const cards = (data.results || []).map(cardFromTmdbMovie);
            if (page === 1) {
              setItems(cards);
            } else {
              setItems((prev) => [...prev, ...cards]);
            }
            setTotalPages(data.total_pages);
          } else if (category === 'tv') {
            const data = await getTvShows(page, type === 'trending' ? 'trending' : 'popular');
            const cards = (data.results || []).map(cardFromTmdbTv);
            if (page === 1) {
              setItems(cards);
            } else {
              setItems((prev) => [...prev, ...cards]);
            }
            setTotalPages(data.total_pages);
          }
        } else if (service === 'jikan') {
          const data = await getAnimeList(page, 'bypopularity');
          const cards = ((data.data || []) as any[]).map(cardFromJikan);
          if (page === 1) {
            setItems(cards);
          } else {
            setItems((prev) => [...prev, ...cards]);
          }
          setTotalPages(data.pagination?.last_visible_page);
        }
      } catch (err) {
        console.error('[SeeAllPage] Load failed:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [api, page]);

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
            onClick={() => navigate('home')}
            className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10"
          >
            ← Back
          </button>
        </div>
      </div>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4 sm:gap-5">
        {items.map((m) => (
          <li key={m.id}>
            <PosterCard movie={m} onOpen={(id) => navigate('title', { kind, id: String(id) })} />
          </li>
        ))}
      </ul>

      {loading && <div className="text-center text-slate-400">Loading...</div>}
      {!loading && (totalPages === undefined || page < totalPages) && (
        <div className="flex justify-center">
          <button
            onClick={() => setPage((p) => p + 1)}
            className="rounded-full bg-cyan-500 px-6 py-2 text-sm font-semibold text-black shadow-lg shadow-cyan-500/30 hover:bg-cyan-400"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}



