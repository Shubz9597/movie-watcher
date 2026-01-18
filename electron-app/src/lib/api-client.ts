// API client for Electron app - ensures all API calls use absolute URLs
const API_BASE = 'http://localhost:3000';
const VOD_BASE = 'http://localhost:4001';

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
 * Get VOD (Go backend) base URL
 */
export function getVodBase(): string {
  return VOD_BASE;
}

/**
 * Get API (Next.js) base URL
 */
export function getApiBase(): string {
  return API_BASE;
}



