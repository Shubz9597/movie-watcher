// Browser composition root (feature 002 M2.2). This entry renders the SAME
// shared pages/components as Electron through the shared AppShell with
// injected platform ports — it is the browser-safe checkpoint of the shared
// slice, not a separate app. It never touches window.electronAPI. Fixture
// mode is EXPLICIT (`fixtures=1` in the URL) and exists only in this
// development entry; the Library fixtures are preview-only and labelled.
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactElement, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import '../globals.css';
import HomePage from '../pages/HomePage';
import { LibraryCategoryPage, LibraryPage } from '../pages/LibraryPage';
import { RecommendationRow, RecommendationsAllPage as SharedRecommendationsAllPage } from '../components/shared/RecommendationRow';
import { LibraryToggle } from '../components/shared/LibraryToggle';
import { LibraryContextProvider } from '../lib/library-react';
import { LibraryStore } from '../lib/library-store';
import { attachLibrarySync, type LibrarySync } from '../lib/library-sync';
import { getDeviceId } from '../lib/device-id';
import { loadPlayerPage, loadRecommendationsPage, loadSeeAllPage, loadTitlePage } from '../lib/route-loaders';
import { RouterProvider } from '../lib/router-adapter';
import { AppShell } from '../components/shared/AppShell';
import { goBackHash, initializeHashNavigation, navigateHash } from '../lib/hash-navigation';
import { PlatformProvider, useConnectionStatus, usePlatform } from '../platform/PlatformProvider';
import type { Platform, ServerCompatibility } from '../platform/contracts';
import { BrowserConnection, BrowserStorage, resolveBrowserOrigin } from '../platform/browser';
import { connectionFailureMessage } from '../lib/connection-diagnostics';

const TitlePage = lazy(loadTitlePage);
const SeeAllPage = lazy(loadSeeAllPage);
const PlayerPage = lazy(loadPlayerPage);
const RecommendationsAllPage = lazy(loadRecommendationsPage);

export async function composePlatform(): Promise<{
  platform: Platform;
  // M1.4: the mobile shell reuses the composition's storage adapter.
  storage: import('../platform/contracts').DeviceStorage;
  libraryProvider: import('../lib/services/library-service').LibraryProvider | null;
  // Server-backed library controller. M3.4: enabled for BOTH production
  // browser/phone mode and explicit fixture mode (the fixture path injects a
  // deterministic controller for captures/tests). No local fork exists.
  libraryController: import('../lib/library-store').LibraryController | null;
  librarySync?: LibrarySync;
  // M4.2 capture fixture transport (dev-only).
  recsFetch?: typeof fetch;
}> {
  const params = new URLSearchParams(window.location.search);
  const fixtureScenario = params.get('fixtures');
  if (fixtureScenario) {
    // Explicit, test-only: dynamically import the fixture modules so no
    // production path bundles or activates them.
    const [{ FixtureConnection, FixtureStorage, installFixtureAdapter }, { fixtureLibraryProvider, createStressLibraryFixture, createLibraryStateFixture }, { createRecommendationsFixtureFetch }, { BrowserPlayer }] = await Promise.all([
      import('../platform/fixtures'),
      import('../platform/library-fixtures'),
      import('../platform/recommendation-fixtures'),
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
    // M3.3 capture workload: ?library=<scenario> drives the REAL shared
    // Library surfaces through a deterministic state fixture.
    const libraryScenario = params.get('library');
    // M4.2 capture workload: ?recs=<scenario> drives the REAL recommendation
    // surfaces through the deterministic contract fixture.
    const recsScenario = params.get('recs');
    const fixtureStorage = new FixtureStorage();
    return {
      platform: {
        kind: 'fixture',
        connection: new FixtureConnection(scenario),
        storage: fixtureStorage,
        player: new BrowserPlayer(),
      },
      // Preview-only library data; the page renders its truthful label.
      libraryProvider: Number.isFinite(stressCount) && stressCount > 0
        ? createStressLibraryFixture(Math.min(500, stressCount), stressArtwork ? '/fixtures/artwork/' : undefined)
        : fixtureLibraryProvider,
      libraryController: libraryScenario && libraryScenario !== 'none' ? createLibraryStateFixture(libraryScenario) : null,
      storage: fixtureStorage,
      recsFetch: recsScenario ? createRecommendationsFixtureFetch(recsScenario) : undefined,
    };
  }
  const storage = new BrowserStorage();
  const origin = resolveBrowserOrigin(window.location.search) || storage.getPreference('mw_server_origin') || '';
  const { BrowserPlayer } = await import('../platform/browser');
  // M3.4: the phone/browser entry now uses the SAME server-backed library
  // store as desktop — no duplicate screen tree, no local fork. Availability
  // is gated on the server's library.household.v1 capability; older or
  // unreachable servers surface the explicit library-unavailable state.
  const libraryStore = new LibraryStore();
  // Capability discovery must not hold the first render hostage. The store
  // already models checking/unavailable states and notifies its subscribers
  // when this finishes.
  void libraryStore.refreshCapability().catch((error: unknown) => {
    console.error('[Library] Initial capability check failed:', error);
  });
  const librarySync = attachLibrarySync(libraryStore);
  return {
    platform: {
      kind: 'browser',
      connection: new BrowserConnection(storage, origin),
      storage,
      player: new BrowserPlayer(),
    },
    // M1.4: the mobile shell reuses the SAME composition and needs the
    // storage adapter for its settings surface.
    storage,
    libraryProvider: null,
    libraryController: libraryStore,
    librarySync,
  };
}

function useHashRouter() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    initializeHashNavigation(window);
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);
  const navigate = useCallback((path: string, params: Record<string, string> = {}) => navigateHash(window, path, params), []);
  const goBack = useCallback(() => goBackHash(window), []);
  return { route, navigate, goBack };
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

function BrowserApp({
  libraryProvider,
  libraryController,
  recsFetch,
}: {
  libraryProvider: import('../lib/services/library-service').LibraryProvider | null;
  libraryController: import('../lib/library-store').LibraryController | null;
  recsFetch?: typeof fetch;
}) {
  const { route, navigate, goBack } = useHashRouter();
  const compat = useConnectionStatus();
  const { connection } = usePlatform();
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  useScrollRestoration(`${route.path}?${route.params.toString()}`);

  if (compat.status !== 'ready') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <ConnectionGate compat={compat} onConnect={(origin) => connection.saveOrigin(origin)} />
      </div>
    );
  }

  const requestResume = (item: {
    title: string;
    seriesId: string;
    season: number;
    episode: number;
    kind: 'movie' | 'tv' | 'anime';
    tmdbId?: number;
    anilistId?: number;
    malId?: number;
  }) => {
    const kind = item.kind || (item.seriesId.startsWith('tmdb:movie:') ? 'movie' : item.seriesId.startsWith('tmdb:tv:') ? 'tv' : 'anime');
    const id = kind === 'anime' ? item.anilistId : item.tmdbId;
    if (!id) {
      setResumeNotice(`TorWatch could not identify “${item.title || item.seriesId}”. Open it from Library and choose the source again.`);
      return;
    }
    const params: Record<string, string> = {
      kind,
      id: String(id),
      resumeSubjectId: getDeviceId(),
      resumeSeriesId: item.seriesId,
      resumeSeason: String(item.season),
      resumeEpisode: String(item.episode),
    };
    if (item.malId) params.malId = String(item.malId);
    navigate('title', params);
  };

  return (
    <LibraryContextProvider store={libraryController}>
    <RouterProvider navigate={navigate} goBack={goBack}>
    <AppShell
      routePath={route.path}
      navigate={navigate}
      onBack={goBack}
      onOpenSettings={() => window.dispatchEvent(new CustomEvent('torwatch:open-settings'))}
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
            ×
          </button>
        </div>
      ) : null}

      <Suspense fallback={<RouteFallback />}>
        {route.path === 'home' && (
          <>
            <HomePage
              navigate={navigate}
              continueVariant="carousel"
              onResumeRequest={requestResume}
              recommendationDeps={recsFetch ? { fetchImpl: recsFetch } : undefined}
            />
          </>
        )}
        {route.path === 'library' && (
          <LibraryPage
            navigate={navigate}
            library={libraryController}
            provider={libraryProvider}
            collection={route.params.get('collection') === 'favourites' ? 'favourites' : 'watch-later'}
            sort={route.params.get('sort') === 'title' ? 'title' : 'recent'}
          />
        )}
        {route.path === 'library-category' && (
          <LibraryCategoryPage
            navigate={navigate}
            library={libraryController}
            provider={libraryProvider}
            collection={(route.params.get('collection') === 'favourites' ? 'favourites' : 'watch-later')}
            kind={(route.params.get('kind') === 'series' || route.params.get('kind') === 'anime' ? route.params.get('kind') : 'movie') as 'movie' | 'series' | 'anime'}
            sort={route.params.get('sort') === 'title' ? 'title' : 'recent'}
          />
        )}
        {/* Dev-only (fixture entry): the REAL LibraryToggle pair inside the
            title-action toolbar arrangement, driven by the fixture library
            state, so toggle states are capturable without the Electron app. */}
        {route.path === 'library-states' && (
          <ToggleStateCapture />
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
        {route.path === 'player' && (
          <PlayerPage navigate={navigate} params={Object.fromEntries(route.params)} />
        )}
        {/* Dev-only (fixture entry): the REAL recommendations surfaces driven
            by the deterministic fixture fetch (?recs=<scenario>), so the
            M4.2 states are capturable without a backend. */}
        {route.path === 'recommendations' && recsFetch ? (
          <SharedRecommendationsAllPage navigate={navigate} deps={{ fetchImpl: recsFetch }} />
        ) : route.path === 'recommendations' ? (
          <RecommendationsAllPage navigate={navigate} />
        ) : null}
        {route.path === 'recommendations-states' && recsFetch ? (
          <div className="mx-auto max-w-[1600px] space-y-10 px-5 py-6 md:px-8">
            <RecommendationRow navigate={navigate} deps={{ fetchImpl: recsFetch }} />
            <SharedRecommendationsAllPage navigate={navigate} deps={{ fetchImpl: recsFetch }} />
          </div>
        ) : null}
        {!['home', 'library', 'library-category', 'library-states', 'recommendations-states', 'title', 'see-all', 'player', 'recommendations'].includes(route.path) && (
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
    </RouterProvider>
    </LibraryContextProvider>
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
    const candidate = normalizedServerOrigin(origin);
    if (!candidate) {
      setError('Enter a complete server address, such as http://192.168.1.50:4001.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConnect(candidate);
    } catch (err) {
      console.error('[Connection] Server address could not be applied:', err);
      setError(connectionFailureMessage(err, candidate));
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
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="mt-2 min-h-12 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-base text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            />
            {error ? <p className="mt-3 text-left text-sm text-red-300" role="alert">{error}</p> : null}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending || !origin.trim()}
              className="mt-4 min-h-12 w-full rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              {pending ? 'Connecting…' : 'Connect'}
            </button>
          </>
        )}
      </div>
    </main>
  );
}

function normalizedServerOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/u, '');
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        !parsed.hostname || parsed.username || parsed.password || parsed.search ||
        parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
      return null;
    }
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return null;
  }
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[App] View rendering failed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 text-center text-white">
        <div className="w-full max-w-md">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/45">App view failed</p>
          <h1 className="type-section-title mt-3 text-white">TorWatch couldn’t open this screen</h1>
          <p className="type-body mt-3 text-white/70">
            The server connected, but the app hit an unexpected display error. Your library data is safe.
          </p>
          <div className="mt-7 grid gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-12 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Reload app
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('torwatch:open-settings'))}
              className="min-h-12 rounded-full border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Server settings
            </button>
          </div>
        </div>
      </main>
    );
  }
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

// Dev-only toggle-state capture composition (fixture entry): the REAL
// LibraryToggle components in the title-action toolbar arrangement. The
// scenario comes from the ?library= fixture parameter.
function ToggleStateCapture() {
  const canonicalId = 'tmdb:movie:693134';
  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8 lg:px-12">
      <h1 className="type-section-title text-white">Dune: Part Two</h1>
<p className="mt-1 text-sm text-white/55">2024 · Movie</p>
      <div className="mt-6 flex items-center gap-2" aria-label="Title actions">
        <LibraryToggle canonicalId={canonicalId} field="watch-later" />
        <LibraryToggle canonicalId={canonicalId} field="favourites" />
        <span className="mx-2 h-6 w-px bg-white/15" aria-hidden="true" />
        <span className="text-sm text-white/65" role="note">
          Save states: {new URLSearchParams(window.location.search).get('library')}
        </span>
      </div>
    </section>
  );
}

/**
 * Shared app element factory (M1.4 repair): the mobile shell renders the SAME
 * element through its single page-lifetime React root (alongside its settings
 * overlay) instead of creating competing roots.
 */
export function sharedAppElement(composed: {
  platform: Platform;
  libraryProvider: import('../lib/services/library-service').LibraryProvider | null;
  libraryController: import('../lib/library-store').LibraryController | null;
  librarySync?: LibrarySync;
  recsFetch?: typeof fetch;
}): ReactElement {
  // The sync controller lives for the page lifetime; the store itself clears
  // origin-scoped state on switch through its own subscription.
  void composed.librarySync;
  return (
    <PlatformProvider platform={composed.platform}>
      <AppErrorBoundary>
        <BrowserApp
          libraryProvider={composed.libraryProvider}
          libraryController={composed.libraryController}
          recsFetch={composed.recsFetch}
        />
      </AppErrorBoundary>
    </PlatformProvider>
  );
}

/**
 * Browser-entry mount: one root for the page lifetime (auto-start below).
 * The mobile entry uses sharedAppElement with its own single root.
 */
export function mountSharedApp(composed: Parameters<typeof sharedAppElement>[0]): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(sharedAppElement(composed));
}

// Auto-start ONLY for the genuine browser entry: the mobile bundle sets the
// flag before importing this module so exactly one composition root exists.
if (!(window as unknown as { __TORWATCH_MOBILE_ENTRY?: boolean }).__TORWATCH_MOBILE_ENTRY) {
  void composePlatform().then(mountSharedApp).catch((error: unknown) => {
    console.error('[App] Browser startup failed:', error);
    const rootElement = document.getElementById('root');
    if (rootElement) {
      ReactDOM.createRoot(rootElement).render(
        <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 text-center text-white">
          <div className="max-w-md">
            <h1 className="type-section-title">TorWatch could not start</h1>
            <p className="type-body mt-3 text-white/70">Reload the app. If this continues, verify the saved server address.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-7 min-h-12 rounded-full bg-white px-6 text-sm text-black">Reload app</button>
          </div>
        </main>,
      );
    }
  });
}
