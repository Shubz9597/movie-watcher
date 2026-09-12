// Pure server-origin configuration logic (feature 002 M1.4.6; repair pass).
// Kept free of JSX/React so deterministic node tests can import it directly
// (node --test strip-types cannot load .tsx modules).

import type { ConnectionConfig } from '../platform/contracts.ts';
export type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'incompatible'; message: string }
  | { kind: 'reachable'; nativePlayback: boolean; capabilities: string[] };

export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname) return null;
  if (parsed.pathname && parsed.pathname !== '/') return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.username || parsed.password) return null;
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;
}

/** Probe /readyz then /v1/version. Deterministic; injected fetch in tests. */
export async function probeOrigin(fetchImpl: typeof fetch, origin: string): Promise<ProbeState> {
  try {
    const ready = await fetchImpl(`${origin}/readyz`, { signal: AbortSignal.timeout(5000) });
    if (!ready.ok) {
      return { kind: 'unreachable', message: `The server answered /readyz with HTTP ${ready.status}.` };
    }
  } catch {
    return { kind: 'unreachable', message: 'The server could not be reached. Check the address and your network.' };
  }
  try {
    const versionResponse = await fetchImpl(`${origin}/v1/version`, { signal: AbortSignal.timeout(5000) });
    if (!versionResponse.ok) {
      return { kind: 'incompatible', message: 'This server does not expose a compatible version endpoint.' };
    }
    const version = (await versionResponse.json()) as { capabilities?: string[] };
    const capabilities = Array.isArray(version.capabilities) ? version.capabilities : [];
    return {
      kind: 'reachable',
      nativePlayback: capabilities.includes('playback.compat.v1'),
      capabilities,
    };
  } catch {
    return { kind: 'incompatible', message: 'This server did not return a readable version payload.' };
  }
}

/** The origin-change outcome of the save flow (deterministic, unit-tested). */
export type ApplyOriginOutcome =
  | { result: 'saved'; nativePlayback: boolean }
  | { result: 'saved-without-playback' }
  | { result: 'blocked-unreachable' }
  | { result: 'blocked-incompatible' }
  | { result: 'blocked-persist-failed' }
  | { result: 'error'; message: string };

/**
 * applyServerOrigin (M1.4 repair): the deterministic save flow.
 *   probe FIRST; unreachable/incompatible never persists and never closes.
 *   A successful change applies through the CANONICAL connection adapter
 *   (saveOrigin: stops native playback + deletes the session, cancels
 *   in-flight requests, clears origin-scoped stores, reprobes capabilities).
 *   localStorage durability is verified, never silently assumed.
 */
export async function applyServerOrigin(deps: {
  connection: Pick<ConnectionConfig, 'loadOrigin' | 'saveOrigin'>;
  storage: { getPreference(key: string): string | null };
  fetchImpl: typeof fetch;
  origin: string;
  onOriginApplied?: () => void;
}): Promise<ApplyOriginOutcome> {
  const probed = await probeOrigin(deps.fetchImpl, deps.origin);
  if (probed.kind === 'unreachable') return { result: 'blocked-unreachable' };
  if (probed.kind === 'incompatible') return { result: 'blocked-incompatible' };
  if (probed.kind !== 'reachable') {
    return { result: 'error', message: 'The probe did not complete.' };
  }
  let previousOrigin: string;
  try {
    previousOrigin = await deps.connection.loadOrigin();
    await deps.connection.saveOrigin(deps.origin);
  } catch {
    return { result: 'error', message: 'The server address could not be applied.' };
  }
  const persisted = deps.storage.getPreference('mw_server_origin');
  if (persisted !== deps.origin) {
    // saveOrigin applies both persisted and runtime state. If persistence did
    // not stick, restore the previous runtime origin so the settings screen
    // cannot report failure while the rest of the app silently changed.
    try {
      await deps.connection.saveOrigin(previousOrigin);
    } catch {
      return { result: 'error', message: 'The previous server address could not be restored.' };
    }
    return { result: 'blocked-persist-failed' };
  }
  deps.onOriginApplied?.();
  if (!probed.nativePlayback) {
    return { result: 'saved-without-playback' };
  }
  return { result: 'saved', nativePlayback: true };
}
