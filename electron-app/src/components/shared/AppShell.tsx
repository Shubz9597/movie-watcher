// AppShell (feature 002 M2.2, WF01/03): the responsive shared shell.
// Compact widths get an icon top bar plus a bottom destination bar
// (Home/Library/Search, icons with small labels, 48px targets); desktop
// widths render the existing AppHeader so the Electron layout is unchanged.
// Back (design-system.md: detail uses Back): tab destinations show the logo;
// every pushed detail screen shows one back chevron in the same place, the
// iOS navigation-bar convention. Gesture/hardware back still works.
import { ChevronLeft, Download, Home, Library, Search, Settings2 } from 'lucide-react';
import AppHeader from '../AppHeader';
import { ConnectionChip } from './ConnectionChip';
import torWatchLogo from '../../assets/torwatch-app-icon.png';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import { useSearchViewport } from '../../lib/use-search-viewport';

type AppShellProps = {
  routePath: string;
  navigate: (path: string, params?: Record<string, string>) => void;
  onOpenSettings: () => void;
  onBack: () => void;
  /** Offline-downloads C03/C04: show the Downloads destination only on
   *  clients with the native downloads capability. Absence keeps the
   *  existing Home/Library/Search navigation for unaffected clients. */
  downloadsAvailable?: boolean;
  children: React.ReactNode;
};

const DESTINATIONS = [
  { path: 'home', label: 'Home', icon: Home },
  { path: 'library', label: 'Library', icon: Library },
] as const;

export function AppShell({ routePath, navigate, onOpenSettings, onBack, downloadsAvailable, children }: AppShellProps) {
  const search = routePath === 'search';
  const tabRoot = ['home', 'library', 'search', 'downloads'].includes(routePath);
  const frame = useSearchViewport(search);


  return (
    <div className={`torwatch-app-shell bg-[#0a0a0a] text-white ${search ? `search-frame${frame.keyboardOpen ? ' search-keyboard-open' : ''}` : 'min-h-screen'}`} style={search ? { height: frame.height, top: frame.top } : undefined}>
      {/* Desktop: the existing shared header (Electron parity). The browser
          has no window chrome, so the header's titlebar offset is reset. */}
      <div className="sticky top-0 z-40 hidden bg-[#0a0a0a] pt-[var(--app-safe-top)] [&_header]:!top-0 lg:block">
        <AppHeader navigate={navigate} />
      </div>

      {/* Compact: slim top bar — logo on tab roots, back on detail screens. */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/[0.08] bg-[#0a0a0a] px-4 pb-2 pt-[calc(var(--app-safe-top)+0.5rem)] lg:hidden">
        <div className="flex items-center">
          {!tabRoot ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className={`-ml-2 inline-flex h-12 w-12 items-center justify-center rounded-lg text-white ${FOCUS_RING_CLASS}`}
            >
              <ChevronLeft className="h-7 w-7" strokeWidth={1.8} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigate('home')}
              aria-label="TorWatch home"
              className={`inline-flex h-12 w-12 items-center justify-center rounded-xl ${FOCUS_RING_CLASS}`}
            >
              {/* -translate-y-1: the icon artwork sits low inside its PNG;
                  optically centered against the row of 44px action buttons. */}
              <img src={torWatchLogo} alt="" className="h-9 w-9 -translate-y-1 object-contain" />
            </button>
          )}
          {/* M1.4 UI pass: connection status at a glance (mobile header). */}
          <ConnectionChip onOpenSettings={onOpenSettings} />
        </div>
        <div className="flex items-center">
          {!search ? (
            <button
              type="button"
              aria-label="Search titles"
              onClick={() => navigate('search')}
              className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-white/75 hover:bg-white/[0.08] hover:text-white ${FOCUS_RING_CLASS}`}
            >
              <Search className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
            </button>
          ) : null}
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

      {/* Compact bottom destinations: icons with small labels. The legacy
          back button is removed (M1.4 UI pass). */}
      <nav
        aria-label="Main destinations"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--hairline)] bg-[#0a0a0a] pt-2 pb-[calc(var(--app-safe-bottom)+0.5rem)] pl-[var(--app-safe-left)] pr-[var(--app-safe-right)] lg:hidden"
      >
        <div className="flex items-stretch justify-around">
          {DESTINATIONS.map((destination) => {
            const Icon = destination.icon;
            const current = routePath === destination.path;
            return (
              <button
                key={destination.path}
                type="button"
                onClick={() => navigate(destination.path)}
                aria-current={current ? 'page' : undefined}
                className={`flex min-h-[var(--touch-target)] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs transition ${FOCUS_RING_CLASS} ${
                  current ? 'font-semibold text-white' : 'font-normal text-white/60 hover:text-white/85'
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
                <span>{destination.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => navigate('search')}
            aria-current={routePath === 'search' ? 'page' : undefined}
            className={`flex min-h-[var(--touch-target)] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs transition ${FOCUS_RING_CLASS} ${
              routePath === 'search' ? 'font-semibold text-white' : 'font-normal text-white/60 hover:text-white/85'
            }`}
          >
            <Search className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
            <span>Search</span>
          </button>
          {downloadsAvailable ? (
            <button
              type="button"
              onClick={() => navigate('downloads')}
              aria-current={routePath === 'downloads' ? 'page' : undefined}
              className={`flex min-h-[var(--touch-target)] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs transition ${FOCUS_RING_CLASS} ${
                routePath === 'downloads' ? 'font-semibold text-white' : 'font-normal text-white/60 hover:text-white/85'
              }`}
            >
              <Download className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
              <span>Downloads</span>
            </button>
          ) : null}
        </div>
      </nav>
    </div>
  );
}
