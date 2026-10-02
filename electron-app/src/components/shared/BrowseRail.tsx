// Browse rail (feature 002 M2.2, WF02): an open icon rail of Home media
// categories. Tiles navigate through the shared router; nothing here fetches
// provider data. 48px targets, accessible names, horizontal scroll on phones.
import { Clapperboard, Drama, Flame, Ghost, Laugh, Rocket, Tv } from 'lucide-react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';

type BrowseDestination = {
  key: string;
  label: string;
  icon: React.ReactNode;
  params: Record<string, string>;
};

// Genre ids are the TMDb ids the SeeAllPage contract already parses
// ("tmdb:genre:movie:<id>"); anime rides the AniList trending collection.
const DESTINATIONS: BrowseDestination[] = [
  { key: 'movies', label: 'Movies', icon: <Clapperboard className="h-5 w-5" aria-hidden="true" />, params: { title: 'Trending movies', api: 'tmdb:trending:movie', kind: 'movie' } },
  { key: 'series', label: 'Series', icon: <Tv className="h-5 w-5" aria-hidden="true" />, params: { title: 'Trending series', api: 'tmdb:trending:tv', kind: 'tv' } },
  { key: 'anime', label: 'Anime', icon: <Ghost className="h-5 w-5" aria-hidden="true" />, params: { title: 'Trending anime', api: 'anilist:trending:anime', kind: 'anime' } },
  { key: 'action', label: 'Action', icon: <Flame className="h-5 w-5" aria-hidden="true" />, params: { title: 'Action movies', api: 'tmdb:genre:movie:28', kind: 'movie' } },
  { key: 'comedy', label: 'Comedy', icon: <Laugh className="h-5 w-5" aria-hidden="true" />, params: { title: 'Comedy movies', api: 'tmdb:genre:movie:35', kind: 'movie' } },
  { key: 'scifi', label: 'Sci-Fi', icon: <Rocket className="h-5 w-5" aria-hidden="true" />, params: { title: 'Sci-Fi & Fantasy movies', api: 'tmdb:genre:movie:878', kind: 'movie' } },
  { key: 'drama', label: 'Drama', icon: <Drama className="h-5 w-5" aria-hidden="true" />, params: { title: 'Drama series', api: 'tmdb:genre:tv:18', kind: 'tv' } },
];

export function BrowseRail({ navigate }: { navigate: (path: string, params?: Record<string, string>) => void }) {
  return (
    <nav aria-label="Browse categories" className="border-b border-white/[0.06] md:hidden">
      <div className="hide-scrollbar -mx-5 flex overflow-x-auto px-3 py-1 md:mx-0 md:flex-wrap md:px-0">
        {DESTINATIONS.map((destination) => (
          <button
            key={destination.key}
            type="button"
            onClick={() => navigate('see-all', destination.params)}
            className={`relative inline-flex min-h-[var(--touch-target)] shrink-0 items-center gap-2 rounded-lg px-4 text-sm text-white/80 transition hover:text-white [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-y-3.5 [&:not(:first-child)]:before:left-0 [&:not(:first-child)]:before:w-px [&:not(:first-child)]:before:bg-white/[0.12] ${FOCUS_RING_CLASS}`}
          >
            {destination.icon}
            <span>{destination.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
