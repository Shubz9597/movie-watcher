import { lazy, Suspense, useEffect, useState } from 'react';
import { RouterProvider } from './lib/router-adapter';
import AppHeader from './components/AppHeader';
import RuntimeStatusBar from './components/RuntimeStatusBar';
import TmdbConnectionGate from './components/TmdbConnectionGate';
import WindowChrome from './components/WindowChrome';
import HomePage from './pages/HomePage';
import {
  loadPlayerPage,
  loadSeeAllPage,
  loadTitlePage,
  loadWatchPage,
} from './lib/route-loaders';
import type { CatalogState } from './types/electron';

const TitlePage = lazy(loadTitlePage);
const SeeAllPage = lazy(loadSeeAllPage);
const WatchPage = lazy(loadWatchPage);
const PlayerPage = lazy(loadPlayerPage);

// Simple hash-based router
function useHashRouter() {
  const [route, setRoute] = useState(() => {
    const hash = window.location.hash.slice(1) || 'home';
    const [path, query] = hash.split('?');
    return { path, params: new URLSearchParams(query || '') };
  });

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1) || 'home';
      const [path, query] = hash.split('?');
      setRoute({ path, params: new URLSearchParams(query || '') });
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigate = (path: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    window.location.hash = query ? `${path}?${query}` : path;
  };

  return { route, navigate };
}

export default function App() {
  const { route, navigate } = useHashRouter();
  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: 'checking',
    issue: '',
    hasSavedCredential: false,
  });

  useEffect(() => {
    let active = true;
    const api = window.electronAPI;
    if (!api?.getCatalogState) {
      setCatalogState({
        status: 'needs-setup',
        issue: 'Secure settings could not be loaded. Restart TorWatch and try again.',
        hasSavedCredential: false,
      });
      return () => { active = false; };
    }
    api.getCatalogState().then((state) => {
      if (active) setCatalogState(state);
    }).catch((error) => {
      console.error('[Catalog] Could not read catalog state:', error);
      if (active) {
        setCatalogState({
          status: 'needs-setup',
          issue: 'Secure settings could not be loaded. Restart TorWatch and try again.',
          hasSavedCredential: false,
        });
      }
    });
    const unsubscribe = api.onCatalogState?.((state) => setCatalogState(state));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  if (catalogState.status !== 'ready') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <WindowChrome />
        {catalogState.status === 'checking' ? <CatalogChecking /> : <TmdbConnectionGate state={catalogState} />}
      </div>
    );
  }

  const isPlayerPage = route.path === 'player';
  const isKnownRoute = ['home', 'title', 'see-all', 'watch', 'player'].includes(route.path);

  return (
    <RouterProvider navigate={navigate}>
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <WindowChrome />
        {!isPlayerPage ? (
          <>
            <AppHeader navigate={navigate} />
            <RuntimeStatusBar />
          </>
        ) : null}
        <main className={isPlayerPage ? '' : 'pb-16'}>
          <Suspense fallback={<RouteFallback />}>
            {route.path === 'home' && <HomePage navigate={navigate} />}
            {route.path === 'title' && (
              <TitlePage
                navigate={navigate}
                kind={route.params.get('kind') || 'movie'}
                id={route.params.get('id') || ''}
                params={Object.fromEntries(route.params)}
              />
            )}
            {route.path === 'see-all' && (
              <SeeAllPage
                navigate={navigate}
                title={route.params.get('title') || 'Browse'}
                api={route.params.get('api') || ''}
                kind={route.params.get('kind') || 'movie'}
              />
            )}
            {route.path === 'watch' && (
              <WatchPage
                navigate={navigate}
                params={Object.fromEntries(route.params)}
              />
            )}
            {route.path === 'player' && (
              <PlayerPage
                navigate={navigate}
                params={Object.fromEntries(route.params)}
              />
            )}
          </Suspense>
          {!isKnownRoute && (
            <section className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-6 text-center">
              <p className="text-sm text-white/60">This page is not available.</p>
              <h1 className="type-section-title mt-3 text-white">Return to your library</h1>
              <p className="measure-compact type-body mt-4 text-white/70">
                The link may be outdated or incomplete. Your library and viewing progress are still available.
              </p>
              <button
                type="button"
                onClick={() => navigate('home')}
                className="mt-7 min-h-11 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Back to TorWatch
              </button>
            </section>
          )}
        </main>
      </div>
    </RouterProvider>
  );
}

function CatalogChecking() {
  return (
    <main className="flex min-h-[calc(100vh-40px)] items-center justify-center px-6" role="status">
      <div className="flex items-center gap-3 text-sm text-white/55">
        <span className="h-2 w-2 animate-pulse rounded-full bg-white/70" />
        Checking TMDb…
      </div>
    </main>
  );
}

function RouteFallback() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-[1600px] items-center px-5 md:px-8 xl:px-12" role="status">
      <div className="w-full max-w-xl animate-pulse" aria-label="Loading view">
        <div className="h-3 w-24 rounded bg-white/10" />
        <div className="mt-6 h-12 w-3/4 rounded bg-white/10" />
        <div className="mt-6 h-4 w-full rounded bg-white/[0.06]" />
        <div className="mt-3 h-4 w-2/3 rounded bg-white/[0.06]" />
      </div>
    </div>
  );
}



