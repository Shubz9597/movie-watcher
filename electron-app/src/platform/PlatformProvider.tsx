// Platform composition context (M1.2): shared code consumes ports via
// usePlatform(); the runtime choice happens once at each entry's
// composition root. No global fallback exists --- a missing provider is a
// composition error, not a silent Electron assumption.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Platform, ServerCompatibility } from './contracts.ts'

const PlatformContext = createContext<Platform | null>(null);

export function PlatformProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (!platform) {
    throw new Error('No platform was provided at this entry\'s composition root.');
  }
  return platform;
}

// useConnectionStatus subscribes to the connection port and re-checks on
// mount. Checking/ready/unreachable/incompatible states drive the entry's
// gate UI; the catalog journey only starts when ready.
export function useConnectionStatus(): ServerCompatibility {
  const { connection } = usePlatform();
  const [status, setStatus] = useState<ServerCompatibility>(() => ({ status: 'checking', origin: '' }));
  useEffect(() => {
    let active = true;
    const unsubscribe = connection.subscribe((compat) => {
      console.debug('[Platform] connection state (subscribe)', compat.status);
      if (active) setStatus(compat);
    });
    connection.check().then((compat) => {
      console.debug('[Platform] connection state (check)', compat.status);
      if (active) setStatus(compat);
    }).catch((error: unknown) => {
      console.error('[Platform] Connection check failed:', error);
      if (active) {
        setStatus({
          status: 'unreachable',
          origin: '',
          message: 'TorWatch could not check the server. Open Server Settings and verify the address.',
        });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [connection]);
  return status;
}

/**
 * useConnectionGate (M1.4 repair --- flash fix): derives the launch-screen
 * visibility with "already connected" memory.
 *
 *   - The full-screen gate renders ONLY while the FIRST probe for the
 *     current origin is incomplete (first launch / explicit origin change).
 *   - Once a probe returns ready, later re-checks NEVER unmount the app to
 *     the gate: a transient 'checking' is invisible, and an
 *     'unreachable'/'incompatible' surfaces as a reconnecting banner while
 *     the app stays usable (capability-gated surfaces show their own
 *     truthful offline states).
 *   - Changing the server origin resets the memory --- the gate legitimately
 *     shows again.
 */
export function useConnectionGate(): {
  showGate: boolean;
  reconnecting: boolean;
  compat: ServerCompatibility;
} {
  const compat = useConnectionStatus();
  const everReady = useRef(false);
  const connectedOrigin = useRef('');

  if (compat.status === 'ready') {
    everReady.current = true;
    connectedOrigin.current = compat.origin;
  }
  // Origin changes through saveOrigin --- the stored origin differs --- the
  // first-connect phase legitimately restarts.
  if (compat.origin && connectedOrigin.current && compat.origin !== connectedOrigin.current) {
    everReady.current = false;
    connectedOrigin.current = compat.origin;
  }

  const showGate = !everReady.current && compat.status !== 'ready';
  const reconnecting = everReady.current && compat.status !== 'ready';
  return { showGate, reconnecting, compat };
}
