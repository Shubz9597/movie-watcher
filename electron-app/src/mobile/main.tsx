// Mobile native shell entry (feature 002 M1.4.2-M1.4.7; repair pass M1.4).
//
// EXACTLY ONE React root for the page lifetime: the shared app renders once;
// the settings surface is an OVERLAY state inside the shell, opened via the
// `torwatch:open-settings` custom event. Settings never touches the shared
// hash router, so the two never compete, and closing settings does not
// remount or recompose anything.
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
  const [overlay] = useState(() => new SettingsOverlayController(window));
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
        <div className="fixed inset-0 z-[100] overflow-auto bg-[#0a0a0a]">
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

async function start(): Promise<void> {
  const [browser, native] = await Promise.all([
    import('../browser/main'),
    import('../platform/native-player'),
  ]);
  const composed = await browser.composePlatform();
  const nativeActive = native.isNativeCapacitor();
  void nativeActive;
  if (nativeActive) {
    // Production mobile playback: native AVPlayer/Media3 through the shared
    // session client. The browser staging player object is discarded.
    composed.platform.player = new native.NativePlayer();
  }
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  root.render(<MobileShell composed={composed} browser={browser} />);
}

void start();
