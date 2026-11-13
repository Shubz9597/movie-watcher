import test from 'node:test';
import assert from 'node:assert/strict';
import { setBackendOrigin } from '../../src/lib/connection-service.ts';
import {
  recommendationStatsLine,
  reportSeen,
  sendNotInterested,
  serverHasRecommendationLearning,
} from '../../src/lib/services/recommendation-feedback.ts';

function captureFetch(status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    return new Response(status === 204 ? null : JSON.stringify({ ok: status < 300 }), { status });
  };
  return calls;
}

test('cards seen together go to the server in one batch, each once, at its best place', async () => {
  setBackendOrigin('http://server.test');
  const calls = captureFetch(204);
  reportSeen('tmdb:tv:1', 3);
  reportSeen('tmdb:tv:2', 4);
  reportSeen('tmdb:tv:1', 1); // scrolled back: the better place counts
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  // (In the app the device's clientId rides along; Node has no device id.)
  assert.match(calls[0].url, /^http:\/\/server\.test\/v2\/recommendations\/seen/);
  assert.deepEqual(calls[0].body, { items: [{ canonicalId: 'tmdb:tv:1', position: 1 }, { canonicalId: 'tmdb:tv:2', position: 4 }] });
});

test('not interested says whether the server kept it', async () => {
  setBackendOrigin('http://server.test');
  let calls = captureFetch(200);
  assert.equal(await sendNotInterested('tmdb:tv:9', 'Fantasy Island'), true);
  assert.deepEqual(calls[0].body, { canonicalId: 'tmdb:tv:9', title: 'Fantasy Island', kind: 'not_interested', undo: false });
  assert.equal(await sendNotInterested('tmdb:tv:9', 'Fantasy Island', true), true);
  assert.equal(calls[1].body.undo, true);
  calls = captureFetch(500);
  assert.equal(await sendNotInterested('tmdb:tv:9', 'Fantasy Island'), false);
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await sendNotInterested('tmdb:tv:9', 'Fantasy Island'), false);
});

test('the stats line says what came of the recommendations and whether they are tuned yet', () => {
  assert.equal(recommendationStatsLine(null), null);
  assert.equal(recommendationStatsLine({ days: 30, shown: 0, opened: 0, saved: 0, started: 0, finished: 0, notInterested: 0 }), null);
  assert.equal(
    recommendationStatsLine({ days: 30, shown: 24, opened: 5, saved: 1, started: 2, finished: 0, notInterested: 1 }),
    'Last 30 days: 24 shown · 5 opened · 2 started · Still learning what you like',
  );
  assert.equal(
    recommendationStatsLine({ days: 30, shown: 46, opened: 9, saved: 3, started: 4, finished: 2, notInterested: 5, model: { samples: 38, positives: 11, trainedAt: '', auc: 0.8 } }),
    'Last 30 days: 46 shown · 9 opened · 4 started · 2 watched · Tuned to you from 38 of your choices',
  );
});

test('learning is only used on servers that advertise it', () => {
  assert.equal(serverHasRecommendationLearning(['recommendations.basic.v1']), false);
  assert.equal(serverHasRecommendationLearning(['recommendations.basic.v1', 'recommendations.learning.v1']), true);
  assert.equal(serverHasRecommendationLearning(null), false);
});
