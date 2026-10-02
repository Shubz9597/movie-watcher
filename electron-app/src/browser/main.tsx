// Browser composition root (feature 002 M2.2). This entry renders the SAME
// shared pages/components as Electron through the shared AppShell with
// injected platform ports - it is the browser-safe checkpoint of the shared
// slice, not a separate app. It never touches window.electronAPI. Fixture
// mode is EXPLICIT (`fixtures=1` in the URL) and exists only in this
// development entry; the Library fixtures are preview-only and labelled.
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactElement, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { X } from 'lucide-react';
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
import { LaunchScreen } from '../components/shared/LaunchScreen';
import { resolveLaunch, type LaunchDecision, type DeepLinkIntent } from '../lib/launch-policy';
import type { Platform, DeviceStorage, DownloadsPort } from '../platform/contracts';
import { BrowserConnection, BrowserStorage, resolveBrowserOriginSource } from '../platform/browser';

const TitlePage = lazy(loadTitlePage);
const SeeAllPage = lazy(loadSeeAllPage);
const PlayerPage = lazy(loadPlayerPage);
const SearchPage = lazy(() => import('../pages/SearchPage'));
const DownloadsPage = lazy(() => import('../pages/DownloadsPage'));
const RecommendationsAllPage = lazy(loadRecommendationsPage);

// Composition-time launch input (offline-downloads C03): the entry resolves
// the initial surface from configuration, local inventory and saved tab via
// the pure launch policy — never from reachability.
export type LaunchComposition = {
  surface: LaunchDecision['surface'];
  tab?: Extract<LaunchDecision, { surface: 'shell' }>['tab'];
  downloadsAvailable: boolean;
};

export async function composePlatform(overrides?: {
  // Local downloads port provided by the entry (mobile native adapter). The
  // browser entry has none: a browser must not imply it can save files
  // offline.
  downloads?: DownloadsPort;
}): Promise<{
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
  // C03: resolved initial surface/tab and Downloads-tab availability.
  launch: LaunchComposition;
}> {
  const params = new URLSearchParams(window.location.search);
  const fixtureScenario = params.get('fixtures');
  if (fixtureScenario) {
    // Explicit, test-only: dynamically import the fixture modules so no
    // production path bundles or activates them.
    const [{ FixtureConnection, FixtureStorage, installFixtureAdapter, FixtureDownloads }, { fixtureLibraryProvider, createStressLibraryFixture, createLibraryStateFixture }, { createRecommendationsFixtureFetch }, { BrowserPlayer }] = await Promise.all([
      import('../platform/fixtures'),
      import('../platform/library-fixtures'),
      import('../platform/recommendation-fixtures'),
      import('../platform/browser'),
    ]);
    const scenario = (['ok', 'unreachable', 'incompatible', 'provider-failure'].includes(fixtureScenario)
      ? fixtureScenario
      : 'ok') as 'ok' | 'unreachable' | 'incompatible' | 'provider-failure';
    installFixtureAdapter(scenario);
    // Offline-downloads C fixture preview: ?downloads=items|empty|storage-error
    // drives the REAL Downloads surfaces through the deterministic fixture.
    const downloadsScenario = params.get('downloads');
    const downloads: DownloadsPort | undefined = ['items', 'empty', 'storage-error'].includes(downloadsScenario ?? '')
      ? new FixtureDownloads(downloadsScenario as 'items' | 'empty' | 'storage-error')
      : undefined;
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
        downloads,
      },
      // Preview-only library data; the page renders its truthful label.
      libraryProvider: Number.isFinite(stressCount) && stressCount > 0
        ? createStressLibraryFixture(Math.min(500, stressCount), stressArtwork ? '/fixtures/artwork/' : undefined)
        : fixtureLibraryProvider,
      libraryController: libraryScenario && libraryScenario !== 'none' ? createLibraryStateFixture(libraryScenario) : null,
      storage: fixtureStorage,
      recsFetch: recsScenario ? createRecommendationsFixtureFetch(recsScenario) : undefined,
      // Fixture previews always render the shell (their scenario drives
      // availability); the downloads tab exists only with an explicit
      // downloads fixture.
      launch: { surface: 'shell', tab: 'home', downloadsAvailable: downloads !== undefined },
    };
  }
  const storage = new BrowserStorage();
  // C1: the resolved origin carries whether it is durable saved configuration
  // (a `?server=` preview parameter or empty default is NOT configured setup).
  const { origin, configured } = resolveBrowserOriginSource(window.location.search);
  const { BrowserPlayer } = await import('../platform/browser');
  // M3.4: the phone/browser entry now uses the SAME server-backed library
  // store as desktop - no duplicate screen tree, no local fork. Availability
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
  const downloads = overrides?.downloads;
  // C03: resolve the initial surface from configuration + local inventory
  // (read WITHOUT network) + saved tab via the pure launch policy. The
  // startup splash covers this bounded, local read.
  const launch = await resolveLaunchComposition({ storage, downloads, configured, origin });
  return {
    platform: {
      kind: 'browser',
      connection: new BrowserConnection(storage, origin, configured),
      storage,
      player: new BrowserPlayer(),
      downloads,
    },
    // M1.4: the mobile shell reuses the SAME composition and needs the
    // storage adapter for its settings surface.
    storage,
    libraryProvider: null,
    libraryController: libraryStore,
    librarySync,
    launch,
  };
}

/**
 * C03 launch resolution: pure-policy inputs only. Configuration comes from
 * durable storage (a read failure is a recovery state, never first install);
 * the local inventory is read without any network request; reachability is
 * NOT consulted. A hash route is the deep link — explicit links already land
 * on their route through the hash router, so the policy resolves the default
 * tab with no deep-link override.
 */
async function resolveLaunchComposition(deps: {
  storage: DeviceStorage;
  downloads?: DownloadsPort;
  configured: boolean;
  origin: string;
}): Promise<LaunchComposition> {
  let inventory: import('../platform/contracts').DownloadsInventory;
  try {
    inventory = deps.downloads ? await deps.downloads.inventory() : { available: false, unreadable: false, items: [] };
  } catch (error) {
    console.error('[Launch] Local inventory read failed:', error);
    inventory = { available: Boolean(deps.downloads), unreadable: true, items: [] };
  }
  const savedOrigin = deps.storage.getPreference('mw_server_origin');
  const configReadError = deps.storage.lastError != null;
  const decision = resolveLaunch({
    // Durable saved configuration wins over the fallback resolution: a
    // previously configured user who ALSO passed ?server= is still configured.
    configuration: configReadError
      ? { kind: 'read-error' }
      : savedOrigin
        ? { kind: 'present', origin: savedOrigin }
        : deps.configured
          ? { kind: 'present', origin: deps.origin }
          : { kind: 'missing' },
    inventory: inventory.unreadable
      ? { kind: 'read-error' }
      : inventory.items.length > 0
        ? { kind: 'ready-exists' }
        : { kind: 'empty' },
    savedTab: deps.storage.getPreference('mw_last_tab'),
    deepLink: { kind: 'none' } as DeepLinkIntent,
    downloadsTabAvailable: inventory.available,
  });
  return {
    surface: decision.surface,
    tab: decision.surface === 'shell' ? decision.tab : decision.surface === 'downloads' ? 'downloads' : undefined,
    downloadsAvailable: inventory.available,
  };
}

function useHashRouter(initialTab: string) {
  const [route, setRoute] = useState(() => parseHash(window.location.hash, initialTab));
  useEffect(() => {
    initializeHashNavigation(window);
    const onHashChange = () => setRoute(parseHash(window.location.hash, initialTab));
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, [initialTab]);
  const navigate = useCallback((path: string, params: Record<string, string> = {}, options?: { replace?: boolean }) => navigateHash(window, path, params, options?.replace ?? false), []);
  const goBack = useCallback(() => goBackHash(window), []);
  return { route, navigate, goBack };
}

function parseHash(hash: string, fallback = 'home'): { path: string; params: URLSearchParams } {
  const value = (hash.slice(1) || fallback).replace(/^\//, '');
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
    // they are never mistaken for user scrolling - the earlier grace-window
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
  launch,
}: {
  libraryProvider: import('../lib/services/library-service').LibraryProvider | null;
  libraryController: import('../lib/library-store').LibraryController | null;
  recsFetch?: typeof fetch;
  launch: LaunchComposition;
}) {
  const { route, navigate, goBack } = useHashRouter(launch.tab ?? 'home');
  const compat = useConnectionStatus();
  const { connection, storage } = usePlatform();
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  // First-run connect transition: after a successful setup save the shell
  // mounts for the rest of the session (a reload resolves 'shell' from
  // durable configuration).
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  // rerender-memo-with-default-value: stable deps object so the memoized
  // recommendation components don't re-render (or refetch) on every render.
  const recommendationDeps = useMemo(() => (recsFetch ? { fetchImpl: recsFetch } : undefined), [recsFetch]);
  useScrollRestoration(`${route.path}?${route.params.toString()}`);

  // C03: persist the last valid top-level destination so the next launch
  // restores it (launch policy input; expired playback routes are never
  // auto-resumed because only destinations are persisted).
  useEffect(() => {
    if (['home', 'library', 'search', 'downloads'].includes(route.path)) {
      storage.setPreference('mw_last_tab', route.path);
    }
  }, [route.path, storage]);

  const onOpenSettings = useCallback(() => window.dispatchEvent(new CustomEvent('torwatch:open-settings')), []);
  // WF02/spec C2: unreachable and incompatible servers both collapse Home
  // into the recovery block; Downloads stays an ordinary local page.
  const serverDown = compat.status === 'unreachable' || compat.status === 'incompatible';
  const onRetry = useCallback(() => {
    if (retrying) return;
    setRetrying(true);
    void connection.check().finally(() => setRetrying(false));
  }, [connection, retrying]);

  // WF01: the full-screen setup screen renders ONLY for first installation
  // (no saved configuration, no local downloads). A configured user ALWAYS
  // gets the shell; outages surface contextually (WF02 on Home, slim banner
  // elsewhere) and never unmount the app back to setup.
  if (launch.surface === 'config-error' && connectedAt === null) {
    return <ConfigErrorScreen />;
  }
  if (launch.surface === 'setup' && connectedAt === null) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <LaunchScreen
          compat={compat}
          onConnect={async (origin) => {
            const saved = await connection.saveOrigin(origin);
            setConnectedAt(Date.now());
            return saved;
          }}
        />
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
      setResumeNotice(`TorWatch could not identify -${item.title || item.seriesId}-. Open it from Library and choose the source again.`);
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
    {route.path === 'player' ? (
      <Suspense fallback={<div className="fixed inset-0 z-[200] bg-black" role="status" aria-label="Opening player" />}>
        <PlayerPage navigate={navigate} params={Object.fromEntries(route.params)} />
      </Suspense>
    ) : (
    <AppShell
      routePath={route.path}
      navigate={navigate}
      onBack={goBack}
      onOpenSettings={onOpenSettings}
      downloadsAvailable={launch.downloadsAvailable}
    >
      {/* WF02: on Home a server failure collapses the whole page into ONE
          recovery block (Server unavailable / Retry / Go to settings) instead
          of repeating errors per rail. Other routes keep the slim banner
          (WF07: stay on the current route; local media stays playable). */}
      {route.path === 'home' && serverDown ? (
        <HomeRecovery incompatible={compat.status === 'incompatible'} retrying={retrying} onRetry={onRetry} onOpenSettings={onOpenSettings} />
      ) : null}
      {route.path !== 'home' && route.path !== 'downloads' && serverDown ? (
        <div className="sticky top-0 z-30 flex items-center justify-center gap-2 bg-[#ffc285]/10 px-4 py-2 text-sm text-[#ffc285]" role="status">
          <span className="inline-block h-2 w-2 rounded-full bg-[#ffc285] motion-safe:animate-pulse" aria-hidden="true" />
          {compat.status === 'incompatible' ? 'Server needs an update' : 'Reconnecting…'}
        </div>
      ) : null}
      {resumeNotice ? (
        <div className="sticky top-0 z-30 mx-5 mt-3 flex items-center justify-between gap-3 rounded-lg border border-white/15 bg-[var(--surface-raised)] py-1 pl-4 pr-1 md:mx-8" role="status">
          <p className="text-sm text-white/85">{resumeNotice}</p>
          <button
            type="button"
            onClick={() => setResumeNotice(null)}
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-white/70 hover:text-white"
            aria-label="Dismiss notice"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <Suspense fallback={<RouteFallback />}>
        {route.path === 'home' && !serverDown && (
          <>
            <HomePage
              navigate={navigate}
              continueVariant="carousel"
              onResumeRequest={requestResume}
              recommendationDeps={recommendationDeps}
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
        {route.path === 'search' && <SearchPage navigate={navigate} />}
        {/* WF06: the direct route to local media — works without a server. */}
        {route.path === 'downloads' && <DownloadsPage navigate={navigate} />}
        {/* Dev-only (fixture entry): the REAL recommendations surfaces driven
            by the deterministic fixture fetch (?recs=<scenario>), so the
            M4.2 states are capturable without a backend. */}
        {route.path === 'recommendations' && recsFetch ? (
          <SharedRecommendationsAllPage navigate={navigate} deps={recommendationDeps} />
        ) : route.path === 'recommendations' ? (
          <RecommendationsAllPage navigate={navigate} />
        ) : null}
        {route.path === 'recommendations-states' && recsFetch ? (
          <div className="mx-auto max-w-[1600px] space-y-10 px-5 py-6 md:px-8">
            <RecommendationRow navigate={navigate} deps={recommendationDeps} />
            <SharedRecommendationsAllPage navigate={navigate} deps={recommendationDeps} />
          </div>
        ) : null}
        {!['home', 'library', 'library-category', 'library-states', 'recommendations-states', 'title', 'see-all', 'player', 'recommendations', 'search', 'downloads'].includes(route.path) && (
          <section className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-6 text-center">
            <p className="text-sm text-white/60">This page is not available.</p>
            <h1 className="type-section-title mt-3 text-white">Return to your library</h1>
            <button
              type="button"
              onClick={() => navigate('home')}
              className="mt-7 min-h-12 rounded-lg bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Back to TorWatch
            </button>
          </section>
        )}
      </Suspense>
    </AppShell>
    )}
    </RouterProvider>
    </LibraryContextProvider>
  );
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
          <p className="type-secondary font-medium text-white/60">App view failed</p>
          <h1 className="type-section-title mt-3 text-white">TorWatch couldn’t open this screen</h1>
          <div className="mt-7 grid gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-12 rounded-lg bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Reload app
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('torwatch:open-settings'))}
              className="min-h-12 rounded-lg border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
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

// WF02: Home under a server failure is exactly this block — no explanatory
// paragraphs, no rail repetition. The header, destinations and Settings stay
// reachable (spec C4/C6).
function HomeRecovery({ incompatible, retrying, onRetry, onOpenSettings }: {
  incompatible: boolean;
  retrying: boolean;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <section
      className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-6 text-center"
      aria-live="polite"
    >
      <h1 className="type-section-title text-white">{incompatible ? 'Server needs an update' : 'Server unavailable'}</h1>
      <div className="mt-6 flex w-full max-w-xs flex-col gap-3">
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="min-h-12 rounded-lg bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          {retrying ? 'Checking…' : 'Retry'}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="min-h-12 rounded-lg border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          Go to settings
        </button>
      </div>
    </section>
  );
}

// Configuration read error (spec C1): a recovery state, never first
// installation — this screen never asks the user to set up again and never
// clears the saved address.
function ConfigErrorScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 text-center text-white" role="alert">
      <div className="w-full max-w-md">
        <p className="type-secondary font-medium text-white/60">Storage problem</p>
        <h1 className="type-section-title mt-3">TorWatch couldn’t read its saved settings</h1>
        <div className="mt-7">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-12 rounded-lg bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            Retry
          </button>
        </div>
      </div>
    </main>
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
<p className="mt-1 text-sm text-white/55">2024 - Movie</p>
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
  launch: LaunchComposition;
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
          launch={composed.launch}
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
            <button type="button" onClick={() => window.location.reload()} className="mt-7 min-h-12 rounded-lg bg-white px-6 text-sm text-black">Reload app</button>
          </div>
        </main>,
      );
    }
  });
}

