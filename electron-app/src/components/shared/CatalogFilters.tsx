import { useMemo, useState } from 'react';
import { Check, ChevronDown, ListFilter } from 'lucide-react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import { SelectionSurface } from '../primitives';

type CatalogKind = 'movie' | 'tv' | 'anime';
type Navigate = (path: string, params?: Record<string, string>) => void;

type Genre = {
  label: string;
  movie?: number;
  tv?: number;
  anime?: string;
};

export const CATALOG_GENRES: readonly Genre[] = [
  { label: 'Action', movie: 28, anime: 'Action' },
  { label: 'Adventure', movie: 12, anime: 'Adventure' },
  { label: 'Action & Adventure', tv: 10759 },
  { label: 'Animation', movie: 16, tv: 16 },
  { label: 'Comedy', movie: 35, tv: 35, anime: 'Comedy' },
  { label: 'Crime', movie: 80, tv: 80 },
  { label: 'Documentary', movie: 99, tv: 99 },
  { label: 'Drama', movie: 18, tv: 18, anime: 'Drama' },
  { label: 'Ecchi', anime: 'Ecchi' },
  { label: 'Family', movie: 10751, tv: 10751 },
  { label: 'Fantasy', movie: 14, anime: 'Fantasy' },
  { label: 'History', movie: 36 },
  { label: 'Horror', movie: 27, anime: 'Horror' },
  { label: 'Kids', tv: 10762 },
  { label: 'Mahou Shoujo', anime: 'Mahou Shoujo' },
  { label: 'Mecha', anime: 'Mecha' },
  { label: 'Music', movie: 10402, anime: 'Music' },
  { label: 'Mystery', movie: 9648, tv: 9648, anime: 'Mystery' },
  { label: 'News', tv: 10763 },
  { label: 'Psychological', anime: 'Psychological' },
  { label: 'Reality', tv: 10764 },
  { label: 'Romance', movie: 10749, anime: 'Romance' },
  { label: 'Science Fiction', movie: 878 },
  { label: 'Sci-Fi', anime: 'Sci-Fi' },
  { label: 'Sci-Fi & Fantasy', tv: 10765 },
  { label: 'Slice of Life', anime: 'Slice of Life' },
  { label: 'Soap', tv: 10766 },
  { label: 'Sports', anime: 'Sports' },
  { label: 'Supernatural', anime: 'Supernatural' },
  { label: 'Talk', tv: 10767 },
  { label: 'Thriller', movie: 53, anime: 'Thriller' },
  { label: 'War', movie: 10752 },
  { label: 'War & Politics', tv: 10768 },
  { label: 'Western', movie: 37, tv: 37 },
] as const;

function parseGenre(api: string): number | string | null {
  const [service, type, , qualifier] = api.split(':');
  if (type !== 'genre' || !qualifier) return null;
  if (service === 'anilist') return qualifier;
  if (service !== 'tmdb') return null;
  const genreID = Number(qualifier);
  return Number.isFinite(genreID) ? genreID : null;
}

function FilterChoices({
  kind,
  api,
  navigate,
  onSelected,
}: {
  kind: CatalogKind;
  api: string;
  navigate: Navigate;
  onSelected?: () => void;
}) {
  const selectedGenre = parseGenre(api);
  const genres = useMemo(
    () => CATALOG_GENRES.filter((genre) => genre[kind] != null),
    [kind],
  );

  const chooseGenre = (genre: Genre | null) => {
    const providerGenre = genre?.[kind];
    if (kind === 'anime') {
      navigate('see-all', genre && providerGenre ? {
        title: `${genre.label} anime`,
        api: `anilist:genre:anime:${providerGenre}`,
        kind,
      } : {
        title: 'Popular anime',
        api: 'anilist:popular:anime',
        kind,
      });
      onSelected?.();
      return;
    }
    const id = providerGenre;
    const label = kind === 'movie' ? 'movies' : 'series';
    navigate('see-all', genre && id != null ? {
      title: `${genre.label} ${label}`,
      api: `tmdb:genre:${kind}:${id}`,
      kind,
    } : {
      title: `Popular ${label}`,
      api: `tmdb:popular:${kind}`,
      kind,
    });
    onSelected?.();
  };

  return (
    <div>
      <fieldset>
        <legend className="text-sm font-medium text-white">Genre</legend>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <GenreButton label="All genres" selected={selectedGenre == null} onClick={() => chooseGenre(null)} />
          {genres.map((genre) => (
            <GenreButton
              key={`${kind}-${genre.label}`}
              label={genre.label}
              selected={genre[kind] === selectedGenre}
              onClick={() => chooseGenre(genre)}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function GenreButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex min-h-11 items-center justify-between gap-2 rounded-xl px-3 text-left text-sm transition ${selected ? 'bg-white text-black' : 'bg-white/[0.05] text-white/70 hover:bg-white/[0.1] hover:text-white'} ${FOCUS_RING_CLASS}`}
    >
      <span>{label}</span>
      {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
    </button>
  );
}

export function CatalogFilters({ kind, api, navigate }: { kind: string; api: string; navigate: Navigate }) {
  const normalizedKind: CatalogKind = kind === 'tv' || kind === 'anime' ? kind : 'movie';
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectedGenre = parseGenre(api);
  const activeGenre = CATALOG_GENRES.find((genre) => genre[normalizedKind] === selectedGenre)?.label;
  const buttonLabel = activeGenre ? `Filters · ${activeGenre}` : 'Filters';

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-4 text-sm text-white/75 transition hover:border-white/35 hover:text-white md:hidden ${FOCUS_RING_CLASS}`}
        aria-haspopup="dialog"
      >
        <ListFilter className="h-4 w-4" aria-hidden="true" />
        {buttonLabel}
      </button>

      <details className="group relative hidden md:block">
        <summary className={`inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-white/15 px-4 text-sm text-white/75 transition marker:hidden hover:border-white/35 hover:text-white [&::-webkit-details-marker]:hidden ${FOCUS_RING_CLASS}`}>
          <ListFilter className="h-4 w-4" aria-hidden="true" />
          {buttonLabel}
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="absolute right-0 z-30 mt-3 w-[min(42rem,calc(100vw-4rem))] rounded-2xl border border-white/12 bg-[#111] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.45)]">
          <FilterChoices kind={normalizedKind} api={api} navigate={navigate} />
        </div>
      </details>

      <SelectionSurface open={mobileOpen} title="Browse filters" onClose={() => setMobileOpen(false)}>
        <FilterChoices
          kind={normalizedKind}
          api={api}
          navigate={navigate}
          onSelected={() => setMobileOpen(false)}
        />
      </SelectionSurface>
    </div>
  );
}
