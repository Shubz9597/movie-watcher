// Connection coordinator (offline-downloads C02): ONE shared config/probe/save
// core used by every entry's connection adapter, replacing the separate
// probe paths. Deterministic, injected fetch, no React/DOM.
//
// Semantics implemented here (spec C1/C3/C4, plan "Connection model"):
//   - Checks are DEDUPLICATED: concurrent check() calls share one in-flight
//     probe instead of stacking one request per status chip/hook.
//   - Every probe carries a generation; a result that arrives after a newer
//     mutation (an origin save, a newer check) is dropped, never committed.
//   - Probes are BOUNDED (default 15s: a fresh Tailscale Serve TLS handshake
//     can stall past 5s) and retried only on explicit request or foreground
//     entry — never in a background retry loop.
//   - Save is probe-first: syntax, reachability AND protocol compatibility are
//     verified before the candidate is persisted or activated. A failed edit
//     preserves the active URL (verified readback; restore on persistence
//     failure).
//   - Protocol compatibility (supportedProtocolRange overlap) is verified
//     separately from optional capabilities: a reachable compatible server
//     missing an optional capability is still saveable; the limitation is
//     reported where the capability is used.
//   - A missing optional capability is NEVER a universal incompatibility.

import type { ConnectionState } from '../platform/contracts.ts';
import { connectionFailureMessage, fetchWithTimeout } from './connection-diagnostics.ts';
import { CLIENT_SUPPORTED_PROTOCOL_RANGE, rangesOverlap } from './version-check.ts';

export const PROBE_TIMEOUT_MS = 15_000;

export type VersionPayload = {
  serverVersion?: string;
  protocolVersion?: number;
  supportedProtocolRange?: number[];
  capabilities?: string[];
};

export type ProbeResult =
  | {
      kind: 'ready';
      origin: string;
      serverVersion?: string;
      supportedProtocolRange?: number[];
      capabilities: string[];
      /** Protocol-range overlap — independent of the capabilities list. */
      protocolCompatible: boolean;
    }
  | { kind: 'unreachable'; origin: string; message: string }
  | { kind: 'incompatible'; origin: string; message: string };

/**
 * probeServer: /readyz then /v1/version, bounded. Deterministic; injected
 * fetch in tests. /readyz first so "the server answered but is not ready
 * (database down)" surfaces as unreachable rather than as a protocol
 * problem; the version endpoint then provides the protocol range and the
 * capability list.
 */
export async function probeServer(
  fetchImpl: typeof fetch,
  origin: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  try {
    const ready = await fetchWithTimeout(fetchImpl, `${origin}/readyz`, {}, timeoutMs);
    if (!ready.ok) {
      return { kind: 'unreachable', origin, message: `The server answered /readyz with HTTP ${ready.status}.` };
    }
  } catch (error) {
    return { kind: 'unreachable', origin, message: connectionFailureMessage(error, origin) };
  }
  try {
    const response = await fetchWithTimeout(fetchImpl, `${origin}/v1/version`, { headers: { Accept: 'application/json' } }, timeoutMs);
    if (!response.ok) {
      return { kind: 'incompatible', origin, message: 'This server does not expose a compatible version endpoint.' };
    }
    const version = (await response.json()) as VersionPayload;
    return {
      kind: 'ready',
      origin,
      serverVersion: version.serverVersion,
      supportedProtocolRange: version.supportedProtocolRange,
      capabilities: Array.isArray(version.capabilities) ? version.capabilities : [],
      // Missing range fails open (pre-P1 servers keep connecting), matching
      // version-check.ts negotiation.
      protocolCompatible:
        !version.supportedProtocolRange ||
        rangesOverlap(version.supportedProtocolRange, CLIENT_SUPPORTED_PROTOCOL_RANGE),
    };
  } catch (error) {
    return { kind: 'incompatible', origin, message: connectionFailureMessage(error, origin) };
  }
}

/** Coordinator state: ServerCompatibility plus the C1/C2 distinctions. */
export type { ConnectionState };

export type SaveDeps = {
  /** Persist the validated origin durably. Must throw on failure. */
  persist: (origin: string) => void;
  /** Read back the persisted origin to VERIFY durability (never assumed). */
  readPersisted: () => string | null;
  /** The currently active runtime origin (unchanged on any failure). */
  activeOrigin: string;
};

export type SaveOutcome =
  | { result: 'saved'; origin: string; protocolCompatible: boolean; capabilities: string[] }
  | { result: 'invalid' }
  | { result: 'blocked-unreachable'; message: string }
  | { result: 'blocked-incompatible'; message: string }
  | { result: 'blocked-persist-failed'; message: string }
  | { result: 'error'; message: string };

/** Restore point used when a save's persistence verification fails. */
export type RestoreOrigin = (origin: string) => Promise<void>;

export class ConnectionCoordinator {
  private state: ConnectionState;
  private listeners = new Set<(state: ConnectionState) => void>();
  private inFlight: { origin: string; promise: Promise<ProbeResult> } | null = null;
  private generation = 0;

  constructor(initial?: Partial<ConnectionState>) {
    this.state = {
      status: 'checking',
      origin: '',
      configured: false,
      capabilities: [],
      protocolCompatible: true,
      ...initial,
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(state: ConnectionState): void {
    this.state = state;
    for (const listener of Array.from(this.listeners)) listener(state);
  }

  /**
   * check(): deduplicated + generation-guarded. Concurrent calls for the same
   * origin share one probe; a probe superseded by a newer mutation commits
   * nothing. Emits 'checking' immediately unless an identical ready state is
   * already current for that origin (a redundant re-check stays quiet).
   */
  async check(origin: string, configured: boolean, fetchImpl: typeof fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<ConnectionState> {
    if (this.inFlight && this.inFlight.origin === origin) {
      await this.inFlight.promise.catch(() => undefined);
      return this.state;
    }
    if (origin && this.state.status === 'ready' && this.state.origin === origin && this.state.configured === configured) {
      // Already a fresh, verified result for exactly this configuration —
      // do not emit a checking cycle for a redundant re-check.
      return this.state;
    }
    this.generation += 1;
    const generation = this.generation;
    this.publish({ status: 'checking', origin, configured, capabilities: this.state.capabilities, protocolCompatible: this.state.protocolCompatible });
    const promise = probeServer(fetchImpl, origin, timeoutMs);
    this.inFlight = { origin, promise };
    try {
      const result = await promise;
      if (generation === this.generation) {
        this.commit(result, configured);
      }
      return this.state;
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    }
  }

  /** Commit a probe result unless a newer generation superseded it. */
  commit(result: ProbeResult, configured: boolean): void {
    if (result.kind === 'ready') {
      this.publish({
        status: result.protocolCompatible ? 'ready' : 'incompatible',
        origin: result.origin,
        configured,
        serverVersion: result.serverVersion,
        supportedProtocolRange: result.supportedProtocolRange,
        capabilities: result.capabilities,
        protocolCompatible: result.protocolCompatible,
        message: result.protocolCompatible
          ? undefined
          : 'This server is not compatible. Update the TorWatch server.',
      });
      return;
    }
    this.publish({
      status: result.kind === 'unreachable' ? 'unreachable' : 'incompatible',
      origin: result.origin,
      configured,
      capabilities: [],
      protocolCompatible: false,
      message: result.message,
    });
  }

  /**
   * save(): the shared probe-first save flow. The candidate is validated
   * (syntax → reachability → protocol) BEFORE persist or activation; the
   * active origin is preserved on every failure path, including a failed
   * durability readback (which restores the previous origin through
   * `restore`).
   */
  async save(
    candidateRaw: string,
    deps: SaveDeps,
    io: { fetchImpl: typeof fetch; normalize(raw: string): string | null; apply: RestoreOrigin; timeoutMs?: number },
  ): Promise<SaveOutcome> {
    const origin = io.normalize(candidateRaw);
    if (!origin) return { result: 'invalid' };
    if (origin === deps.activeOrigin && deps.readPersisted() === origin) {
      // Re-saving the active, persisted origin is a no-op success (deduped).
      const probed = await probeServer(io.fetchImpl, origin, io.timeoutMs);
      if (probed.kind === 'ready') {
        this.commit(probed, true);
        return { result: 'saved', origin, protocolCompatible: probed.protocolCompatible, capabilities: probed.capabilities };
      }
      return this.blockedOutcome(probed);
    }
    const probed = await probeServer(io.fetchImpl, origin, io.timeoutMs);
    if (probed.kind === 'unreachable' || probed.kind === 'incompatible') {
      return this.blockedOutcome(probed);
    }
    if (!probed.protocolCompatible) {
      return { result: 'blocked-incompatible', message: 'This server is not compatible. Update the TorWatch server.' };
    }
    try {
      deps.persist(origin);
    } catch (error) {
      return { result: 'blocked-persist-failed', message: persistenceMessage(error) };
    }
    if (deps.readPersisted() !== origin) {
      // saveOrigin applies both persisted and runtime state. If persistence
      // did not stick, restore the previous runtime origin so the settings
      // screen cannot report failure while the app silently changed.
      try {
        await io.apply(deps.activeOrigin);
      } catch {
        return { result: 'error', message: 'The previous server address could not be restored.' };
      }
      return { result: 'blocked-persist-failed', message: 'The server address could not be saved. Try again.' };
    }
    this.commit(probed, true);
    return { result: 'saved', origin, protocolCompatible: probed.protocolCompatible, capabilities: probed.capabilities };
  }

  private blockedOutcome(probed: ProbeResult): SaveOutcome {
    if (probed.kind === 'unreachable') {
      return { result: 'blocked-unreachable', message: probed.message };
    }
    if (probed.kind === 'incompatible') {
      return { result: 'blocked-incompatible', message: probed.message };
    }
    return { result: 'blocked-incompatible', message: 'This server is not compatible. Update the TorWatch server.' };
  }
}

function persistenceMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? `The server address could not be saved: ${error.message}`
    : 'The server address could not be saved. Try again.';
}
