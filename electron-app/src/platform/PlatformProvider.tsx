// Platform composition context (M1.2): shared code consumes ports via
// usePlatform(); the runtime choice happens once at each entry's
// composition root. No global fallback exists --- a missing provider is a
// composition error, not a silent Electron assumption.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ConnectionState, Platform } from './contracts.ts'

const PlatformContext = createContext<Platform | null>(null);

export function PlatformProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  useAutoReconnect(platform);
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

// Reconnect on its own: while the server is unreachable (a power cut, the
// server restarting) it is asked again every few seconds, sooner when the
// app returns to the foreground or the network comes back. Before this a
// screen checked only when it opened, so "Reconnecting…" stayed until the
// viewer changed pages. One loop for the whole app; the coordinator shares
// concurrent probes.
const RECONNECT_DELAYS_MS = [3000, 5000, 10000, 15000];
const INCOMPATIBLE_RECHECK_MS = 60000;

function useAutoReconnect(platform: Platform) {
  useEffect(() => {
    const { connection } = platform;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let down = false;
    let disposed = false;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const check = () => {
      clear();
      if (!disposed) void connection.check().catch(() => schedule('unreachable'));
    };
    const schedule = (status: string) => {
      clear();
      down = status === 'unreachable' || status === 'incompatible';
      if (!down) {
        attempt = 0;
        return;
      }
      const delay = status === 'incompatible'
        ? INCOMPATIBLE_RECHECK_MS
        : RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt++;
      timer = setTimeout(check, delay);
    };
    const unsubscribe = connection.subscribe((compat) => schedule(compat.status));
    const onWake = () => {
      if (down && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        attempt = 0;
        check();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onWake);
      document.addEventListener('visibilitychange', onWake);
    }
    return () => {
      disposed = true;
      clear();
      unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onWake);
        document.removeEventListener('visibilitychange', onWake);
      }
    };
  }, [platform]);
}

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (!platform) {
    throw new Error('No platform was provided at this entry\'s composition root.');
  }
  return platform;
}

// useConnectionStatus subscribes to the connection port and re-checks on
// mount. The returned ConnectionState carries the C1/C2 distinctions
// (configured, capabilities, protocolCompatible) for contextual availability.
// It NEVER gates the shell: the launch policy (src/lib/launch-policy.ts)
// decides the initial surface from configuration/inventory/deep-link intent,
// and reachability only drives per-surface recovery UI (WF02 on Home, the
// slim banner elsewhere, per-item states on Downloads).
export function useConnectionStatus(): ConnectionState {
  const { connection } = usePlatform();
  const [status, setStatus] = useState<ConnectionState>(() => ({ status: 'checking', origin: '' }));
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
