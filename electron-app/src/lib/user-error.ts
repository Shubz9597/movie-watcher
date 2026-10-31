// What a failure means for the viewer, in words they can act on. Raw errors
// ("catalog backend unreachable: TypeError: Load failed", "status 502",
// stack-ish text) never reach the screen; the app's own written messages
// ("Not enough storage for this download.") pass through unchanged.

export const OFFLINE_MESSAGE = 'Can’t reach your server right now. Check your connection and try again.';
const SERVER_TROUBLE = 'Your server had a problem. Try again in a moment.';

// Signs of a technical message rather than one written for the viewer.
const TECHNICAL = /TypeError|SyntaxError|ReferenceError|Unexpected token|JSON|\bfetch\b|NetworkError|Load failed|Failed to fetch|ECONN|ETIMEDOUT|ENOTFOUND|socket|backend|undefined|null|status \d{3}|\(\d{3}\)|HTTP \d{3}|\b[45]\d\d\b|https?:\/\/|[a-z]+_[a-z_]+/i;
const UNREACHABLE = /unreachable|Load failed|Failed to fetch|NetworkError|network connection|Internet connection|offline|ECONN|ENOTFOUND|TimeoutError|operation timed out|signal timed out|AbortError|The operation was aborted/i;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || '';
  if (typeof error === 'string') return error;
  return '';
}

/**
 * The viewer-facing text for a failure. fallback names what failed in the
 * viewer's terms ("Couldn’t load this title.").
 */
export function userMessage(error: unknown, fallback: string): string {
  const raw = messageOf(error).trim();
  const code = (error as { code?: unknown } | null)?.code;
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  if (code === 'backend_unreachable' || code === 'origin_changed'
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
    return OFFLINE_MESSAGE;
  }
  if (!raw) return fallback;
  if (UNREACHABLE.test(raw)) return OFFLINE_MESSAGE;
  if (status >= 500 || /\b5\d\d\b/.test(raw)) return SERVER_TROUBLE;
  if (TECHNICAL.test(raw)) return fallback;
  return raw;
}

/** Whether a failure is the server being out of reach (worth retrying on reconnect). */
export function isUnreachable(error: unknown): boolean {
  return userMessage(error, '') === OFFLINE_MESSAGE;
}
