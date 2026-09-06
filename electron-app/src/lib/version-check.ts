// Electron protocol negotiation (plan P6, FR-011): the client decides from
// the server's advertised supportedProtocolRange before starting V2 catalog
// workflows — never from application version numbers. Health, readiness, and
// version discovery are never gated. A missing/unreachable version endpoint
// (pre-P1 backend) fails open so existing behavior is preserved.
import { buildBackendUrl } from './api-client.ts';

export const CLIENT_SUPPORTED_PROTOCOL_RANGE: [number, number] = [1, 1];

export class ProtocolMismatchError extends Error {
  serverRange: number[] | null;
  clientRange: [number, number];

  constructor(message: string, serverRange: number[] | null, clientRange: [number, number]) {
    super(message);
    this.name = 'ProtocolMismatchError';
    this.serverRange = serverRange;
    this.clientRange = clientRange;
  }
}

export function rangesOverlap(serverRange: number[] | null | undefined, clientRange: [number, number]): boolean {
  if (!serverRange || serverRange.length !== 2) return false;
  const low = Math.max(serverRange[0], clientRange[0]);
  const high = Math.min(serverRange[1], clientRange[1]);
  return low <= high;
}

export function highestMutualProtocol(serverRange: number[] | null | undefined, clientRange: [number, number]): number | null {
  if (!rangesOverlap(serverRange, clientRange)) return null;
  return Math.min(serverRange![1], clientRange[1]);
}

type ServerVersion = {
  serverVersion?: string;
  protocolVersion?: number;
  supportedProtocolRange?: number[];
  capabilities?: string[];
};

let cache: { version: ServerVersion | null; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function resetVersionCheckCache(): void {
  cache = null;
}

export async function fetchServerVersion(deps?: { fetchImpl?: typeof fetch }): Promise<ServerVersion | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.version;
  }
  const doFetch = deps?.fetchImpl ?? fetch.bind(globalThis);
  let payload: ServerVersion | null = null;
  try {
    const response = await doFetch(buildBackendUrl('/v1/version'), { headers: { Accept: 'application/json' } });
    if (response.ok) {
      payload = (await response.json()) as ServerVersion;
    }
  } catch {
    payload = null;
  }
  cache = { version: payload, fetchedAt: Date.now() };
  return payload;
}

// ensureServerCompatible gates only incompatible V2 workflows. Application
// versions are never compared (FR-011 rule 5).
export async function ensureServerCompatible(deps?: { fetchImpl?: typeof fetch }): Promise<void> {
  const version = await fetchServerVersion(deps);
  if (!version || !version.supportedProtocolRange) {
    return;
  }
  if (!rangesOverlap(version.supportedProtocolRange, CLIENT_SUPPORTED_PROTOCOL_RANGE)) {
    throw new ProtocolMismatchError(
      `This TorWatch workflow is not compatible with the backend: server protocol range ` +
        `[${version.supportedProtocolRange[0]},${version.supportedProtocolRange[1]}] does not overlap the client range ` +
        `[${CLIENT_SUPPORTED_PROTOCOL_RANGE[0]},${CLIENT_SUPPORTED_PROTOCOL_RANGE[1]}]. Upgrade TorWatch (client or server).`,
      version.supportedProtocolRange,
      CLIENT_SUPPORTED_PROTOCOL_RANGE,
    );
  }
}
