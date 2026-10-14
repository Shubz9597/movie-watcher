import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createPlaybackController } from '../electron/playback/playback-controller.js';
import { getServerSkipSegments, skipSegmentsQuery, normalizeServerSkipSegments } from '../electron/playback/server-skip-segments.js';

const context = { kind: 'anime', malId: 6033, episode: 21, absoluteEpisode: 21, durationSeconds: 1440 };
const intro = { type: 'intro', start: 25, end: 112, provider: 'detected' };
const credits = { type: 'credits', start: 1330, end: 1430, provider: 'detected' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let count = 0; count < 100; count++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'condition did not settle');
}

test('desktop skip requests match phone identity and use only the selected server', async () => {
  assert.equal(skipSegmentsQuery(context).get('episode'), '21');
  const tv = skipSegmentsQuery({ kind: 'tv', tmdbId: 1396, imdbId: 'tt0903747', season: 2, episode: 3, durationSeconds: 1440 });
  assert.equal(tv.get('tmdbId'), '1396');
  assert.equal(tv.get('imdbId'), 'tt0903747');
  assert.equal(tv.get('season'), '2');
  assert.equal(skipSegmentsQuery({ ...context, malId: undefined }), null);
  assert.equal(skipSegmentsQuery({ ...context, kind: 'movie' }), null);
  const urls = [];
  const result = await getServerSkipSegments('https://home.example:8443', context, { fetchImpl: async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ segments: [intro, credits] }));
  } });
  assert.equal(new URL(urls[0]).origin, 'https://home.example:8443');
  assert.equal(new URL(urls[0]).pathname, '/skip-segments');
  assert.deepEqual(result, [intro, credits]);
});

test('server segments preserve file detection, clamp unsafe values and discard malformed entries', () => {
  assert.deepEqual(normalizeServerSkipSegments({ segments: [intro, intro, { type: 'intro', start: '25', end: 112 }, { type: 'credits', start: 1300, end: 9000, provider: 'server' }, { type: 'other', start: 0, end: 20 }] }, 1440), [intro, { type: 'credits', start: 1300, end: 1440, provider: 'server' }]);
});

test('incomplete server skip result is retried once; episode changes cancel old work', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const events = [];
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ segments: requests === 1 ? [intro] : [intro, credits] })); };
  const controller = createPlaybackController({
    vodBase: 'https://home.example', getControlsWindow: () => ({ isDestroyed: () => false, webContents: { send: (name, segments) => { if (name === 'mpv:skipSegments') events.push(segments); } } }),
    getMpvHandle: () => null, sleep: async () => {}, skipRetryDelayMs: 20,
  });
  try {
    controller.resetSkipSegmentLookup({ malId: 6033 }, { kind: 'anime', season: 1, episode: 21 });
    controller.maybeLoadSkipSegments(1440);
    await until(() => events.some((segments) => segments.length === 2));
    await delay(40);
    assert.equal(requests, 2);
    controller.resetSkipSegmentLookup({ malId: 6033 }, { kind: 'anime', season: 1, episode: 22 });
    globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ segments: [] })); };
    controller.maybeLoadSkipSegments(1440);
    await until(() => requests === 3);
    controller.clearSkipSegmentLookup();
    await delay(40);
    assert.equal(requests, 3, 'stopped episode must not issue a delayed retry');
  } finally { controller.clearSkipSegmentLookup(); globalThis.fetch = originalFetch; }
});

test('desktop progress writes include stable client ID, per-play session ID and increasing sequence', async () => {
  const writes = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      writes.push(JSON.parse(text));
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ found: false, ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let position = 90;
  const controller = createPlaybackController({
    vodBase: `http://127.0.0.1:${server.address().port}`, getMpvHandle: () => ({ getState: () => ({ time: position, duration: 1440 }) }),
    getClientId: () => 'desktop-device', getControlsWindow: () => null, sleep: async () => {},
  });
  const identity = { subjectId: 'anilist:6033', seriesId: 'anilist:6033', season: 1, episode: 21, cat: 'anime' };
  try {
    await controller.prepareProgress(identity);
    await controller.saveCurrentProgress();
    position = 40;
    await controller.saveCurrentProgress();
    assert.equal(writes[0].clientId, 'desktop-device');
    assert.equal(writes[0].sessionId, writes[1].sessionId);
    assert.deepEqual(writes.map((write) => write.seq), [1, 2]);
    assert.equal(writes[1].position_s, 40, 'a deliberate rewind is a newer ordered write');
    await controller.prepareProgress({ ...identity, episode: 22 });
    await controller.saveCurrentProgress();
    assert.notEqual(writes.at(-1).sessionId, writes[0].sessionId);
    assert.equal(writes.at(-1).seq, 1);
    assert.equal(writes.at(-1).episode, 22);
  } finally { controller.resetProgress(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
