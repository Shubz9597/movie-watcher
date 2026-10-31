// Profiles ("Who's watching?"), server /v1/profiles (internal/profiles):
// each profile has its own progress, Continue Watching, watched marks,
// library and recommendations. This device's choice is kept on the server
// (by device id), so the native player and downloader follow it too.
import { getVodBase } from '../api-client';
import { getDeviceId } from '../device-id';

export type Profile = { id: string; name: string; color: string; canManage: boolean };
export type ProfilesState = {
  profiles: Profile[];
  /** The profile this device picked, or null (never picked). */
  current: string | null;
  me: { login: string; name: string; owner: boolean };
  max: number;
};

export const PROFILE_COLORS = ['#e50914', '#f5a623', '#2ecc71', '#3498db', '#9b59b6', '#e84393', '#1abc9c', '#95a5a6'];

/** Opens the "Who's watching?" screen from anywhere (a header button). */
export const OPEN_PROFILES_EVENT = 'torwatch:open-profiles';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getVodBase()}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error === 'forbidden'
      ? 'Only the server’s owner or this profile’s creator can change it.'
      : body?.error === 'last_profile' ? 'The first profile stays.'
        : body?.error === 'too_many' ? 'This server has the most profiles it allows.'
          : `Profiles are unavailable (${response.status}).`);
  }
  return response.status === 204 ? (undefined as T) : await response.json() as T;
}

/** null when the server has no profiles (older server). */
export async function loadProfiles(): Promise<ProfilesState | null> {
  try {
    return await call<ProfilesState>(`/v1/profiles?clientId=${encodeURIComponent(getDeviceId())}`);
  } catch {
    return null;
  }
}

export function createProfile(name: string, color: string): Promise<Profile> {
  return call<Profile>('/v1/profiles', { method: 'POST', body: JSON.stringify({ name, color }) });
}

export function updateProfile(id: string, changes: { name?: string; color?: string }): Promise<Profile> {
  return call<Profile>('/v1/profiles/update', { method: 'POST', body: JSON.stringify({ id, ...changes }) });
}

export function deleteProfile(id: string): Promise<void> {
  return call<void>('/v1/profiles/delete', { method: 'POST', body: JSON.stringify({ id }) });
}

export function selectProfile(id: string): Promise<void> {
  return call<void>('/v1/profiles/select', { method: 'POST', body: JSON.stringify({ clientId: getDeviceId(), profileId: id }) });
}
