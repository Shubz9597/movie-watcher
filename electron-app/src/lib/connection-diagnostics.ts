export class ConnectionTimeoutError extends Error {
  constructor() {
    super('The connection attempt timed out.');
    this.name = 'ConnectionTimeoutError';
  }
}

/** Fetch with a portable timeout; does not depend on AbortSignal.timeout(). */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectionTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Convert opaque WKWebView/browser failures into an actionable message. */
export function connectionFailureMessage(error: unknown, origin: string): string {
  let host = 'the server';
  try {
    host = new URL(origin).host || host;
  } catch {
    // Origin validation owns malformed-address feedback.
  }
  if (error instanceof ConnectionTimeoutError ||
      (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')) {
    return `Connection to ${host} timed out. Confirm staging is running and both computers are on the same network.`;
  }
  return `Could not reach ${host}. Confirm Windows staging is running with LAN mode, both computers are on the same private network, and Windows Firewall allows TCP port 4001.`;
}
