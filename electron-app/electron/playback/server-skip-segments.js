// Desktop uses the selected server's timings, including file-based detection.
// Provider lookup/normalization stays on the server, as it does for the phone.
export function skipSegmentsQuery(context) {
  const kind = String(context?.kind || '').toLowerCase();
  const duration = Number(context?.durationSeconds);
  const episode = Number(kind === 'anime' ? context?.absoluteEpisode || context?.episode : context?.episode);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(episode) || episode <= 0) return null;
  const query = new URLSearchParams({ kind, durationSeconds: String(Math.round(duration)), episode: String(episode) });
  if (kind === 'anime') {
    const malId = Number(context.malId);
    if (!Number.isInteger(malId) || malId <= 0) return null;
    query.set('malId', String(malId));
  } else if (kind === 'tv') {
    const season = Number(context.season);
    const tmdbId = Number(context.tmdbId);
    const imdbId = String(context.imdbId || '').trim();
    if (!Number.isInteger(season) || season < 0) return null;
    if (!(Number.isInteger(tmdbId) && tmdbId > 0) && !/^tt\d{7,10}$/i.test(imdbId)) return null;
    query.set('season', String(season));
    if (Number.isInteger(tmdbId) && tmdbId > 0) query.set('tmdbId', String(tmdbId));
    if (/^tt\d{7,10}$/i.test(imdbId)) query.set('imdbId', imdbId);
  } else return null;
  return query;
}

export function normalizeServerSkipSegments(payload, durationSeconds) {
  if (!Array.isArray(payload?.segments)) return [];
  const segments = new Map();
  for (const row of payload.segments) {
    if (!['intro', 'recap', 'credits'].includes(row?.type)) continue;
    if (typeof row.start !== 'number' || typeof row.end !== 'number') continue;
    const start = Math.max(0, row.start);
    const end = Math.min(durationSeconds, row.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3) continue;
    const segment = { type: row.type, start, end, provider: String(row.provider || 'server') };
    segments.set(`${segment.type}:${start}:${end}`, segment);
  }
  return [...segments.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function hasCompleteSkipSegments(segments) {
  return segments.some((segment) => segment.type === 'intro') && segments.some((segment) => segment.type === 'credits');
}

export async function getServerSkipSegments(vodBase, context, { fetchImpl = fetch, signal, timeoutMs = 15_000 } = {}) {
  const query = skipSegmentsQuery(context);
  if (!query || signal?.aborted) return [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const url = new URL('/skip-segments', vodBase);
    url.search = query.toString();
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`server returned HTTP ${response.status}`);
    return normalizeServerSkipSegments(await response.json(), Number(context.durationSeconds));
  } catch (error) {
    if (!controller.signal.aborted) console.warn('[SkipSegments] Server lookup unavailable:', error.message);
    return [];
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
