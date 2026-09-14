// Real shared controls, with a deterministic native-event bridge. This checks
// the WebView surface; it does not replace VLC/device playback verification.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(app, 'src', '__native-loader-smoke.html');
const output = path.join(app, '..', '.tmp', 'native-loader-review');
const baseline = process.argv.includes('--baseline');
const html = `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import Controls from '/mobile/NativePlayerControls.tsx';
import '/globals.css';
const events = {};
const player = { seekTo(){}, seekBy(){}, togglePlayback(){}, setSubtitleDelay(){}, setAudioDelay(){}, selectAudioTrack(){}, selectSubtitleTrack(){}, loadSubtitle: async () => null };
for (const name of ['Time', 'State', 'Buffering', 'Tracks']) player['subscribe' + name] = callback => {
  events[name] = callback;
  if (name === 'Buffering') callback({active:true});
  return () => { delete events[name]; };
};
const root = createRoot(document.getElementById('root'));
let generation = 0;
window.mount = (logoUrl = null, title = 'Interstellar') => {
  root.render(React.createElement(Controls, {key: ++generation, player, title, logoUrl, posterUrl:null, magnet:'', cat:'movie', season:0, episode:0, onClose: () => {window.closedPlayer = true;}}));
};
window.emit = (name, value) => events[name]?.(value);
window.mount();
</script></body></html>`;

let server, browser;
try {
  await mkdir(output, { recursive: true });
  await writeFile(fixture, html);
  server = await createServer({ configFile: path.join(app, 'vite.config.browser.mts'), root: path.join(app, 'src'), server: { host: '127.0.0.1', port: 5189, strictPort: true }, logLevel: 'error' });
  await server.listen();
  console.log('Preview server ready');
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes('/skip-segments')) return request.respond({status:200, contentType:'application/json', body:'{"segments":[]}'});
    return request.continue();
  });
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:5189/__native-loader-smoke.html');
  await page.waitForSelector('[role="status"]');
  await page.screenshot({ path: path.join(output, baseline ? 'before.png' : 'landscape-startup.png') });
  if (!baseline) {
    assert.equal(await page.locator('[role="status"]').map(el => el.textContent).wait(), 'Interstellar');
    await page.evaluate(() => window.emit('State', 'playing'));
    await page.waitForFunction(() => !document.querySelector('.native-loader--visible'));
    await page.evaluate(() => window.emit('Buffering', {active:true}));
    // A real stall appears, but never brings the title/poster back.
    await page.waitForSelector('.native-rebuffer--visible');
    assert.equal(await page.$('.native-loader--visible'), null);
    await page.screenshot({ path: path.join(output, 'landscape-buffering.png') });
    await page.evaluate(() => window.emit('Buffering', {active:false}));
    await page.waitForFunction(() => !document.querySelector('.native-rebuffer--visible'));
    await page.evaluate(async () => {
      window.emit('Buffering', {active:true});
      await new Promise(resolve => setTimeout(resolve, 150));
      window.emit('Buffering', {active:false});
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await page.$('.native-rebuffer--visible'), null, 'short cache refills must cancel the pending indicator');
    await page.waitForFunction(() => document.querySelector('button[aria-label="Close player"]')?.parentElement.classList.contains('opacity-0'), {timeout:6000});
    await page.screenshot({ path: path.join(output, 'playing.png') });
    // Failed artwork must give a readable title, not broken-image chrome.
    await page.evaluate(() => window.mount('/missing-logo.png'));
    await page.waitForFunction(() => document.querySelector('.native-loader-title')?.textContent === 'Interstellar');
    await page.setViewport({ width:390, height:844, deviceScaleFactor:1 });
    await page.screenshot({ path: path.join(output, 'portrait-fallback.png') });
    await page.setViewport({ width:1024, height:768, deviceScaleFactor:1 });
    await page.evaluate(() => window.mount(null, 'A very long movie title that should remain readable on every screen'));
    await page.waitForFunction(() => document.querySelector('.native-loader-title')?.textContent.startsWith('A very long'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, 'tablet-long-title.png') });
    // Synthetic wide transparent artwork exercises the image path without
    // network/API credentials. It is test data, not shipped title artwork.
    const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="100"><text x="450" y="72" fill="white" text-anchor="middle" font-family="serif" font-size="70" letter-spacing="8">INTERSTELLAR</text></svg>');
    await page.setViewport({ width:844, height:390, deviceScaleFactor:1 });
    await page.evaluate(logo => window.mount(logo), logo);
    await page.waitForSelector('.native-loader-logo--fill');
    assert.equal(await page.$('.native-loader-title'), null);
    await page.evaluate(() => window.emit('Buffering', {active:true, progress:45}));
    await page.waitForFunction(() => document.querySelector('.native-loader-logo--fill')?.style.clipPath === 'inset(0px 55% 0px 0px)');
    await page.screenshot({ path: path.join(output, 'landscape-logo.png') });
    await page.emulateMediaFeatures([{ name:'prefers-reduced-motion', value:'reduce' }]);
    assert.equal(await page.$eval('.native-loader-artwork', el => getComputedStyle(el).animationName), 'none');
    await page.click('button[aria-label="Close player"]');
    assert.equal(await page.evaluate(() => window.closedPlayer), true);
  }
  assert.deepEqual(errors, []);
  console.log(baseline ? 'Baseline captured: ' + output : 'Native loader smoke passed: startup, state-only completion, rebuffer, short stalls, auto-hide, image failure, logo progress, responsive layout, reduced motion, close. Captures: ' + output);
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { force: true });
}
