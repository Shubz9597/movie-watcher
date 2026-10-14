import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createDesktopConnectionStore, normalizeDesktopConnection, probeDesktopServer } from '../electron/config/desktop-connection.js';
import { desktopRendererHtml } from '../electron/config/desktop-renderer.js';
import { registerDesktopConnectionIpc } from '../electron/ipc/desktop-connection-ipc.js';
import { createStartupController } from '../electron/runtime/startup-controller.js';
import { createElectronPlatform, applyDesktopViewingProfile } from '../src/platform/electron.ts';
import { getBackendOrigin, setBackendOrigin } from '../src/lib/connection-service.ts';
import { resolveStreamUrl } from '../electron/playback/stream-url.js';
import { createPlaybackController } from '../electron/playback/playback-controller.js';

test('server addresses reject credentials, paths, queries and non-loopback local servers', () => {
  assert.deepEqual(normalizeDesktopConnection({ mode: 'remote', origin: '  https://home.ts.net:8443/ ' }), { mode: 'remote', origin: 'https://home.ts.net:8443' });
  assert.equal(normalizeDesktopConnection({ mode: 'local', origin: 'http://[::1]:8080' }).origin, 'http://[::1]:8080');
  for (const origin of ['home.ts.net', 'file:///tmp/app', 'https://user:secret@home.ts.net', 'https://home.ts.net/a', 'https://home.ts.net/?x=1', 'https://home.ts.net/#x']) {
    assert.throws(() => normalizeDesktopConnection({ mode: 'remote', origin }));
  }
  assert.throws(() => normalizeDesktopConnection({ mode: 'local', origin: 'http://192.168.1.2:8080' }));
});

test('saved server survives a new store and failed validation preserves it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'torwatch-desktop-test-'));
  try {
    const store = createDesktopConnectionStore(directory);
    assert.equal(store.load(), null);
    const connection = store.save({ mode: 'remote', origin: 'https://home.ts.net' });
    assert.equal(store.getClientId(), createDesktopConnectionStore(directory).getClientId(), 'desktop device identity survives restart');
    assert.deepEqual(createDesktopConnectionStore(directory).load(), connection);
    assert.throws(() => store.save({ mode: 'local', origin: 'http://other.lan' }));
    assert.deepEqual(store.load(), connection);
    assert.equal(fs.existsSync(`${store.filePath}.tmp`), false);
    fs.writeFileSync(store.filePath, '{broken');
    assert.equal(store.load(), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('phone viewing profile is desktop-only and unlinking restores the original desktop identity', () => {
  const previousWindow = globalThis.window;
  const values = new Map([['mw_device_id', 'desktop-original']]);
  globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) } };
  try {
    applyDesktopViewingProfile({ progressSubjectId: 'phone-profile', desktopClientId: 'desktop-writer' });
    assert.equal(values.get('mw_device_id'), 'phone-profile');
    applyDesktopViewingProfile({ progressSubjectId: 'second-phone-profile', desktopClientId: 'desktop-writer' });
    assert.equal(values.get('torwatch_desktop_original_device_id'), 'desktop-original');
    applyDesktopViewingProfile({ progressSubjectId: '', desktopClientId: 'desktop-writer' });
    assert.equal(values.get('mw_device_id'), 'desktop-original');
    assert.equal(values.has('torwatch_desktop_original_device_id'), false);
    const saved = normalizeDesktopConnection({ mode: 'remote', origin: 'https://home.ts.net', progressSubjectId: 'phone-profile' });
    assert.equal(saved.progressSubjectId, 'phone-profile');
    assert.throws(() => normalizeDesktopConnection({ ...saved, progressSubjectId: 'bad profile' }));
    assert.equal(normalizeDesktopConnection({ mode: 'local', origin: 'http://localhost:8080', progressSubjectId: 'phone-profile' }).progressSubjectId, undefined);
  } finally { globalThis.window = previousWindow; }
});

test('probe uses readiness before version and rejects incompatible or malformed responses', async () => {
  const candidate = { mode: 'remote', origin: 'https://home.ts.net' };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ serverVersion: '2.0.0', supportedProtocolRange: [1, 2], capabilities: [] }));
  };
  assert.equal((await probeDesktopServer(candidate, { fetchImpl })).serverVersion, '2.0.0');
  assert.deepEqual(requests, ['https://home.ts.net/readyz', 'https://home.ts.net/v1/version']);
  for (const payload of [{ supportedProtocolRange: [2, 3] }, {}, { supportedProtocolRange: [2, 1] }, { supportedProtocolRange: ['1', '2'] }]) {
    await assert.rejects(probeDesktopServer(candidate, { fetchImpl: async () => new Response(JSON.stringify(payload)) }), /incompatible protocol/);
  }
  await assert.rejects(probeDesktopServer(candidate, { fetchImpl: async () => new Response('', { status: 503 }) }), /not ready/);
  await assert.rejects(probeDesktopServer(candidate, { fetchImpl: async () => { throw new Error('network failed'); } }), /could not be reached/);
});

test('connection save probes first; failed edits preserve the active server and do not restart', async () => {
  const handlers = new Map();
  const ipc = { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => handlers.set(name, handler) };
  const previous = { mode: 'remote', origin: 'https://old.ts.net' };
  let saved = previous;
  let restarts = 0;
  registerDesktopConnectionIpc(ipc, {
    store: { save: (value) => { saved = normalizeDesktopConnection(value); return saved; } },
    activeConnection: previous, vodBase: previous.origin, hasLegacySetup: false,
    restart: () => { restarts++; }, openGuide: async () => ({ ok: true }),
    probe: async (candidate) => { if (candidate.origin.includes('bad')) throw new Error('unreachable'); return candidate; },
  });
  assert.equal((await handlers.get('desktop:connect-server')(null, { mode: 'remote', origin: 'https://bad.ts.net' })).ok, false);
  assert.deepEqual(saved, previous);
  assert.equal(restarts, 0);
  assert.equal((await handlers.get('desktop:connect-server')(null, { mode: 'local', origin: 'http://127.0.0.1:8080' })).ok, true);
  assert.equal(restarts, 1);
  assert.equal(saved.origin, 'http://127.0.0.1:8080');
  const event = {};
  handlers.get('desktop:get-origin')(event);
  assert.equal(event.returnValue, previous.origin, 'the current process retains its address until relaunch');
});

test('desktop HTML allows only the selected server and loads assets from the packaged dist', () => {
  const source = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8')
    .replace('./main.tsx', './assets/index.js');
  const html = desktopRendererHtml(source, 'https://home.ts.net:8443', 'C:/App/resources/app.asar/dist');
  assert.match(html, /connect-src 'self' https:\/\/home.ts.net:8443/);
  assert.match(html, /media-src 'self' blob: https:\/\/home.ts.net:8443/);
  assert.doesNotMatch(html, /127\.0\.0\.1:4001|__TORWATCH_BACKEND_ORIGIN__/);
  assert.match(html, /src="file:\/\/\/C:\/App\/resources\/app.asar\/dist\/assets\/index.js"/);
});

function startupHarness({ failure = false, connectionRequired = false } = {}) {
  let main = null;
  const calls = [];
  const fakeWindow = () => ({ once() {}, on() {}, webContents: { on() {}, send() {} }, close() {}, loadFile() {}, isDestroyed: () => false });
  const forbidden = () => { throw new Error('local runtime must not be used'); };
  const controller = createStartupController({
    app: { quit() {} }, appDirectory: '.', appResourcePaths: {},
    appConfigStore: { hasTmdbCredential: () => false, resolveSetupCredentials: forbidden },
    runtimeManager: { startBackend: forbidden, isConfigured: forbidden },
    desktopConnection: connectionRequired ? null : { mode: 'remote', origin: 'https://home.ts.net' },
    desktopConnectionRequired: connectionRequired,
    probeDesktopServer: async () => { calls.push('probe'); if (failure) throw new Error('unreachable'); },
    createMainWindow: () => { calls.push('main'); main = fakeWindow(); }, getMainWindow: () => main,
    createSetupBrowserWindow: () => { calls.push('setup'); return fakeWindow(); },
    createStartupBrowserWindow: () => fakeWindow(), verifyTmdbConnection: forbidden,
  });
  return { controller, calls };
}

test('remote startup bypasses local credentials and Docker; unreachable servers retain Settings/Retry', async () => {
  const good = startupHarness();
  await good.controller.bootstrapApplication();
  assert.deepEqual(good.calls, ['probe', 'main']);
  assert.equal(good.controller.getRuntimeState().status, 'ready');
  const bad = startupHarness({ failure: true });
  await bad.controller.bootstrapApplication();
  assert.equal(bad.controller.getRuntimeState().status, 'error');
  assert.equal(bad.controller.getCatalogState().status, 'ready');
  const firstRun = startupHarness({ connectionRequired: true });
  await firstRun.controller.bootstrapApplication();
  assert.deepEqual(firstRun.calls, ['setup']);
});

test('desktop adapter initializes the renderer from the preload origin and uses the MPV bridge', async () => {
  const previousWindow = globalThis.window;
  let request;
  globalThis.window = { electronAPI: { backendOrigin: 'https://home.ts.net:8443', playInMpv: async (value) => { request = value; return { ok: true }; } } };
  try {
    const platform = createElectronPlatform();
    assert.equal(getBackendOrigin(), 'https://home.ts.net:8443');
    await platform.player.start({ url: 'magnet:test', title: 'Test' });
    assert.equal(request.title, 'Test');
    assert.match(resolveStreamUrl(getBackendOrigin(), 'magnet:?xt=urn:btih:test'), /^https:\/\/home.ts.net:8443\/stream/);
    assert.throws(() => resolveStreamUrl(getBackendOrigin(), 'http://localhost:4001/stream'), /allowed/);
  } finally { globalThis.window = previousWindow; setBackendOrigin('http://localhost:4001'); }
});

test('main-process buffer and progress traffic reaches the selected server over real HTTP', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ found: false, buffered_s: 1 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const vodBase = `http://127.0.0.1:${server.address().port}`;
  const controller = createPlaybackController({ vodBase, getMpvHandle: () => ({ getState: () => ({ time: 20, duration: 80 }) }), getControlsWindow: () => null, sleep: async () => {} });
  try {
    controller.setPlaybackSource({ magnet: 'magnet:?xt=urn:btih:test', cat: 'movie', fileIndex: 0 });
    controller.resolveCurrentStream({ cat: 'movie', fileIndex: 0 });
    await controller.getBufferInfo();
    await controller.prepareProgress({ subjectId: 'tmdb:movie:1', seriesId: 'tmdb:movie:1', season: 0, episode: 0 });
    await controller.saveCurrentProgress();
    assert.ok(requests.some((request) => request.url.startsWith('/buffer/info')));
    assert.ok(requests.some((request) => request.url.startsWith('/v1/resume')));
    assert.ok(requests.some((request) => request.url === '/v1/session/heartbeat' && request.method === 'POST'));
  } finally { controller.resetAfterStop(); await new Promise((resolve) => server.close(resolve)); }
});
