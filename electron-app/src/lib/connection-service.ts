// Connection service (M1.2): the single runtime owner of the backend origin.
// Electron keeps its existing build-time default; the browser/mobile entries
// inject and switch origins at runtime. A switch bumps a generation counter,
// aborts in-flight tracked backend requests, resets origin-scoped caches and
// notifies subscribers — late responses from an old origin can never update
// the new one's state.
import { resolveBackendOrigin } from '../../backend-origin.mjs';
import { resetVersionCheckCache } from './version-check.ts';

type OriginListener = (origin: string, generation: number) => void;

const DEFAULT_ORIGIN = resolveBackendOrigin({
  BACKEND_URL: (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_TORWATCH_BACKEND_URL,
});

export function normalizeOrigin(value: string): string {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_ORIGIN;
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

let currentOrigin = DEFAULT_ORIGIN;
let generation = 0;
const listeners = new Set<OriginListener>();
const tracked = new Set<AbortController>();

export function getBackendOrigin(): string {
  return currentOrigin;
}

export function backendGeneration(): number {
  return generation;
}

export function subscribeOrigin(listener: OriginListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// setBackendOrigin switches the shared origin. Invalid origins fall back to
// the default instead of pointing requests at a malformed URL.
export function setBackendOrigin(value: string): string {
  const next = normalizeOrigin(value);
  if (next === currentOrigin) return currentOrigin;
  currentOrigin = next;
  generation += 1;
  cancelTrackedRequests();
  resetVersionCheckCache();
  for (const listener of Array.from(listeners)) {
    try {
      listener(currentOrigin, generation);
    } catch (error) {
      console.warn('[Connection] Origin subscriber failed:', error);
    }
  }
  return currentOrigin;
}

// trackAbort registers an in-flight backend request so an origin switch can
// abort it. Returns an unregister function; always call it when done.
export function trackAbort(controller: AbortController): () => void {
  tracked.add(controller);
  return () => tracked.delete(controller);
}

export function cancelTrackedRequests(): void {
  for (const controller of Array.from(tracked)) {
    try {
      controller.abort();
    } catch {
      // abort must never throw into the switch path
    }
  }
  tracked.clear();
}

// staleAfterSwitch throws once a response resolved on a previous generation:
// the caller must discard it instead of applying old-origin state.
export class OriginChangedError extends Error {
  constructor() {
    super('The server origin changed while this request was in flight; its response was discarded.');
    this.name = 'OriginChangedError';
  }
}

export function assertCurrentGeneration(startedGeneration: number): void {
  if (backendGeneration() !== startedGeneration) {
    throw new OriginChangedError();
  }
}
