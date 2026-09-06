// Browser adapter (M1.2): the browser development/preview entry's platform.
// Origin comes from the `?server=` URL parameter, persisted localStorage
// preference (`mw_server_origin`), or the build-time default — in that
// order. Switching origins re-checks compatibility and emits subscribers.
// No window.electronAPI is touched anywhere in this adapter.
import type { ConnectionConfig, DeviceStorage, PlayerPort, ServerCompatibility } from './contracts.ts'
import { probeBackendOrigin } from './electron.ts'
import { setBackendOrigin } from '../lib/connection-service.ts'
import { getDeviceId } from '../lib/device-id.ts'

const SERVER_ORIGIN_KEY = 'mw_server_origin';

// BrowserPlayer is the truthful no-playback port for the browser preview:
// it never fakes a stream and never launches anything. Real mobile playback
// arrives with the M1.3 wrapper decision and its own adapter.
export class BrowserPlayer implements PlayerPort {
  async start(): Promise<void> {
    throw new Error('Playback arrives with the mobile player milestone (M1.3). This browser preview did not start or save anything.');
  }
  async stop(): Promise<void> {
    // Nothing is playing in the browser preview.
  }
  onStopped(): () => void {
    return () => undefined;
  }
}

export class BrowserStorage implements DeviceStorage {
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
      console.warn('[Platform/Browser] Preference persistence failed:', error);
    }
  }
}

export class BrowserConnection implements ConnectionConfig {
  private listeners = new Set<(compat: ServerCompatibility) => void>();
  private current: ServerCompatibility;

  constructor(private readonly storage: DeviceStorage, initialOrigin: string) {
    this.current = { status: 'checking', origin: initialOrigin };
  }

  async loadOrigin(): Promise<string> {
    return this.current.origin;
  }

  async saveOrigin(origin: string): Promise<string> {
    this.storage.setPreference(SERVER_ORIGIN_KEY, origin);
    return this.applyOrigin(origin);
  }

  private async applyOrigin(origin: string): Promise<string> {
    // Drive the shared origin service first: buildBackendUrl, request
    // cancellation and origin-scoped caches follow the switch immediately.
    const normalized = setBackendOrigin(origin);
    console.debug('[Platform/Browser] applying origin', normalized);
    this.current = { status: 'checking', origin: normalized };
    this.emit();
    this.current = await probeBackendOrigin(normalized);
    console.debug('[Platform/Browser] probe result', this.current.status);
    this.emit();
    return this.current.origin;
  }

  async check(): Promise<ServerCompatibility> {
    await this.applyOrigin(this.current.origin);
    return this.current;
  }

  subscribe(listener: (compat: ServerCompatibility) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener(this.current);
  }
}

// resolveBrowserOrigin: URL parameter wins (explicit, shareable), then the
// persisted preference, then the build-time default.
export function resolveBrowserOrigin(search: string): string {
  const params = new URLSearchParams(search);
  const fromUrl = params.get('server');
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  try {
    const stored = window.localStorage.getItem(SERVER_ORIGIN_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // storage unavailable — fall through to the default
  }
  return '';
}
