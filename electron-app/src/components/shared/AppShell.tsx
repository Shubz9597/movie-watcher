// AppShell (feature 002 M2.2, WF01/03): the responsive shared shell.
// Compact widths get an icon top bar plus a bottom destination bar
// (Home/Library/Search, icons with small labels, 48px targets); desktop
// widths render the existing AppHeader so the Electron layout is unchanged.
// M1.4 UI pass: shell-level back chevrons (top bar + bottom nav) are REMOVED
// — pages own their back affordance ("‹ Label" row, e.g. "‹ Library"), the
// pattern users expect; hardware/gesture back still works everywhere.
import { Home, Library, Search, Settings2 } from 'lucide-react';
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
  children: React.ReactNode;
};

const DESTINATIONS = [
  { path: 'home', label: 'Home', icon: Home },
  { path: 'library', label: 'Library', icon: Library },
] as const;

export function AppShell({ routePath, navigate, onOpenSettings, onBack, children }: AppShellProps) {
  void onBack; // pages own back affordances now; kept for interface stability
  const search = routePath === 'search';
  const frame = useSearchViewport(search);


  return (
    <div className={`torwatch-app-shell bg-[#0a0a0a] text-white ${search ? `search-frame${frame.keyboardOpen ? ' search-keyboard-open' : ''}` : 'min-h-screen'}`} style={search ? { height: frame.height, top: frame.top } : undefined}>
      {/* Desktop: the existing shared header (Electron parity). The browser
          has no window chrome, so the header's titlebar offset is reset. */}
      <div className="sticky top-0 z-40 hidden bg-[#0a0a0a] pt-[var(--app-safe-top)] [&_header]:!top-0 lg:block">
        <AppHeader navigate={navigate} />
      </div>

      {/* Compact: slim top bar with explicit icon actions. No back chevron —
          pages render their own "‹ Label" back row. */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/[0.08] bg-[#0a0a0a] px-4 pb-2 pt-[calc(var(--app-safe-top)+0.5rem)] lg:hidden">
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => navigate('home')}
            aria-label="TorWatch home"
            className={`inline-flex h-12 w-16 items-center justify-center rounded-xl ${FOCUS_RING_CLASS}`}
          >
            <img src={torWatchLogo} alt="" className="h-9 w-9 object-contain" />
          </button>
          {/* M1.4 UI pass: connection status at a glance (mobile header). */}
          <ConnectionChip onOpenSettings={onOpenSettings} />
        </div>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Search titles"
            onClick={() => navigate('search')}
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

      {/* Compact bottom destinations: icons with small labels. The legacy
          back button is removed (M1.4 UI pass). */}
      <nav
        aria-label="Main destinations"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#0a0a0a] pt-2 pb-[calc(var(--app-safe-bottom)+0.5rem)] pl-[var(--app-safe-left)] pr-[var(--app-safe-right)] lg:hidden"
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
            onClick={() => navigate('search')}
            aria-current={routePath === 'search' ? 'page' : undefined}
            className={`flex min-h-[var(--touch-target)] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] transition ${FOCUS_RING_CLASS} ${
              routePath === 'search' ? 'text-white' : 'text-white/55 hover:text-white/85'
            }`}
          >
            <Search className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
            <span>Search</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
