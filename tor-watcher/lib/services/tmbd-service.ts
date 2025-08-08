import "server-only";

const TMDB_BASE = "https://api.themoviedb.org/3";

// === Auth ===
const bearer = process.env.TMDB_ACCESS_TOKEN;
const apiKey = process.env.TMDB_API_KEY;

function authHeaders(): Record<string, string> {
  if (bearer) return { Authorization: `Bearer ${bearer}` };
  if (apiKey) return {};
  throw new Error("TMDB credentials missing. Set TMDB_ACCESS_TOKEN or TMDB_API_KEY in .env.local");
}

function withApiKey(url: string) {
  if (bearer) return url;
  if (!apiKey) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}api_key=${apiKey}`;
}

// === LRU Cache (in-memory) ===
type CacheEntry = {
  value: string;          // JSON string
  expiresAt: number;      // timestamp in ms
};

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private max = 500) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    // mark as recently used
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, val: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.max) {
      // evict least-recently used (first inserted)
      const firstKey = this.map.keys().next().value as K | undefined;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }

  delete(key: K) {
    this.map.delete(key);
  }
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;
const STALE_WINDOW_MS = 5 * 60_000; // 5 minutes for stale-on-error

const cache = new LRU<string, CacheEntry>(CACHE_MAX_ENTRIES);

// De-dupe in-flight identical requests (by cache key)
const inflight = new Map<string, Promise<string>>();

// Build cache key. For TMDB we only cache GET and key by full URL.
function cacheKey(url: string, init?: RequestInit) {
  const method = (init?.method || "GET").toUpperCase();
  return `${method}:${url}`;
}

function isCacheBypassed(init?: RequestInit) {
  if (!init) return false;
  // Next.js RequestInit.cache or custom header can bypass
  if ((init as any).cache === "no-store") return true;
  const headers = new Headers(init.headers || {});
  return headers.get("x-bypass-cache") === "1";
}

function safeJsonParse<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // If TMDB ever returns non-JSON text (rare), throw to bubble up
    throw new Error("Failed to parse JSON from TMDB response");
  }
}

// --- Retry helper ---
function anySignal(a?: AbortSignal, b?: AbortSignal) {
  if (!a) return b;
  if (!b) return a;
  const c = new AbortController();
  const relay = (src: AbortSignal) => () => c.abort(src.reason);
  a.addEventListener("abort", relay(a));
  b.addEventListener("abort", relay(b));
  if (a.aborted) c.abort(a.reason);
  if (b.aborted) c.abort(b.reason);
  return c.signal;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  maxRetries = 3
): Promise<Response> {
  const { timeoutMs = 8000, signal: callerSignal, ...rest } = init;
  let lastErr: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptCtrl = new AbortController();
    const tId = setTimeout(
      () => attemptCtrl.abort(new DOMException("Timeout", "AbortError")),
      timeoutMs
    );
    const signal = anySignal(callerSignal as AbortSignal, attemptCtrl.signal);

    try {
      const res = await fetch(url, {
        ...rest,
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(rest.headers || {}),
        },
      });

      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        // backoff (respect Retry-After)
        const ra = Number(res.headers.get("retry-after")) || 0;
        const backoff = ra ? ra * 1000 : Math.min(1200 * 2 ** attempt, 5000);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, backoff);
          callerSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        continue;
      }

      return res; // OK or 4xx (don’t retry)
    } catch (err: any) {
      lastErr = err;

      // If the caller aborted, DO NOT retry
      if (callerSignal?.aborted) throw err;

      const transient =
        err?.name === "AbortError" ||
        ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(err?.code);
      if (!transient || attempt === maxRetries) break;

      const backoff = Math.min(400 * 2 ** attempt, 3000);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, backoff);
        callerSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    } finally {
      clearTimeout(tId);
    }
  }

  throw new Error(
  `fetch failed: ${lastErr?.code ?? lastErr?.name ?? "Unknown"} ${lastErr?.message ?? ""}`.trim(),
  { cause: lastErr }
);
}

// Main TMDB fetch with LRU cache + retry
export async function tmdb<T = any>(
  path: string,
  init?: RequestInit & {
    next?: { revalidate?: number };
    timeoutMs?: number;
    ttlMs?: number;
    cacheable?: boolean;
    signal?: AbortSignal; // <-- make sure this is here
  }
): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = withApiKey(`${TMDB_BASE}${normalizedPath}`);
  const method = (init?.method || "GET").toUpperCase();
  const cacheable = init?.cacheable ?? (method === "GET");
  const key = `${method}:${url}`;

  // Try fresh cache
  if (cacheable && !isCacheBypassed(init)) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return safeJsonParse<T>(hit.value);
    }
  }

  // De-dupe identical in-flight
  if (cacheable && inflight.has(key)) {
    const text = await inflight.get(key)!;
    return safeJsonParse<T>(text);
  }

  const doFetch = async () => {
    const res = await fetchWithRetry(url, {
      ...init,
      headers: {
        ...authHeaders(),
        ...(init?.headers as Record<string, string> | {}),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Could not read error response");
      console.error("TMDb Error", { status: res.status, url, body: text });
      throw new Error(`TMDb ${res.status} ${res.statusText}: ${text}`);
    }

    const text = await res.text(); // store text to avoid shared object mutation
    if (cacheable && !isCacheBypassed(init)) {
      const ttl = Math.max(1, init?.ttlMs ?? CACHE_TTL_MS);
      cache.set(key, { value: text, expiresAt: Date.now() + ttl });
    }
    return text;
  };

  try {
    if (cacheable) {
      const p = doFetch();
      inflight.set(key, p);
      const text = await p;
      return safeJsonParse<T>(text);
    } else {
      const text = await doFetch();
      return safeJsonParse<T>(text);
    }
  } catch (err) {
    // Serve stale on error if available (within window)
    if (cacheable) {
      const stale = cache.get(key);
      if (stale && Date.now() - stale.expiresAt < STALE_WINDOW_MS) {
        console.warn("Serving stale TMDB cache for:", url);
        return safeJsonParse<T>(stale.value);
      }
    }
    throw err;
  } finally {
    if (cacheable) inflight.delete(key);
  }
}

// Helpers for images (unchanged)
export function posterUrl(path: string | null, size: "w342" | "w500" = "w500") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}
export function backdropUrl(path: string | null, size: "w780" | "w1280" = "w1280") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}