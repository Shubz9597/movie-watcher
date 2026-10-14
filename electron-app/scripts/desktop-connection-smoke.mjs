// Drive the real main.js (or packaged executable) with an isolated profile.
// Stub-backed catalog evidence; no Docker or real-provider claims.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.argv[2] || path.join(projectDirectory, 'node_modules', 'electron', 'dist', 'electron.exe');
const packaged = Boolean(process.argv[2]);
const resultDirectory = path.join(projectDirectory, 'release', 'desktop-v2-smoke');
fs.mkdirSync(resultDirectory, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'torwatch-desktop-smoke-'));
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push(url.pathname);
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const version = { serverVersion: '2.0.0-smoke', supportedProtocolRange: [1, 1], capabilities: [] };
  let body = {};
  if (url.pathname === '/v1/version') body = version;
  else if (url.pathname === '/v2/catalog/sections' || url.pathname === '/v2/catalog/search') body = { results: [{ id: 'tmdb:movie:1', type: 'movie', title: 'Desktop V2 Test Movie', providerIds: { tmdb: 'movie:1' } }], page: 1, totalPages: 1 };
  else if (url.pathname.includes('continue')) body = { items: [], results: [] };
  else if (url.pathname !== '/readyz' && url.pathname !== '/healthz') { res.statusCode = 404; body = { error: { code: 'unsupported_capability', message: 'Smoke fixture endpoint unavailable' } }; }
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenshotOptions = { captureBeyondViewport: false };
let child;
let browser;
let output = '';

async function freePort() {
  const listener = http.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function launch() {
  const debugPort = await freePort();
  child = spawn(executable, [...(packaged ? [] : [projectDirectory]), `--remote-debugging-port=${debugPort}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: projectDirectory,
    env: { ...process.env, TORWATCH_DESKTOP_PROFILE: profile }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  child.on('error', (error) => { output += error.message; });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop exited early: ${output.slice(-2500)}`);
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null, protocolTimeout: 60_000 }); return debugPort; }
    catch { await delay(150); }
  }
  throw new Error(`Desktop debug endpoint did not open: ${output.slice(-2500)}`);
}
async function waitForPage(text) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const page of await browser.pages()) {
      try { if ((await page.evaluate(() => document.body.innerText)).includes(text)) { await page.bringToFront(); return page; } } catch {}
    }
    await delay(100);
  }
  for (const page of await browser.pages()) {
    try {
      console.log('DESKTOP_FAILURE_PAGE=' + JSON.stringify(await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1200), origin: window.electronAPI?.backendOrigin }))));
      await page.screenshot({ ...screenshotOptions, path: path.join(resultDirectory, 'failure-page.png') });
    } catch {}
  }
  throw new Error(`Desktop did not show ${text}: ${output.slice(-2500)}`);
}
async function closeDesktop() {
  const running = child;
  if (browser) { try { await browser.close(); } catch {} browser = null; }
  if (running && running.exitCode === null) {
    await Promise.race([new Promise((resolve) => running.once('exit', resolve)), delay(5_000)]);
    if (running.exitCode === null) running.kill();
  }
  child = null;
  await delay(200);
}

try {
  const setupDebugPort = await launch();
  let page = await waitForPage('Set up TorWatch');
  await page.screenshot({ ...screenshotOptions, path: path.join(resultDirectory, 'setup-remote.png') });
  await page.click('input[name="server-mode"][value="local"]');
  assert.equal(await page.$eval('input[type="url"]', (input) => input.value), 'http://127.0.0.1:8080');
  await page.screenshot({ ...screenshotOptions, path: path.join(resultDirectory, 'setup-local.png') });
  await page.$eval('input[type="url"]', (input) => input.focus());
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.type('input[type="url"]', `${origin}/invalid`);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Test connection').click());
  await page.waitForFunction(() => document.querySelector('[data-error="true"]')?.innerText.includes('without a path'), { timeout: 10_000 });
  assert.equal(fs.existsSync(path.join(profile, 'desktop-server.json')), false);
  await page.screenshot({ ...screenshotOptions, path: path.join(resultDirectory, 'setup-error.png') });
  await page.click('input[type="url"]');
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control');
  await page.type('input[type="url"]', origin);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.body.innerText.includes('TorWatch is restarting'), { timeout: 10_000 }).catch(() => {});
  browser.disconnect(); browser = null;
  await delay(500);
  const restartDeadline = Date.now() + 25_000;
  while (!browser && Date.now() < restartDeadline) {
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${setupDebugPort}`, defaultViewport: null, protocolTimeout: 60_000 }); }
    catch { await delay(150); }
  }
  assert.ok(browser, 'saving a valid server must relaunch the app');
  page = await waitForPage('Desktop V2 Test Movie');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'desktop-server.json'), 'utf8')), { mode: 'local', origin });
  await closeDesktop();
  console.log('DESKTOP_FIRST_RUN=PASS (both choices, invalid-edit preservation, save and real app relaunch)');

  for (const mode of ['remote', 'local']) {
    const phoneProfile = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(profile, 'desktop-server.json'), JSON.stringify({ mode, origin, ...(mode === 'remote' ? { progressSubjectId: phoneProfile } : {}) }));
    await launch();
    page = await waitForPage('Desktop V2 Test Movie');
    assert.equal(await page.evaluate(() => window.electronAPI.backendOrigin), origin);
    const viewingProfile = await page.evaluate(() => localStorage.getItem('mw_device_id'));
    if (mode === 'remote') {
      assert.equal(viewingProfile, phoneProfile);
      assert.notEqual(await page.evaluate(() => window.electronAPI.desktopClientId), phoneProfile, 'viewing profile and desktop writer remain separate');
    } else assert.notEqual(viewingProfile, phoneProfile, 'unlinking restores the desktop progress profile');
    assert.equal(await page.evaluate(async () => (await window.electronAPI.getRuntimeState()).status), 'ready');
    const policy = await page.$eval('meta[http-equiv="Content-Security-Policy"]', (meta) => meta.content);
    assert.ok(policy.includes(origin));
    assert.ok(!policy.includes('localhost:4001'));
    await page.screenshot({ ...screenshotOptions, path: path.join(resultDirectory, `catalog-${mode}.png`) });
    assert.ok(requests.includes('/v2/catalog/sections'), 'renderer reached the chosen BFF');
    assert.ok(!output.includes('ERR_MODULE_NOT_FOUND'));
    await closeDesktop();
    console.log(`DESKTOP_${mode.toUpperCase()}_STARTUP=PASS (real main.js, BFF UI, exact CSP, saved profile)`);
  }
  assert.ok(!fs.existsSync(path.join(profile, 'runtime', 'settings.json')), 'no local runtime was configured');
  fs.writeFileSync(path.join(resultDirectory, 'result.json'), JSON.stringify({ ok: true, packaged, requests }, null, 2));
} catch (error) {
  let diagnostics = '';
  try { diagnostics = fs.readFileSync(path.join(profile, 'logs', 'errors.log'), 'utf8').slice(-12000); } catch {}
  fs.writeFileSync(path.join(resultDirectory, 'failure.log'), `${error.stack}\n${output}\n${diagnostics}`);
  throw error;
} finally {
  await closeDesktop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // Own temp profile only; preserve captures and diagnostics in release/.
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
