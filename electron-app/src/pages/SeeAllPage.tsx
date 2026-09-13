import { useEffect, useRef, useState } from 'react';
import { PageBackButton } from '../components/shared/PageBackButton';
import PosterCard from '../components/PosterCard';
import type { MovieCard } from '../lib/types';
import { getTitlesByGenre, getMovies, getTvShows, getAnimeByGenre, getAnimeList, getTrendingAnime } from '../lib/services/catalog-gateway';
import { selectAniListCatalog } from '../lib/anime-catalog';
import { loadTitlePage } from '../lib/route-loaders';
import { CatalogFilters } from '../components/shared/CatalogFilters';

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
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const activeCollectionRef = useRef('');
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadMorePendingRef = useRef(false);

  useEffect(() => {
    const collectionKey = `${kind}:${api}`;
    if (activeCollectionRef.current !== collectionKey) {
      activeCollectionRef.current = collectionKey;
      loadMorePendingRef.current = false;
      setItems([]);
      setTotalPages(undefined);
      setError(null);
      if (page !== 1) {
        setPage(1);
        setLoading(false);
        return;
      }
    }

    let cancelled = false;
    async function load() {
      if (!api) {
        setLoading(false);
        setError('This collection link is incomplete. Return home and choose a library again.');
        return;
      }
      setLoading(true);
      setError(null);
      try {
        console.log('[SeeAllPage] Loading', api, 'page', page);

        // Parse API identifiers such as "tmdb:trending:movie" and "tmdb:genre:movie:28".
        // All collections dispatch through the flag-routed catalog gateway
        // (T042.5): renderer mode keeps the provider services, bff mode uses
        // /v2/catalog/* including genre rails and paging.
        const [service, type, category, qualifier] = api.split(':');

        if (service === 'tmdb') {
          if (category === 'movie' || category === 'tv') {
            const kind = category === 'movie' ? 'movie' as const : 'tv' as const;
            const genreId = Number(qualifier);
            const data = type === 'genre' && Number.isFinite(genreId)
              ? await getTitlesByGenre(kind, genreId, page)
              : category === 'movie'
                ? await getMovies(page, type === 'trending' ? 'trending' : 'popular')
                : await getTvShows(page, type === 'trending' ? 'trending' : 'popular');
            if (cancelled) return;
            const cards = data.items;
            if (page === 1) {
              setItems(cards);
            } else {
              setItems((prev) => [...prev, ...cards]);
            }
            setTotalPages(data.totalPages);
          }
        } else if (service === 'anilist') {
          const data = type === 'genre' && category === 'anime' && qualifier
            ? await getAnimeByGenre(qualifier, page)
            : type === 'trending'
              ? await getTrendingAnime(page)
              : await getAnimeList(page);
          if (cancelled) return;
          const cards = selectAniListCatalog(data.items);
          if (page === 1) {
            setItems(cards);
          } else {
            setItems((previous) => selectAniListCatalog([...previous, ...cards]));
          }
          setTotalPages(data.totalPages);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[SeeAllPage] Load failed:', err);
        setError(api.startsWith('tmdb:')
          ? 'This collection could not be loaded. Check your connection or TMDb setting.'
          : 'This collection could not be loaded. Check your connection and try again.');
      } finally {
        if (!cancelled) {
          setLoading(false);
          loadMorePendingRef.current = false;
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, kind, page, reloadToken]);

  const hasMore = items.length > 0 && (totalPages === undefined || page < totalPages);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || loading || error || !hasMore) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || loadMorePendingRef.current) return;
      loadMorePendingRef.current = true;
      setPage((currentPage) => currentPage + 1);
    }, { rootMargin: '600px 0px' });

    observer.observe(target);
    return () => observer.disconnect();
  }, [error, hasMore, items.length, loading]);

  return (
    <div className="mx-auto max-w-[1600px] space-y-10 px-5 py-10 md:px-8 md:py-14 xl:px-12">
      <div className="flex flex-col gap-6 border-b border-white/[0.08] pb-10 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="type-secondary mb-3 font-medium text-white/65">Browse library</p>
          <h1 className="type-page-title text-white">{title}</h1>
          <p className="type-body mt-3 text-white/70">Explore the full collection.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CatalogFilters kind={kind} api={api} navigate={navigate} />
          <PageBackButton />
        </div>
      </div>

      <ul className="grid grid-cols-2 gap-x-3.5 gap-y-8 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
        {items.map((m) => (
          <li
            key={`${m.sourceProvider || 'unknown'}-${m.sourceKind || kind}-${m.id}`}
            className="content-auto-card"
          >
            <PosterCard
              movie={m}
              onPrefetch={() => void loadTitlePage()}
              onOpen={(movie) => {
                const params: Record<string, string> = { kind, id: String(movie.id) };
                if (kind === 'anime' && movie.malId) params.malId = String(movie.malId);
                if (kind === 'anime' && movie.sourceProvider === 'tmdb') {
                  params.provider = 'tmdb';
                  params.mediaKind = movie.sourceKind === 'movie' ? 'movie' : 'tv';
                }
                navigate('title', params);
              }}
            />
          </li>
        ))}
      </ul>

      {loading && <div className="type-body py-8 text-center text-white/65">Loading more titles…</div>}
      {!loading && error ? (
        <div className="type-body rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-5 py-6 text-center text-amber-100/90" role="alert">
          <p>{error}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => setReloadToken((token) => token + 1)}
              className="min-h-11 rounded-full border border-amber-100/25 px-4 py-2 text-sm text-amber-50 transition hover:border-amber-100/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-100/70"
            >
              Try again
            </button>
            {api.startsWith('tmdb:') ? (
              <button
                type="button"
                onClick={() => void window.electronAPI?.openSetup()}
                className="min-h-11 rounded-full bg-white px-4 py-2 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Open settings
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {hasMore && !error ? <div ref={loadMoreRef} className="h-px" aria-hidden="true" /> : null}
    </div>
  );
}



