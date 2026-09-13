// Source error mapper (M1.4 repair): converts raw backend torrent-search
// errors into human-safe, actionable copy. Backend errors contain Prowlarr
// URLs, indexer IDs, and query strings — none of which belong in the UI.
export type SourceErrorKind =
  | 'timeout'
  | 'auth'
  | 'rate-limit'
  | 'expired'
  | 'empty'
  | 'generic';

const FRIENDLY_MESSAGES: Record<SourceErrorKind, string> = {
  timeout: 'Source search timed out. An indexer may be slow or unavailable. Check Prowlarr on your server, then refresh.',
  'auth': 'Prowlarr rejected the API key. Check the key in your server settings, then refresh.',
  'rate-limit': 'Too many requests to an indexer. Wait a minute, then refresh.',
  'expired': 'This source has expired. Refresh the search to get fresh results.',
  'empty': 'No sources found for this title.',
  'generic': 'The source search failed. Check Prowlarr on your server, then refresh.',
};

/**
 * Map a raw backend error message into human-safe copy. The backend's
 * `searchAll` errors embed Prowlarr URLs, indexer IDs, query strings, and
 * HTTP status codes. This function strips all of that and returns only what
 * the user needs to act.
 */
export function mapSourceError(raw: string): { kind: SourceErrorKind; message: string } {
  const lower = raw.toLowerCase();
  if (lower.includes('timeout') || lower.includes('deadline') || lower.includes('canceled')) {
    return { kind: 'timeout', message: FRIENDLY_MESSAGES.timeout };
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key')) {
    return { kind: 'auth', message: FRIENDLY_MESSAGES.auth };
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return { kind: 'rate-limit', message: FRIENDLY_MESSAGES['rate-limit'] };
  }
  if (lower.includes('expired')) {
    return { kind: 'expired', message: FRIENDLY_MESSAGES.expired };
  }
  if (lower.includes('no enabled torrent indexers')) {
    return { kind: 'empty', message: 'No torrent indexers are enabled in Prowlarr. Enable at least one, then refresh.' };
  }
  return { kind: 'generic', message: FRIENDLY_MESSAGES.generic };
}

/**
 * sourceRequestError: maps an HTTP response status + error body into a
 * human-safe message for the torrent search service (used by
 * torrent-search-service.ts postJSON). The resolve flag adjusts the copy
 * for source-resolution failures.
 */
export function sourceRequestError(status: number, errorMessage: string | undefined, isResolve: boolean): string {
  const lower = (errorMessage || '').toLowerCase();
  const code = lower;

  if (status === 401 || code.includes('unauthorized') || code.includes('api key')) {
    return FRIENDLY_MESSAGES.auth;
  }
  if (status === 429 || code.includes('rate limit')) {
    return FRIENDLY_MESSAGES['rate-limit'];
  }
  if (status === 404) {
    return isResolve
      ? 'This source has expired. Refresh the search to get fresh results.'
      : FRIENDLY_MESSAGES.empty;
  }
  if (code.includes('timeout') || code.includes('deadline')) {
    return FRIENDLY_MESSAGES.timeout;
  }
  if (status === 503 || code.includes('capacity')) {
    return 'The server is busy. Try again shortly.';
  }
  if (errorMessage && !/prowlarr|localhost|127\.0\.0\.1|indexerIds|api\/v1|search prowlarr/i.test(errorMessage)) {
    // Backend already provides a clean message — use it.
    return errorMessage;
  }
  return isResolve
    ? 'The selected source could not be resolved. Refresh the search and try again.'
    : FRIENDLY_MESSAGES.generic;
}
