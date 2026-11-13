// Recommendations that learn (server recommendations.learning.v1): which
// cards were actually on screen, "not interested", and what came of the
// recommendations. All best-effort: a failure never disturbs Home.
import { buildBackendUrl } from '../api-client.ts';
import { getDeviceId } from '../device-id.ts';

export const RECOMMENDATIONS_LEARNING_CAPABILITY = 'recommendations.learning.v1';

export function serverHasRecommendationLearning(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(RECOMMENDATIONS_LEARNING_CAPABILITY);
}

function withClientId(path: string): string {
  const clientId = getDeviceId();
  return clientId ? `${path}${path.includes('?') ? '&' : '?'}clientId=${encodeURIComponent(clientId)}` : path;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(buildBackendUrl(withClientId(path)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
    signal: AbortSignal.timeout(10_000),
  });
}

// Seen cards are sent in small batches; each card once per page view.
const queued = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushSeen(): void {
  flushTimer = null;
  if (!queued.size) return;
  const items = Array.from(queued, ([canonicalId, position]) => ({ canonicalId, position }));
  queued.clear();
  void post('/v2/recommendations/seen', { items }).catch(() => {});
}

/** A recommendation card was on screen (position: its place in the row). */
export function reportSeen(canonicalId: string, position: number): void {
  const known = queued.get(canonicalId);
  queued.set(canonicalId, known === undefined ? position : Math.min(known, position));
  if (!flushTimer) flushTimer = setTimeout(flushSeen, 1500);
}

/** "Not interested" (undo: take it back). Resolves false when it wasn't saved. */
export async function sendNotInterested(canonicalId: string, title: string, undo = false): Promise<boolean> {
  try {
    const response = await post('/v2/recommendations/feedback', { canonicalId, title, kind: 'not_interested', undo });
    return response.ok;
  } catch {
    return false;
  }
}

export type RecommendationStats = {
  days: number;
  shown: number;
  opened: number;
  saved: number;
  started: number;
  finished: number;
  notInterested: number;
  model?: { samples: number; positives: number; trainedAt: string; auc: number };
};

export async function fetchRecommendationStats(): Promise<RecommendationStats | null> {
  try {
    const response = await fetch(buildBackendUrl(withClientId('/v2/recommendations/stats')), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok ? await response.json() as RecommendationStats : null;
  } catch {
    return null;
  }
}

/** One line on what came of the last month's recommendations (null: nothing yet). */
export function recommendationStatsLine(stats: RecommendationStats | null): string | null {
  if (!stats || stats.shown === 0) return null;
  const parts = [`${stats.shown} shown`, `${stats.opened} opened`, `${stats.started} started`];
  if (stats.finished) parts.push(`${stats.finished} watched`);
  const learned = stats.model ? ` · Tuned to you from ${stats.model.samples} of your choices` : ' · Still learning what you like';
  return `Last ${stats.days} days: ${parts.join(' · ')}${learned}`;
}
