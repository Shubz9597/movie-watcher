// Platform composition context (M1.2): shared code consumes ports via
// usePlatform(); the runtime choice happens once at each entry's
// composition root. No global fallback exists --- a missing provider is a
// composition error, not a silent Electron assumption.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ConnectionState, Platform } from './contracts.ts'

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
