// Browser composition root (feature 002 M2.2). This entry renders the SAME
// shared pages/components as Electron through the shared AppShell with
// injected platform ports — it is the browser-safe checkpoint of the shared
// slice, not a separate app. It never touches window.electronAPI. Fixture
// mode is EXPLICIT (`fixtures=1` in the URL) and exists only in this
// development entry; the Library fixtures are preview-only and labelled.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../globals.css';
import HomePage from '../pages/HomePage';
import { LibraryCategoryPage, LibraryPage } from '../pages/LibraryPage';
import { loadSeeAllPage, loadTitlePage } from '../lib/route-loaders';
import { AppShell } from '../components/shared/AppShell';
import { BrowseRail } from '../components/shared/BrowseRail';
import { PlatformProvider, useConnectionStatus, usePlatform } from '../platform/PlatformProvider';
import type { Platform, ServerCompatibility } from '../platform/contracts';
import { BrowserConnection, BrowserStorage, resolveBrowserOrigin } from '../platform/browser';

const TitlePage = lazy(loadTitlePage);
const SeeAllPage = lazy(loadSeeAllPage);

async function composePlatform(): Promise<{ platform: Platform; libraryProvider: import('../lib/services/library-service').LibraryProvider | null }> {
  const params = new URLSearchParams(window.location.search);
  const fixtureScenario = params.get('fixtures');
  if (fixtureScenario) {
    // Explicit, test-only: dynamically import the fixture modules so no
    // production path bundles or activates them.
    const [{ FixtureConnection, FixtureStorage, installFixtureAdapter }, { fixtureLibraryProvider, createStressLibraryFixture }, { BrowserPlayer }] = await Promise.all([
      import('../platform/fixtures'),
      import('../platform/library-fixtures'),
      import('../platform/browser'),
    ]);
    const scenario = (['ok', 'unreachable', 'incompatible', 'provider-failure'].includes(fixtureScenario)
      ? fixtureScenario
      : 'ok') as 'ok' | 'unreachable' | 'incompatible' | 'provider-failure';
    installFixtureAdapter(scenario);
    // M2.4 measurement workload: ?stress=100 scales the preview library;
    // ?stressArtwork=1 adds harness-served placeholder artwork (cached
    // after first decode) for the cached-artwork scroll workload.
    const stressCount = Number(params.get('stress'));
    const stressArtwork = params.get('stressArtwork') === '1';
    return {
      platform: {
        kind: 'fixture',
        connection: new FixtureConnection(scenario),
        storage: new FixtureStorage(),
        player: new BrowserPlayer(),
      },
      // Preview-only library data; the page renders its truthful label.
      libraryProvider: Number.isFinite(stressCount) && stressCount > 0
        ? createStressLibraryFixture(Math.min(500, stressCount), stressArtwork ? '/fixtures/artwork/' : undefined)
        : fixtureLibraryProvider,
    };
  }
  const storage = new BrowserStorage();
  const origin = resolveBrowserOrigin(window.location.search) || storage.getPreference('mw_server_origin') || '';
  const { BrowserPlayer } = await import('../platform/browser');
  return {
    platform: {
      kind: 'browser',
      connection: new BrowserConnection(storage, origin),
      storage,
      player: new BrowserPlayer(),
    },
    libraryProvider: null,
  };
}

function useHashRouter() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const navigate = (path: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    window.location.hash = query ? `${path}?${query}` : path;
  };
  return { route, navigate };
}

function parseHash(hash: string): { path: string; params: URLSearchParams } {
  const value = (hash.slice(1) || 'home').replace(/^\//, '');
  const [path, query] = value.split('?');
  return { path, params: new URLSearchParams(query || '') };
}

// Route scroll restoration: each route remembers its scroll position for
// the session; returning to a route restores it. Because a route's data can
// load asynchronously (the page grows after mount), the saved position is
// re-applied for a short bounded window unless the user scrolls first.
function useScrollRestoration(routeKey: string) {
  const positions = useRef(new Map<string, number>());
  useEffect(() => {
    const saved = positions.current.get(routeKey) ?? 0;
    // Programmatic scrolls (restore + clamps on short pages) are tracked so
    // they are never mistaken for user scrolling — the earlier grace-window
    // approach swallowed fast user scrolls and the re-apply then fought them.
    let programmaticAt = -Infinity;
    let userScrolled = false;
    const scrollToSaved = () => {
      programmaticAt = performance.now();
      window.scrollTo({ top: saved });
    };
    scrollToSaved();
    const onScroll = () => {
      if (performance.now() - programmaticAt < 60) return; // our own scroll/clamp
      userScrolled = true;
      positions.current.set(routeKey, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Bounded re-apply: async data may still be growing the page. Skipped
    // entirely once the user has scrolled (their position wins).
    const timers = [150, 400, 900].map((delay) => window.setTimeout(() => {
      if (!userScrolled) scrollToSaved();
    }, delay));
    return () => {
      if (!userScrolled) positions.current.set(routeKey, window.scrollY);
      window.removeEventListener('scroll', onScroll);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [routeKey]);
}

function BrowserApp({ libraryProvider }: { libraryProvider: import('../lib/services/library-service').LibraryProvider | null }) {
  const { route, navigate } = useHashRouter();
  const compat = useConnectionStatus();
  const { connection } = usePlatform();
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  useScrollRestoration(`${route.path}?${route.params.get('collection') ?? ''}${route.params.get('tab') ?? ''}`);

  if (compat.status !== 'ready') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <ConnectionGate compat={compat} onConnect={(origin) => connection.saveOrigin(origin)} />
      </div>
    );
  }

  const requestResume = (title: string) => {
    // Honest alpha boundary: real playback lands with the mobile player
    // (M1.3/M2.3). Nothing is saved, queued, or claimed as played.
    setResumeNotice(`Playback for “${title}” arrives with the mobile player milestone — this preview did not start or save anything.`);
  };

  return (
    <AppShell
      routePath={route.path}
      navigate={navigate}
      onOpenSettings={() => setResumeNotice('Server settings arrive with the mobile settings milestone. The server origin can be changed with the ?server= address parameter.')}
    >
      {resumeNotice ? (
        <div className="sticky top-0 z-30 mx-5 mt-3 flex items-start justify-between gap-3 rounded-xl border border-white/15 bg-[#151515] px-4 py-3 md:mx-8" role="status">
          <p className="text-sm text-white/85">{resumeNotice}</p>
          <button
            type="button"
            onClick={() => setResumeNotice(null)}
            className="min-h-8 shrink-0 rounded-full px-2 text-sm text-white/60 hover:text-white"
            aria-label="Dismiss notice"
          >
            ✕
          </button>
        </div>
      ) : null}

      <Suspense fallback={<RouteFallback />}>
        {route.path === 'home' && (
          <>
            <BrowseRailSlot navigate={navigate} />
            <HomePage
              navigate={navigate}
              continueVariant="carousel"
              onResumeRequest={(item) => requestResume(item.title || item.seriesId)}
            />
          </>
        )}
        {route.path === 'library' && (
          <LibraryPage
            navigate={navigate}
            provider={libraryProvider}
            collection={route.params.get('collection') === 'favourites' ? 'favourites' : 'watch-later'}
          />
        )}
        {route.path === 'library-category' && (
          <LibraryCategoryPage
            navigate={navigate}
            provider={libraryProvider}
            collection={(route.params.get('collection') === 'favourites' ? 'favourites' : 'watch-later')}
            kind={(route.params.get('kind') === 'series' || route.params.get('kind') === 'anime' ? route.params.get('kind') : 'movie') as 'movie' | 'series' | 'anime'}
          />
        )}
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
        {!['home', 'library', 'library-category', 'title', 'see-all'].includes(route.path) && (
          <section className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-6 text-center">
            <p className="text-sm text-white/60">This page is not available.</p>
            <h1 className="type-section-title mt-3 text-white">Return to your library</h1>
            <button
              type="button"
              onClick={() => navigate('home')}
              className="mt-7 min-h-11 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Back to TorWatch
            </button>
          </section>
        )}
      </Suspense>
    </AppShell>
  );
}

// Browse rail sits above Home content (WF02: open icon rail of categories).
function BrowseRailSlot({ navigate }: { navigate: (path: string, params?: Record<string, string>) => void }) {
  return (
    <div className="mx-auto max-w-[1600px] px-5 pt-4 md:px-8 lg:px-12">
      <BrowseRail navigate={navigate} />
    </div>
  );
}

function ConnectionGate({
  compat,
  onConnect,
}: {
  compat: ServerCompatibility;
  onConnect: (origin: string) => Promise<string>;
}) {
  const [origin, setOrigin] = useState(compat.origin);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await onConnect(origin);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="w-full max-w-md">
        {compat.status === 'checking' ? (
          <p className="type-body text-white/70" role="status">
            <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-white/70" />
            Connecting to the TorWatch server…
          </p>
        ) : (
          <>
            <h1 className="type-section-title text-white">
              {compat.status === 'incompatible' ? 'This server is not compatible' : 'The TorWatch server is unreachable'}
            </h1>
            <p className="measure-compact type-body mt-3 text-white/70">{compat.message}</p>
            <label className="mt-6 block text-left text-xs font-medium uppercase tracking-wide text-white/50" htmlFor="server-origin">
              Server address
            </label>
            <input
              id="server-origin"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="http://192.168.1.10:4001"
              className="mt-2 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            />
            {error ? <p className="mt-2 text-left text-xs text-red-400">{error}</p> : null}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending || !origin.trim()}
              className="mt-4 min-h-11 w-full rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              {pending ? 'Connecting…' : 'Connect'}
            </button>
          </>
        )}
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
      </div>
    </div>
  );
}

void composePlatform().then(({ platform, libraryProvider }) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <PlatformProvider platform={platform}>
      <BrowserApp libraryProvider={libraryProvider} />
    </PlatformProvider>,
  );
});
