// Shared playback-session client (feature 002 M1.4.3).
//
// Typed client for contracts/playback-api.md, used by the native mobile
// players (Capacitor iOS/Android) AND available to staging tooling. Invariants
// implemented here:
//   - The client NEVER sends a magnet: sessions are created from a source
//     identifier (40-char hex info hash) + file index + capability profile.
//   - Relative playback/playlist/subtitle URLs are resolved ONLY against the
//     explicitly configured backend origin.
//   - The plan (direct/HLS) is taken from the session response -- never
//     guessed from file extensions.
//   - 404 capability absence (older server), 422 planning failures, 503
//     capacity exhaustion, session expiry and network loss surface as typed,
//     truthful errors.
//   - Terminal events (stopped/ended/error) fire exactly once per controller.

export type PlaybackMode = 'direct' | 'remux' | 'transcode' | 'unsupported';

export type SessionSubtitle = {
  id: string;
  language?: string;
  label?: string;
  default?: boolean;
  forced?: boolean;
  url: string;
  origin: string;
};

export type SessionMediaInfo = {
  container: string;
  durationSec: number;
  width: number;
  height: number;
  video: { codec: string; profile?: string; level?: string; bitDepth?: number };
  audio: { codec: string; channels?: number };
  bitrateBps: number;
  hdr?: string;
  subtitleTracks?: Array<{ index: number; format: string; language?: string; label?: string }>;
  fileIndex: number;
};

export type PlaybackSession = {
  sessionId: string;
  mode: PlaybackMode;
  reasonCode: string;
  message: string;
  playbackUrl: string;
  media?: SessionMediaInfo;
  subtitles: SessionSubtitle[];
  expiresAt: string;
  profile: string;
};

export type CreateSessionInput = {
  cat: string;
  sourceId: string;
  fileIndex?: number;
  profile?: string;
};

// Error kinds are stable consumer-facing values.
export type PlaybackClientErrorKind =
  | 'invalid' // 400 malformed request
  | 'planning' // 422: inspection/malformed source
  | 'capacity' // 503: conversion slot busy
  | 'session-limit' // 503: too many sessions
  | 'unsupported-server' // 404 on session create: older server (capability absent)
  | 'not-found' // 404 on GET/DELETE of a session
  | 'network' // fetch failure / offline
  | 'internal';

/**
 * Resolve a contract-relative URL against the configured backend origin
 * (M1.4 hardening). The preferred input is a CONTRACT-RELATIVE path; an
 * absolute URL is accepted ONLY when its scheme, hostname and EFFECTIVE port
 * are identical to the origin (prevents lookalike/cross-origin substitution).
 * Rejected: protocol-relative URLs, embedded credentials, fragments, and any
 * cross-origin target.
 */
export function resolveAgainstOrigin(path: string, origin: string): string {
  const cleanedOrigin = String(origin || '').replace(/\/+$/, '');
  if (!cleanedOrigin) throw new PlaybackClientError('invalid', 'Connect TorWatch to a server first.');
  const target = String(path ?? '');
  if (target === '') throw new PlaybackClientError('invalid', 'The playback URL is empty.');
  // Protocol-relative URLs are rejected BEFORE the relative-path branch (they
  // start with "/" but are absolute with an attacker-chosen scheme).
  if (target.startsWith('//')) {
    throw new PlaybackClientError('invalid', 'The playback URL is not same-origin.');
  }
  // Contract-relative is the preferred, always-accepted form.
  if (target.startsWith('/')) return cleanedOrigin + target;

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new PlaybackClientError('invalid', 'The playback URL is malformed.');
  }
  // Protocol-relative (//host/...) parses with a scheme-less special case only
  // via the '//...' string check; URL treats it as https with host carried.
  if (target.startsWith('//')) {
    throw new PlaybackClientError('invalid', 'The playback URL is not same-origin.');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new PlaybackClientError('invalid', 'The playback URL is not same-origin.');
  }
  const originURL = new URL(cleanedOrigin);
  if (
    parsed.protocol.replace(':', '') !== originURL.protocol.replace(':', '') ||
    parsed.hostname.toLowerCase() !== originURL.hostname.toLowerCase() ||
    effectivePort(parsed) !== effectivePort(originURL)
  ) {
    throw new PlaybackClientError('invalid', 'The playback URL is not same-origin.');
  }
  return parsed.toString();
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

export class PlaybackClientError extends Error {
  readonly kind: PlaybackClientErrorKind;
  readonly reasonCode?: string;

  constructor(kind: PlaybackClientErrorKind, message: string, reasonCode?: string) {
    super(message);
    this.name = 'PlaybackClientError';
    this.kind = kind;
    this.reasonCode = reasonCode;
  }
}

export type PlaybackClientDeps = {
  /** Resolves the configured backend origin (no trailing slash). */
  getOrigin: () => string;
  fetchImpl?: typeof fetch;
  /** Capability profile advertised by this device. */
  profile?: string;
};

export class PlaybackSessionClient {
  private readonly deps: PlaybackClientDeps;
  private readonly profile: string;

  constructor(deps: PlaybackClientDeps) {
    this.deps = deps;
    this.profile = deps.profile ?? 'ios-avplayer';
  }

  private fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Absolute URL for any relative contract path. */
  resolve(path: string): string {
    const origin = String(this.deps.getOrigin() || '').replace(/\/+$/, '');
    if (!origin) throw new PlaybackClientError('invalid', 'Connect TorWatch to a server first.');
    return resolveAgainstOrigin(path, origin);
  }

  /** Probe /v1/version for the playback capability. */
  async capability(): Promise<'available' | 'absent' | 'unreachable'> {
    let response: Response;
    try {
      response = await this.fetch()(this.resolve('/v1/version'), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return 'unreachable';
    }
    if (!response.ok) return 'unreachable';
    try {
      const payload = (await response.json()) as { capabilities?: string[] };
      return Array.isArray(payload.capabilities) && payload.capabilities.includes('playback.compat.v1')
        ? 'available'
        : 'absent';
    } catch {
      return 'unreachable';
    }
  }

  /** POST /v2/playback/sessions. Rejects with typed PlaybackClientError. */
  async create(input: CreateSessionInput): Promise<PlaybackSession> {
    const sourceId = String(input.sourceId || '').trim();
    if (!/^[0-9a-fA-F]{40}$/.test(sourceId)) {
      // Fail closed BEFORE any network call: a magnet or partial hash must
      // never be sent through the bridge.
      throw new PlaybackClientError('invalid', 'The source identifier must be a 40-character hex info hash.');
    }
    const response = await this.guarded('POST /v2/playback/sessions', async () =>
      this.fetch()(this.resolve('/v2/playback/sessions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          cat: input.cat || 'movie',
          sourceId,
          fileIndex: input.fileIndex ?? 0,
          profile: input.profile ?? this.profile,
        }),
        signal: AbortSignal.timeout(65_000),
      }));
    if (response.status === 201) {
      return (await response.json()) as PlaybackSession;
    }
    throw await this.errorFrom(response, 'POST /v2/playback/sessions');
  }

  /** GET /v2/playback/sessions/{id} (null when unknown/expired). */
  async get(sessionId: string): Promise<PlaybackSession | null> {
    const response = await this.guarded('GET session', async () =>
      this.fetch()(this.resolve(`/v2/playback/sessions/${encodeURIComponent(sessionId)}`), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      }));
    if (response.status === 200) return (await response.json()) as PlaybackSession;
    if (response.status === 404) return null;
    throw await this.errorFrom(response, 'GET session');
  }

  /** DELETE /v2/playback/sessions/{id}. Idempotent. */
  async delete(sessionId: string): Promise<void> {
    try {
      await this.fetch()(this.resolve(`/v2/playback/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Network loss during teardown is non-fatal: the session expires via
      // its TTL. Never surface a dismissal blocker for this.
    }
  }

  /** Raw bounded request against the configured origin (progress/resume). */
  async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch()(this.resolve(path), init);
    } catch {
      throw new PlaybackClientError('network', 'Could not reach the TorWatch server.');
    }
  }

  private async guarded(what: string, run: () => Promise<Response>): Promise<Response> {
    let response: Response;
    try {
      response = await run();
    } catch (error) {
      if (error instanceof PlaybackClientError) throw error;
      throw new PlaybackClientError('network', `Could not reach the TorWatch server (${what}).`);
    }
    return response;
  }

  private async errorFrom(response: Response, what: string): Promise<PlaybackClientError> {
    let code = '';
    let message = '';
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      code = payload?.error?.code ?? '';
      message = payload?.error?.message ?? '';
    } catch {
      // non-JSON body
    }
    if (response.status === 404) {
      if (what.startsWith('POST')) {
        return new PlaybackClientError('unsupported-server', 'This TorWatch server does not provide native playback (update the server).', code);
      }
      return new PlaybackClientError('not-found', 'This playback session is unknown or has expired.', code);
    }
    if (response.status === 422) {
      return new PlaybackClientError('planning', message || 'The selected source could not be prepared for playback.', code || 'planning_failed');
    }
    if (response.status === 503) {
      const kind: PlaybackClientErrorKind = code === 'session_limit_exceeded' ? 'session-limit' : 'capacity';
      return new PlaybackClientError(kind, message || 'The server is busy; try again shortly.', code);
    }
    if (response.status === 400) {
      return new PlaybackClientError('invalid', message || 'The playback request was rejected.', code);
    }
    return new PlaybackClientError('internal', message || 'The playback service failed unexpectedly.', code);
  }
}
