const ANISKIP_BASE_URL = "https://api.aniskip.com/v2/skip-times";
const THEINTRODB_BASE_URL = "https://api.theintrodb.org/v3/media";
const DEFAULT_TIMEOUT_MS = 3500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const responseCache = new Map();

const TYPE_PRIORITY = {
  recap: 0,
  intro: 1,
  credits: 2,
};

const PLAYBACK_SKIP_SEGMENTS = [
  ["recap", "recap"],
  ["intro", "intro"],
  ["credits", "credits"],
];

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSegment(type, startValue, endValue, durationSeconds, provider) {
  const duration = finiteNumber(durationSeconds);
  const start = finiteNumber(startValue);
  const rawEnd = endValue === null || endValue === undefined ? duration : finiteNumber(endValue);
  if (start === null || rawEnd === null || rawEnd <= start) return null;

  const clampedStart = Math.max(0, start);
  const clampedEnd = duration && duration > 0
    ? Math.min(duration, rawEnd)
    : rawEnd;
  if (clampedEnd - clampedStart < 3) return null;

  return {
    type,
    start: clampedStart,
    end: clampedEnd,
    provider,
  };
}

function dedupeAndSort(segments) {
  const unique = new Map();
  for (const segment of segments.filter(Boolean)) {
    const key = `${segment.type}:${Math.round(segment.start * 4)}:${Math.round(segment.end * 4)}`;
    if (!unique.has(key)) unique.set(key, segment);
  }
  return [...unique.values()].sort((left, right) => (
    left.start - right.start
    || TYPE_PRIORITY[left.type] - TYPE_PRIORITY[right.type]
    || left.end - right.end
  ));
}

export function normalizeAniSkipResponse(payload, durationSeconds) {
  if (!payload?.found || !Array.isArray(payload.results)) return [];

  const typeMap = {
    op: "intro",
    "mixed-op": "intro",
    recap: "recap",
    ed: "credits",
    "mixed-ed": "credits",
  };

  return dedupeAndSort(payload.results.map((result) => {
    const type = typeMap[String(result?.skipType || "").toLowerCase()];
    if (!type) return null;

    const sourceDuration = finiteNumber(result?.episodeLength);
    const actualDuration = finiteNumber(durationSeconds);
    const durationDifference = sourceDuration && actualDuration
      ? actualDuration - sourceDuration
      : 0;
    // AniSkip timestamps are relative to the episode duration used when the
    // segment was submitted. Small runtime differences usually come from
    // alternate releases with a longer/shorter pre-roll; large differences
    // indicate a mismatched file and should not shift the segment wholesale.
    const offset = Math.abs(durationDifference) <= 120 ? durationDifference : 0;
    const intervalStart = finiteNumber(result?.interval?.startTime);
    const intervalEnd = finiteNumber(result?.interval?.endTime);
    if (intervalStart === null || intervalEnd === null) return null;
    return normalizeSegment(
      type,
      intervalStart + offset,
      intervalEnd + offset,
      actualDuration,
      "aniskip",
    );
  }));
}

export function normalizeTheIntroDBResponse(payload, durationSeconds) {
  if (!payload || typeof payload !== "object") return [];

  const segments = [];
  for (const [responseKey, type] of PLAYBACK_SKIP_SEGMENTS) {
    const rows = Array.isArray(payload[responseKey]) ? payload[responseKey] : [];
    for (const row of rows) {
      const startMs = finiteNumber(row?.start_ms);
      const endMs = finiteNumber(row?.end_ms);
      if (startMs === null) continue;
      segments.push(normalizeSegment(
        type,
        startMs / 1000,
        endMs === null ? null : endMs / 1000,
        durationSeconds,
        "theintrodb",
      ));
    }
  }
  return dedupeAndSort(segments);
}

async function fetchJson(url, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`skip segment request returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function cacheKeyFor(context) {
  const duration = Math.round(finiteNumber(context.durationSeconds) || 0);
  if (context.kind === "anime") {
    return `aniskip:${context.malId}:${context.episode}:${duration}`;
  }
  return `theintrodb:${context.tmdbId || context.imdbId}:${context.season}:${context.episode}:${duration}`;
}

function readCache(key) {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.savedAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached.segments;
}

function writeCache(key, segments) {
  responseCache.set(key, { savedAt: Date.now(), segments });
  if (responseCache.size <= 250) return;
  const oldestKey = responseCache.keys().next().value;
  if (oldestKey) responseCache.delete(oldestKey);
}

export async function getSkipSegments(context, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return [];

  const durationSeconds = finiteNumber(context?.durationSeconds);
  const kind = String(context?.kind || "").toLowerCase();
  const season = Number(context?.season);
  const episode = Number(kind === "anime"
    ? context?.absoluteEpisode || context?.episode
    : context?.episode);
  if (!durationSeconds || durationSeconds <= 0 || !Number.isInteger(episode) || episode <= 0) return [];

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const normalizedContext = {
    ...context,
    kind,
    durationSeconds,
    season,
    episode,
  };
  const key = cacheKeyFor(normalizedContext);
  const cached = readCache(key);
  if (cached) return cached;

  let url;
  let normalize;
  if (kind === "anime") {
    const malId = Number(context?.malId);
    if (!Number.isInteger(malId) || malId <= 0) return [];
    url = new URL(`${ANISKIP_BASE_URL}/${malId}/${episode}`);
    for (const type of ["op", "ed", "recap"]) {
      // AniSkip expects repeated `types` parameters. Its server currently
      // returns HTTP 500 for the otherwise-common `types[]` array spelling.
      url.searchParams.append("types", type);
    }
    url.searchParams.set("episodeLength", String(Math.round(durationSeconds)));
    normalize = normalizeAniSkipResponse;
  } else if (kind === "tv") {
    const tmdbId = Number(context?.tmdbId);
    const imdbId = String(context?.imdbId || "").trim();
    if ((!Number.isInteger(tmdbId) || tmdbId <= 0) && !/^tt\d{7,10}$/i.test(imdbId)) return [];
    if (!Number.isInteger(season) || season < 0) return [];
    url = new URL(THEINTRODB_BASE_URL);
    if (Number.isInteger(tmdbId) && tmdbId > 0) url.searchParams.set("tmdb_id", String(tmdbId));
    else url.searchParams.set("imdb_id", imdbId);
    url.searchParams.set("season", String(season));
    url.searchParams.set("episode", String(episode));
    url.searchParams.set("duration_ms", String(Math.round(durationSeconds * 1000)));
    normalize = normalizeTheIntroDBResponse;
  } else {
    return [];
  }

  try {
    const fetchWithAnimeDurationFallback = async (requestUrl) => {
      try {
        return await fetchJson(requestUrl, {
          fetchImpl,
          signal: options.signal,
          timeoutMs,
        });
      } catch (error) {
        if (kind !== "anime" || options.signal?.aborted) throw error;

        // AniSkip returns HTTP 500 when no entry closely matches some supplied
        // runtimes. A duration-agnostic retry returns the available timestamps;
        // normalization below still clamps and adjusts them to the real file.
        const fallbackUrl = new URL(requestUrl);
        fallbackUrl.searchParams.set("episodeLength", "0");
        return fetchJson(fallbackUrl, {
          fetchImpl,
          signal: options.signal,
          timeoutMs,
        });
      }
    };

    const payload = await fetchWithAnimeDurationFallback(url);
    let segments = normalize(payload, durationSeconds);

    if (kind === "anime") {
      const missingTypes = new Set(["intro", "credits"]);
      for (const segment of segments) missingTypes.delete(segment.type);
      if (missingTypes.size > 0) {
        // AniSkip fails when standard and mixed filters are combined in one
        // request. Query mixed OP/ED only when their standard counterpart is
        // absent, then use them strictly to fill those gaps.
        const mixedUrl = new URL(`${ANISKIP_BASE_URL}/${normalizedContext.malId}/${episode}`);
        mixedUrl.searchParams.append("types", "mixed-op");
        mixedUrl.searchParams.append("types", "mixed-ed");
        mixedUrl.searchParams.set("episodeLength", String(Math.round(durationSeconds)));
        const mixedPayload = await fetchWithAnimeDurationFallback(mixedUrl);
        const mixedSegments = normalizeAniSkipResponse(mixedPayload, durationSeconds)
          .filter((segment) => missingTypes.has(segment.type));
        segments = dedupeAndSort([...segments, ...mixedSegments]);
      }
    }
    writeCache(key, segments);
    return segments;
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn(`[SkipSegments] ${kind} lookup unavailable:`, error?.message || error);
    }
    return [];
  }
}

export function clearSkipSegmentCache() {
  responseCache.clear();
}
