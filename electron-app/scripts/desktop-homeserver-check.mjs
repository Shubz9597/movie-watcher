// Read-only live-server check with an isolated desktop profile.
// Usage: node scripts/desktop-homeserver-check.mjs <origin> <TorWatch.exe>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { normalizeDesktopConnection, probeDesktopServer } from '../electron/config/desktop-connection.js';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connection = normalizeDesktopConnection({ mode: 'remote', origin: process.argv[2] });
const executable = path.resolve(process.argv[3]);
const version = await probeDesktopServer(connection);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'torwatch-live-check-'));
const outputDirectory = path.join(projectDirectory, 'release', 'homeserver-check');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(profile, 'desktop-server.json'), JSON.stringify(connection));
const listener = http.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let child;
let page;
let diagnosticOutput = '';
const responses = [];
const pending = [];
const pageErrors = [];
try {
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    env: { ...process.env, TORWATCH_DESKTOP_PROFILE: profile },
    cwd: projectDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { diagnosticOutput += data; });
  child.stderr.on('data', (data) => { diagnosticOutput += data; });
  child.on('error', (error) => { diagnosticOutput += error.message; });
  const deadline = Date.now() + 45_000;
  while (!browser && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Desktop exited before its window could be checked.');
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }); }
    catch { await delay(200); }
  }
  assert.ok(browser, 'desktop debug connection');
  while (!page && Date.now() < deadline) {
    for (const candidate of await browser.pages()) {
      try { if (candidate.url().includes('desktop-index.html')) { page = candidate; break; } }
      catch { /* Electron may expose a page target before its main frame. */ }
    }
    if (!page) await delay(200);
  }
  assert.ok(page, 'live desktop renderer opened');
  await page.bringToFront();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (!response.url().startsWith(connection.origin)) return;
    const pathname = new URL(response.url()).pathname;
    if (!pathname.startsWith('/v2/') && !pathname.startsWith('/v1/')) return;
    pending.push((async () => {
      let payload;
      try { payload = await response.json(); } catch {}
      responses.push({ path: pathname, status: response.status(), titles: Array.isArray(payload?.results) ? payload.results.map((title) => title.title).filter(Boolean) : [] });
    })());
  });
  await page.waitForSelector('[aria-label="Search titles"]', { timeout: 35_000 });
  assert.equal(await page.evaluate(() => window.electronAPI.backendOrigin), connection.origin);
  const runtime = await page.evaluate(() => window.electronAPI.getRuntimeState());
  assert.equal(runtime.status, 'ready', runtime.message);
  // Confirm browser CORS as well as the main-process readiness probe.
  const catalog = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/v2/catalog/sections?kind=trending`);
    const payload = await response.json();
    return { status: response.status, titles: (payload.results || []).map((title) => title.title) };
  }, connection.origin);
  assert.equal(catalog.status, 200);
  assert.ok(catalog.titles.length > 0, 'real catalog titles returned');
  await page.waitForFunction((titles) => titles.some((title) => document.body.innerText.includes(title)), { timeout: 30_000 }, catalog.titles);
  await page.screenshot({ path: path.join(outputDirectory, 'home.png') });
  console.log('LIVE_DESKTOP_HOME=PASS (packaged app, server readiness, CORS, real catalog rendered)');
  await page.click('[aria-label="Search titles"]');
  await page.waitForSelector('[placeholder="Search a title, cast, or keyword"]');
  const searchResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === connection.origin && url.pathname === '/v2/catalog/search' && url.searchParams.get('q') === 'Interstellar';
  }, { timeout: 30_000 });
  await page.type('[placeholder="Search a title, cast, or keyword"]', 'Interstellar');
  const searchResponse = await searchResponsePromise;
  assert.equal(searchResponse.status(), 200);
  const searchPayload = await searchResponse.json();
  assert.ok(searchPayload.results.some((title) => title.title.includes('Interstellar')));
  await page.waitForFunction(() => [...document.querySelectorAll('[cmdk-item]')].some((item) => item.innerText.includes('Interstellar')), { timeout: 30_000 });
  await page.screenshot({ path: path.join(outputDirectory, 'search.png') });
  await Promise.allSettled(pending);
  assert.ok(responses.some((response) => response.path === '/v2/catalog/search' && response.status === 200 && response.titles.some((title) => title.includes('Interstellar'))));
  assert.deepEqual(pageErrors, []);
  console.log('LIVE_DESKTOP_SEARCH=PASS (real homeserver search results)');
  const result = { ok: true, origin: connection.origin, serverVersion: version.serverVersion, catalogTitles: catalog.titles.length, responses: responses.map(({ path, status, titles }) => ({ path, status, count: titles.length })), pageErrors };
  fs.writeFileSync(path.join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2));
} catch (error) {
  try { diagnosticOutput += '\nPAGE=' + await page.evaluate(() => document.body.innerText); } catch {}
  try { await page.screenshot({ path: path.join(outputDirectory, 'failure-page.png') }); } catch {}
  fs.writeFileSync(path.join(outputDirectory, 'failure.log'), `${error.stack}\n${diagnosticOutput}`);
  throw error;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  if (child?.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
    if (child.exitCode === null) child.kill();
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
