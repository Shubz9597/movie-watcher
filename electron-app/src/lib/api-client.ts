// API client for Electron app - ensures all API calls use absolute URLs
import { getBackendOrigin } from './connection-service.ts';

const API_BASE = 'http://localhost:3000';

// Backend origin: build-time default (http://localhost:4001) with an optional
// VITE_TORWATCH_BACKEND_URL override. Single source: backend-origin.mjs.
// Runtime switching lives in connection-service.ts (M1.2): the Electron entry
// never calls setBackendOrigin, so its origin stays byte-identical to V1;
// browser/mobile entries inject and switch it.

/**
 * Wrapper for fetch that automatically prepends API_BASE to relative URLs
 */
export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  // If URL is already absolute, use it as-is
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return fetch(url, options);
  }

  // Otherwise, prepend API_BASE
  const fullUrl = url.startsWith('/') ? `${API_BASE}${url}` : `${API_BASE}/${url}`;
  return fetch(fullUrl, options);
}

/**
 * Get the TorWatch backend (Go VOD service) origin. Reads the live origin
 * from the connection service so runtime switches take effect immediately;
 * the initial value is the same build-time default as V1.
 */
export function getVodBase(): string {
  return getBackendOrigin();
}

/**
 * Join the backend origin with a request path that starts with "/".
 */
export function buildBackendUrl(path: string): string {
  const base = getBackendOrigin();
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Get API (Next.js) base URL
 */
export function getApiBase(): string {
  return API_BASE;
}
