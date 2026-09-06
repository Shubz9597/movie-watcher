// Electron adapter (M1.2): the ONLY module that reaches for
// window.electronAPI in the shared slice. Access is call-time and guarded —
// nothing here fabricates a global; missing bridges surface honest errors.
// Electron behavior is unchanged: this adapter wraps exactly the calls the
// pages already made (getCatalogState gating stays in App.tsx for now).
import type {
  ConnectionConfig,
  DesktopChrome,
  DeviceStorage,
  PlayerPort,
  PlayerRequest,
  Platform,
  ServerCompatibility,
} from './contracts.ts'
import { fetchServerVersion, rangesOverlap, CLIENT_SUPPORTED_PROTOCOL_RANGE } from '../lib/version-check.ts'
import { getDeviceId } from '../lib/device-id.ts'
import { getVodBase } from '../lib/api-client.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function electronAPI(): any {
  return typeof window === 'undefined' ? null : (window as unknown as Record<string, any>);
}

class ElectronStorage implements DeviceStorage {
  lastError: string | null = null;
  getClientId(): string {
    return getDeviceId();
  }
  getPreference(key: string): string | null {
    this.lastError = null;
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      this.lastError = String(error);
      return null;
    }
  }
  setPreference(key: string, value: string): void {
    this.lastError = null;
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      this.lastError = String(error);
      console.warn('[Platform/Electron] Preference persistence failed:', error);
    }
  }
}

export function createElectronConnection(): ConnectionConfig {
  const listeners = new Set<(compat: ServerCompatibility) => void>();
  let current: ServerCompatibility = { status: 'checking', origin: getVodBase() };
  const emit = () => {
    for (const listener of Array.from(listeners)) listener(current);
  };
  return {
    async loadOrigin() {
      return getVodBase();
    },
    // Electron's origin is fixed by the build/config bridge (rollback story:
    // flip the catalogSource flag, not the origin). Save reports the
    // unchanged origin so callers get honest state.
    async saveOrigin(origin: string) {
      return normalizeToCurrent(origin);
    },
    async check(): Promise<ServerCompatibility> {
      const origin = getVodBase();
      const version = await fetchServerVersion();
      current = compatibilityFromVersion(origin, version);
      emit();
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function normalizeToCurrent(origin: string): string {
  // Only a same-origin value is accepted; anything else reports the live
  // origin so callers can reconcile instead of assuming success.
  void origin;
  return getVodBase();
}

export function compatibilityFromVersion(
  origin: string,
  version: { serverVersion?: string; supportedProtocolRange?: number[] } | null,
): ServerCompatibility {
  if (!version) {
    return { status: 'unreachable', origin, message: 'The TorWatch server could not be reached. Check your connection and the server address.' };
  }
  if (version.supportedProtocolRange && !rangesOverlap(version.supportedProtocolRange, CLIENT_SUPPORTED_PROTOCOL_RANGE)) {
    return {
      status: 'incompatible',
      origin,
      message: `The server protocol range [${version.supportedProtocolRange[0]},${version.supportedProtocolRange[1]}] does not overlap this client's [${CLIENT_SUPPORTED_PROTOCOL_RANGE[0]},${CLIENT_SUPPORTED_PROTOCOL_RANGE[1]}]. Upgrade TorWatch (client or server).`,
      serverVersion: version.serverVersion,
      supportedProtocolRange: version.supportedProtocolRange,
    };
  }
  return {
    status: 'ready',
    origin,
    serverVersion: version.serverVersion,
    supportedProtocolRange: version.supportedProtocolRange,
  };
}

export function createElectronPlatform(): Platform {
  const api = electronAPI();
  const desktop: DesktopChrome | undefined = api
    ? {
        openSetup: () => api.openSetup?.(),
        openTmdbGuide: () => api.openTmdbGuide?.(),
        repairTmdb: (credential: unknown) => api.repairTmdb?.(credential),
        requestTmdb: <T,>(params: { path: string; params?: Record<string, string | number> }) => api.requestTmdb?.(params) as Promise<T>,
        debugLog: (message: string, meta?: Record<string, unknown>) => api.debugLog?.(message, meta),
      }
    : undefined;

  // Player port (M2.3): wraps the exact MPV bridge calls the pages made
  // directly, so desktop playback behavior is preserved byte-for-byte.
  const player: PlayerPort | undefined = api
    ? {
        async start(request: PlayerRequest): Promise<void> {
          if (!api) throw new Error('The Electron playback bridge is unavailable. Restart TorWatch and try again.');
          const result = await api.playInMpv(request);
          if (!result?.ok) {
            throw new Error(result?.error || 'The selected source could not be played.');
          }
        },
        async stop(): Promise<void> {
          if (!api?.stopMpv) return;
          return api.stopMpv();
        },
        onStopped(callback: (event: { reason?: 'stopped' | 'ended' }) => void): () => void {
          return api.onMpvStopped?.(callback) ?? (() => undefined);
        },
      }
    : undefined;

  return {
    kind: 'electron',
    connection: createElectronConnection(),
    storage: new ElectronStorage(),
    desktop,
    player,
  };
}

// Health/version discovery helper shared by entries: a bare HEAD-class check
// against the backend without gating (FR-011).
export async function probeBackendOrigin(origin: string): Promise<ServerCompatibility> {
  const doFetch = fetch.bind(globalThis);
  try {
    const response = await doFetch(`${origin.replace(/\/+$/, '')}/v1/version`, { headers: { Accept: 'application/json' } });
    console.debug('[Platform] version probe', origin, response.status);
    if (response.ok) {
      return compatibilityFromVersion(origin, await response.json());
    }
    return { status: 'unreachable', origin, message: `The server responded with status ${response.status}.` };
  } catch (error) {
    console.warn('[Platform] version probe failed', origin, error);
    return { status: 'unreachable', origin, message: `The server could not be reached: ${String(error)}` };
  }
}
