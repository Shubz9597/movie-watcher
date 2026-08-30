import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Search, Settings2 } from 'lucide-react';
import { loadSeeAllPage } from '../lib/route-loaders';
import torWatchLogo from '../assets/torwatch-symbol.png';

const loadGlobalSearch = () => import('./GlobalSearch');
const GlobalSearch = lazy(loadGlobalSearch);

type Navigate = (path: string, params?: Record<string, string>) => void;

export default function AppHeader({ navigate }: { navigate: Navigate }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isCmdK) {
        e.preventDefault();
        void loadGlobalSearch();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const preload = () => void loadGlobalSearch();
    const idleId = window.requestIdleCallback(preload, { timeout: 2_000 });
    return () => window.cancelIdleCallback(idleId);
  }, []);

  const setSearchDialogOpen = (nextOpen: boolean) => {
    setSearchOpen(nextOpen);
    if (!nextOpen) {
      window.requestAnimationFrame(() => searchTriggerRef.current?.focus());
    }
  };

  const openSearch = () => {
    void loadGlobalSearch();
    setSearchOpen(true);
  };

  const browse = (title: string, api: string, kind: string) => {
    navigate('see-all', { title, api, kind });
  };

  return (
    <header className="sticky top-10 z-40 border-b border-white/[0.08] bg-[#0a0a0a]/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-5 md:px-8 xl:px-12">
        <button
          type="button"
          onClick={() => navigate('home')}
          className="group inline-flex h-12 w-16 shrink-0 items-center justify-center rounded-xl transition hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          aria-label="TorWatch home"
        >
          <img
            src={torWatchLogo}
            alt=""
            className="h-9 w-14 object-contain invert transition-opacity group-hover:opacity-85"
          />
        </button>

        <nav className="hidden items-center gap-1 border-l border-white/10 pl-4 lg:flex" aria-label="Browse library">
          <button
            type="button"
            onClick={() => browse('Trending movies', 'tmdb:trending:movie', 'movie')}
            onPointerEnter={() => void loadSeeAllPage()}
            onFocus={() => void loadSeeAllPage()}
            className="min-h-11 rounded-full px-3.5 py-2 text-sm text-white/65 transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            Movies
          </button>
          <button
            type="button"
            onClick={() => browse('Trending series', 'tmdb:trending:tv', 'tv')}
            onPointerEnter={() => void loadSeeAllPage()}
            onFocus={() => void loadSeeAllPage()}
            className="min-h-11 rounded-full px-3.5 py-2 text-sm text-white/65 transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            Series
          </button>
          <button
            type="button"
            onClick={() => browse('Trending anime', 'anilist:trending:anime', 'anime')}
            onPointerEnter={() => void loadSeeAllPage()}
            onFocus={() => void loadSeeAllPage()}
            className="min-h-11 rounded-full px-3.5 py-2 text-sm text-white/65 transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            Anime
          </button>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button
            ref={searchTriggerRef}
            type="button"
            aria-label="Search titles"
            aria-haspopup="dialog"
            onClick={openSearch}
            onPointerEnter={() => void loadGlobalSearch()}
            onFocus={() => void loadGlobalSearch()}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 text-white/75 transition hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 md:min-h-11 md:w-72 md:justify-start md:gap-2.5 md:bg-transparent md:px-4 md:py-2 md:text-left md:text-sm md:text-white/65 xl:w-80"
          >
            <Search className="h-4 w-4" strokeWidth={1.7} />
            <span className="hidden md:inline">Search titles</span>
            <kbd className="font-label ml-auto hidden text-white/65 md:inline">Ctrl K</kbd>
          </button>
          {searchOpen ? (
            <Suspense fallback={<span className="sr-only" role="status">Opening search…</span>}>
              <GlobalSearch
                navigate={navigate}
                open={searchOpen}
                onOpenChange={setSearchDialogOpen}
              />
            </Suspense>
          ) : null}
          <button
            type="button"
            aria-label="Open TorWatch setup"
            title="Setup and connections"
            onClick={() => void window.electronAPI?.openSetup()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/15 text-white/75 transition hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <Settings2 className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>
      </div>
    </header>
  );
}
