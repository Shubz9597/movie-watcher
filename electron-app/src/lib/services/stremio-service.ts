// Stremio sync, server /v1/stremio (internal/stremiosync): the current
// profile links its Stremio account, and what it watches in Stremio (a TV,
// another phone) joins its Continue Watching. The password goes to Stremio
// once through the server; only Stremio's session stays on the server.
import { getVodBase } from '../api-client';
import { getDeviceId } from '../device-id';

import type { StremioAccount } from '../stremio-status';

export { STREMIO_SESSION_ENDED, stremioSyncNote, type StremioAccount } from '../stremio-status';
export type StremioStatus = { linked: boolean; account?: StremioAccount };

async function call(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<StremioStatus> {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${getVodBase()}${path}${separator}clientId=${encodeURIComponent(getDeviceId())}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null) as (StremioStatus & { error?: string }) | null;
  if (!response.ok || !body) {
    throw new Error(body?.error || `Stremio sync is unavailable (${response.status}).`);
  }
  return body;
}

/** null when this server has no Stremio sync (older server). */
export async function loadStremioStatus(): Promise<StremioStatus | null> {
  try {
    return await call('/v1/stremio', undefined, 10_000);
  } catch {
    return null;
  }
}

export function linkStremio(email: string, password: string): Promise<StremioStatus> {
  return call('/v1/stremio/link', { method: 'POST', body: JSON.stringify({ email, password }) }, 60_000);
}

export function syncStremio(): Promise<StremioStatus> {
  return call('/v1/stremio/sync', { method: 'POST' }, 60_000);
}

export function unlinkStremio(): Promise<StremioStatus> {
  return call('/v1/stremio/unlink', { method: 'POST' });
}
