// Library page (feature 002 M2.2, WF04/04b): underlined Watch Later /
// Favourites tabs over grouped Movies/Series/Anime shelves with counts and
// links to scoped grids. Data comes from the injected LibraryProvider.
// The fixture provider is PREVIEW-ONLY (labelled on screen); persistence
// arrives with M3 — nothing on this page saves anything.
import { useEffect, useState } from 'react';
import { ChevronRight, Film, Ghost, Tv } from 'lucide-react';
import { UnderlineTabs } from '../components/primitives';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
import type { LibraryCollection, LibraryMediaKind, LibraryProvider, LibraryOverview, LibraryShelf } from '../lib/services/library-service';

const COLLECTION_TABS = [
  { id: 'watch-later' as const, label: 'Watch Later' },
  { id: 'favourites' as const, label: 'Favourites' },
];

const SHELF_META: Record<LibraryMediaKind, { label: string; icon: React.ReactNode }> = {
  movie: { label: 'Movies', icon: <Film className="h-4 w-4" aria-hidden="true" /> },
  series: { label: 'Series', icon: <Tv className="h-4 w-4" aria-hidden="true" /> },
  anime: { label: 'Anime', icon: <Ghost className="h-4 w-4" aria-hidden="true" /> },
};

type LibraryPageProps = {
  navigate: (path: string, params?: Record<string, string>) => void;
  provider: LibraryProvider | null;
  /** Controlled by the route (M2.2 restoration): the tab survives back/forward. */
  collection: LibraryCollection;
};

export function LibraryPage({ navigate, provider, collection }: LibraryPageProps) {
  const [overview, setOverview] = useState<LibraryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setCollection = (next: LibraryCollection) => {
    navigate('library', { collection: next });
  };

  useEffect(() => {
    if (!provider) {
      setLoading(false);
      setError('The library is not available on this server yet.');
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    provider.overview(collection)
      .then((data) => { if (active) setOverview(data); })
      .catch((err: unknown) => { if (active) setError(String(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [provider, collection]);

  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8 lg:px-12">
      <h1 className="type-section-title text-white">Library</h1>
      <div className="mt-4">
        <UnderlineTabs
          tabs={COLLECTION_TABS}
          active={collection}
          onChange={(id) => setCollection(id as LibraryCollection)}
          ariaLabel="Library collections"
          controlsId="library-panel"
        />
      </div>

      {overview ? (
        <p className="mt-3 text-xs text-white/45" role="note">{overview.sourceLabel}</p>
      ) : null}

      <div
        id="library-panel"
        role="tabpanel"
        aria-label={`${collection === 'watch-later' ? 'Watch Later' : 'Favourites'} titles`}
      >
      {loading ? (
        <div className="mt-8 grid grid-cols-3 gap-4 sm:grid-cols-6" role="status" aria-label="Loading library">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="aspect-[2/3] animate-pulse rounded-lg bg-white/[0.06]" />
          ))}
        </div>
      ) : error ? (
        <p className="mt-8 rounded-lg border border-red-300/20 bg-red-950/30 px-4 py-3 text-sm text-red-100" role="alert">{error}</p>
      ) : overview ? (
        <div className="mt-6 space-y-8">
          {overview.shelves.map((shelf) => (
            <LibraryShelfRow
              key={shelf.kind}
              shelf={shelf}
              collection={collection}
              navigate={navigate}
            />
          ))}
        </div>
      ) : null}
      </div>
    </section>
  );
}

function LibraryShelfRow({ shelf, collection, navigate }: {
  shelf: LibraryShelf;
  collection: LibraryCollection;
  navigate: (path: string, params?: Record<string, string>) => void;
}) {
  const meta = SHELF_META[shelf.kind];
  return (
    <section aria-label={`${meta.label} shelf`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          {meta.icon}
          {meta.label}
          <span className="text-numeric text-sm font-normal text-white/50">{shelf.count}</span>
        </h2>
        <button
          type="button"
          onClick={() => navigate('library-category', { collection, kind: shelf.kind })}
          className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm text-white/65 hover:text-white ${FOCUS_RING_CLASS}`}
          aria-label={`View all ${meta.label} (${shelf.count})`}
        >
          View all
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {shelf.count === 0 ? (
        <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/55">
          Nothing here yet. Saving arrives with library sync.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {shelf.previews.map((card) => (
            <button
              key={`${shelf.kind}-${card.id}`}
              type="button"
              onClick={() => navigate('title', { kind: shelf.kind === 'anime' ? 'anime' : shelf.kind === 'movie' ? 'movie' : 'tv', id: String(card.id) })}
              className={`group relative aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] ${FOCUS_RING_CLASS}`}
              aria-label={`Open ${card.title}`}
            >
              {card.posterPath ? (
                <img
                  src={card.posterPath}
                  alt=""
                  width="342"
                  height="513"
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.08] to-white/[0.025]">
                  <span className="text-3xl opacity-30" aria-hidden="true">🎬</span>
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6 text-left">
                <span className="line-clamp-2 text-xs font-medium leading-4 text-white">{card.title}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// LibraryCategoryPage: the scoped grid behind a shelf's "View all" (WF04b).
export function LibraryCategoryPage({ navigate, provider, collection, kind }: {
  navigate: (path: string, params?: Record<string, string>) => void;
  provider: LibraryProvider | null;
  collection: LibraryCollection;
  kind: LibraryMediaKind;
}) {
  const [state, setState] = useState<{ items: import('../lib/types').MovieCard[]; count: number; sourceLabel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) {
      setError('The library is not available on this server yet.');
      return;
    }
    let active = true;
    provider.category(collection, kind)
      .then((data) => { if (active) setState(data); })
      .catch((err: unknown) => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [provider, collection, kind]);

  const title = `${collection === 'watch-later' ? 'Watch Later' : 'Favourites'} — ${SHELF_META[kind].label}`;
  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8 lg:px-12">
      <button
        type="button"
        onClick={() => navigate('library', { collection })}
        className={`inline-flex min-h-11 items-center rounded-full text-sm text-white/65 hover:text-white ${FOCUS_RING_CLASS}`}
      >
        ← Library
      </button>
      <h1 className="type-section-title mt-2 text-white">{title}</h1>
      {state ? <p className="mt-2 text-xs text-white/45" role="note">{state.sourceLabel} · {state.count} titles</p> : null}
      {error ? (
        <p className="mt-8 rounded-lg border border-red-300/20 bg-red-950/30 px-4 py-3 text-sm text-red-100" role="alert">{error}</p>
      ) : state ? (
        <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-6">
          {state.items.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => navigate('title', { kind: kind === 'anime' ? 'anime' : kind === 'movie' ? 'movie' : 'tv', id: String(card.id) })}
              className={`group relative aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] ${FOCUS_RING_CLASS}`}
              aria-label={`Open ${card.title}`}
            >
              {card.posterPath ? (
                <img src={card.posterPath} alt="" width="342" height="513" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
              ) : null}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6 text-left">
                <span className="line-clamp-2 text-xs font-medium leading-4 text-white">{card.title}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-3 gap-4 sm:grid-cols-6" role="status" aria-label="Loading titles">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="aspect-[2/3] animate-pulse rounded-lg bg-white/[0.06]" />
          ))}
        </div>
      )}
    </section>
  );
}
