// AppShell (feature 002 M2.2, WF01/03): the responsive shared shell.
// Compact widths get an icon top bar plus a bottom destination bar
// (Home/Search/Library, icons with small labels, 48px targets); desktop
// widths render the existing AppHeader so the Electron layout is unchanged.
// The shell owns only presentation and navigation intent — data stays in
// pages, platform behavior in adapters.
import { lazy, Suspense } from 'react';
import { ChevronLeft, Home, Library, Search, Settings2 } from 'lucide-react';
import AppHeader from '../AppHeader';
import torWatchLogo from '../../assets/torwatch-symbol.png';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import { useHistoryDialog } from '../../lib/use-history-dialog';

const GlobalSearch = lazy(() => import('../GlobalSearch'));

type AppShellProps = {
  routePath: string;
  navigate: (path: string, params?: Record<string, string>) => void;
  onOpenSettings: () => void;
  onBack: () => void;
  children: React.ReactNode;
};

const DESTINATIONS = [
  { path: 'home', label: 'Home', icon: Home },
  { path: 'library', label: 'Library', icon: Library },
] as const;

export function AppShell({ routePath, navigate, onOpenSettings, onBack, children }: AppShellProps) {
  const { open: searchOpen, changeOpen: setSearchOpen } = useHistoryDialog('search');
  const showBack = routePath !== 'home';

  const openSearch = () => setSearchOpen(true);

  return (
    <div className="torwatch-app-shell min-h-screen bg-[#0a0a0a] text-white">
      {/* Desktop: the existing shared header (Electron parity). The browser
          has no window chrome, so the header's titlebar offset is reset. */}
      <div className="sticky top-0 z-40 hidden bg-[#0a0a0a] pt-[var(--app-safe-top)] [&_header]:!top-0 lg:block">
        <AppHeader navigate={navigate} />
      </div>

      {/* Compact: slim top bar with explicit icon actions. */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/[0.08] bg-[#0a0a0a] px-4 pb-2 pt-[calc(var(--app-safe-top)+0.5rem)] lg:hidden">
        <div className="flex items-center">
        {showBack ? (
          <button type="button" onClick={onBack} aria-label="Go back" className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-white/85 ${FOCUS_RING_CLASS}`}>
            <ChevronLeft className="h-6 w-6" strokeWidth={1.7} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => navigate('home')}
          aria-label="TorWatch home"
          className={`inline-flex h-12 w-16 items-center justify-center rounded-xl ${FOCUS_RING_CLASS}`}
        >
          <img src={torWatchLogo} alt="" className="h-8 w-12 object-contain invert" />
        </button>
        </div>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Search titles"
            onClick={openSearch}
            className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-white/75 hover:bg-white/[0.08] hover:text-white ${FOCUS_RING_CLASS}`}
          >
            <Search className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Open settings"
            onClick={onOpenSettings}
            className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-white/75 hover:bg-white/[0.08] hover:text-white ${FOCUS_RING_CLASS}`}
          >
            <Settings2 className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="pb-[calc(6rem+var(--app-safe-bottom))] lg:pb-16">
        {/* Route-enter motion (M2.4): opacity/transform only, token-driven;
            reduced motion collapses the duration in CSS. Keyed by route so
            each navigation re-runs the enter animation. */}
        <div key={routePath} className="torwatch-route-enter">
          {children}
        </div>
      </main>

      {/* Compact bottom destinations: icons with small labels. */}
      <nav
        aria-label="Main destinations"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#0a0a0a] pb-[var(--app-safe-bottom)] pl-[var(--app-safe-left)] pr-[var(--app-safe-right)] lg:hidden"
      >
        <div className="flex items-stretch justify-around">
          {showBack ? (
            <button type="button" onClick={onBack} aria-label="Go back" className={`flex min-h-12 flex-1 items-center justify-center text-white/85 ${FOCUS_RING_CLASS}`}>
              <ChevronLeft className="h-6 w-6" strokeWidth={1.7} aria-hidden="true" />
            </button>
          ) : null}
          {DESTINATIONS.map((destination) => {
            const Icon = destination.icon;
            const current = routePath === destination.path;
            return (
              <button
                key={destination.path}
                type="button"
                onClick={() => navigate(destination.path)}
                aria-current={current ? 'page' : undefined}
                className={`flex min-h-[var(--touch-target)] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] transition ${FOCUS_RING_CLASS} ${
                  current ? 'text-white' : 'text-white/55 hover:text-white/85'
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
                <span>{destination.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={openSearch}
            aria-current={routePath === 'search' ? 'page' : undefined}
            className={`flex min-h-[var(--touch-target)] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] text-white/55 transition hover:text-white/85 ${FOCUS_RING_CLASS}`}
          >
            <Search className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
            <span>Search</span>
          </button>
        </div>
      </nav>

      {searchOpen ? (
        <Suspense fallback={<span className="sr-only" role="status">Opening search…</span>}>
          <GlobalSearch navigate={navigate} open={searchOpen} onOpenChange={setSearchOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
