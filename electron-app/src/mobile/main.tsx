// Mobile native shell entry (feature 002 M1.4.2-M1.4.7; repair pass M1.4).
//
// EXACTLY ONE React root for the page lifetime: the shared app renders once;
// the settings surface is an OVERLAY state inside the shell, opened via the
// `torwatch:open-settings` custom event. Settings adds a same-route history
// entry so native swipe-back dismisses the overlay without losing the page.
//
// Composition-owned resources (LibraryStore origin subscription, LibrarySync
// interval, NativePlayer origin subscription) are disposed by the shell's
// cleanup effect.
//
// The backend origin is USER-CONFIGURED at runtime; onboarding reuses the
// shared ConnectionGate. Production playback is the NATIVE Capacitor adapter;
// outside the shell the browser staging player remains the truthful dev path.

import '../globals.css';
import ReactDOM from 'react-dom/client';
import React, { useEffect, useState } from 'react';

// Prevent the browser entry's auto-start BEFORE it is imported: exactly one
// composition root exists per document.
(window as unknown as { __TORWATCH_MOBILE_ENTRY?: boolean }).__TORWATCH_MOBILE_ENTRY = true;

// M1.4.6: route the shared Settings buttons (openSetup affordance) to the
// settings overlay through a custom event. This shim is the ONLY place
// anything touches window.electronAPI in the mobile shell, and it exposes
// nothing else.
(window as unknown as { electronAPI?: { openSetup: () => Promise<{ ok: boolean }> } }).electronAPI = {
  openSetup: async () => {
    window.dispatchEvent(new CustomEvent('torwatch:open-settings'));
    return { ok: true };
  },
};

function MobileShell(props: {
  composed: Awaited<ReturnType<typeof import('../browser/main').composePlatform>>;
  browser: typeof import('../browser/main');
}): React.ReactElement {
  const { composed, browser } = props;
  // M1.4 repair: the settings overlay state machine lives in a deterministic,
  // unit-tested controller bound to the window event target.
  const [overlay] = useState(() => new SettingsOverlayController(window, window.history));
  const [settingsOpen, setSettingsOpen] = useState(() => overlay.isOpen());

  useEffect(() => {
    const detach = overlay.subscribe(setSettingsOpen);
    return () => {
      detach();
      overlay.dispose();
    };
  }, [overlay]);

  // Composition-owned disposal when the shell is ever unmounted.
  useEffect(() => {
    return () => {
      composed.librarySync?.detach();
      composed.libraryController?.dispose();
      const player = composed.platform.player as { dispose?: () => void } | null | undefined;
      player?.dispose?.();
    };
  }, [composed]);

  return (
    <>
      {browser.sharedAppElement(composed)}
      {settingsOpen ? (
        <div role="dialog" aria-modal="true" aria-label="Server settings" className="fixed inset-0 z-[100] overflow-auto bg-[#0a0a0a]">
          <ServerSettings
            connection={composed.platform.connection}
            storage={composed.storage}
            onDone={() => overlay.close()}
          />
        </div>
      ) : null}
    </>
  );
}

// Static import: the settings surface ships in the mobile bundle.
import { ServerSettings } from './ServerSettings';
import { SettingsOverlayController } from './settings-overlay-controller';

function StartupScreen(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 text-center text-white" role="status">
      <div className="max-w-sm">
        <span className="mx-auto block h-2.5 w-2.5 animate-pulse rounded-full bg-white/70" aria-hidden="true" />
        <h1 className="type-section-title mt-5">Starting TorWatch</h1>
        <p className="type-body mt-3 text-white/60">Loading the app and checking your saved server…</p>
      </div>
    </main>
  );
}

function StartupFailure(): React.ReactElement {
  const resetServer = () => {
    try {
      window.localStorage.removeItem('mw_server_origin');
    } finally {
      window.location.reload();
    }
  };
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 text-center text-white" role="alert">
      <div className="w-full max-w-md">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/45">Startup failed</p>
        <h1 className="type-section-title mt-3">TorWatch could not start</h1>
        <p className="type-body mt-3 text-white/70">
          The app could not finish loading. Reload it first, or reset only the saved server address and connect again.
        </p>
        <div className="mt-7 grid gap-3">
          <button type="button" onClick={() => window.location.reload()} className="min-h-12 rounded-full bg-white px-5 py-2.5 text-sm text-black">
            Reload app
          </button>
          <button type="button" onClick={resetServer} className="min-h-12 rounded-full border border-white/20 px-5 py-2.5 text-sm text-white">
            Reset server address
          </button>
        </div>
      </div>
    </main>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('The mobile root element is missing.');
const root = ReactDOM.createRoot(rootElement);
root.render(<StartupScreen />);

async function start(): Promise<void> {
  try {
    const [browser, native] = await Promise.all([
      import('../browser/main'),
      import('../platform/native-player'),
    ]);
    const composed = await browser.composePlatform();
    const nativeActive = native.isNativeCapacitor();
    if (nativeActive) {
      // Production mobile playback: native AVPlayer/Media3 through the shared
      // session client. The browser staging player object is discarded.
      composed.platform.player = new native.NativePlayer();
    }
    root.render(<MobileShell composed={composed} browser={browser} />);
  } catch (error) {
    console.error('[Mobile] Startup failed:', error);
    root.render(<StartupFailure />);
  }
}

void start();
