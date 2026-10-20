// The player's loader stays until the picture is really there: the player
// reports "playing" before its first frame (at once for a download) and while
// the phone still turns to landscape. Real shared controls, fake native events.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(app, 'src', '__native-reveal-smoke.html');
const output = path.join(app, '..', '.tmp', 'native-reveal-review');
const baseline = process.argv.includes('--baseline');
const html = `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import Controls from '/mobile/NativePlayerControls.tsx';
import '/globals.css';
const events = {};
window.controlCalls = [];
const player = {
  seekTo(position){ window.controlCalls.push(['seek', position]); },
  seekBy(){},
  togglePlayback(){ window.controlCalls.push(['toggle']); },
  setVideoScale(mode){ window.controlCalls.push(['scale', mode]); },
  setEmbeddedSubtitleScale(){},
  setSubtitleDelay(){}, setAudioDelay(){}, selectAudioTrack(){}, selectSubtitleTrack(){}, loadSubtitle: async () => null
};
for (const name of ['Time', 'State', 'Buffering', 'Tracks']) player['subscribe' + name] = callback => {
  events[name] = callback;
  if (name === 'Buffering') callback({active:true});
  return () => { delete events[name]; };
};
const root = createRoot(document.getElementById('root'));
let generation = 0;
window.mount = (logoUrl = null, title = 'Interstellar', season = 0, episode = 0) => {
  root.render(React.createElement(Controls, {key: ++generation, player, title, logoUrl, posterUrl:null, magnet:'', cat:episode > 0 ? 'anime' : 'movie', season, episode, onClose: () => {window.closedPlayer = true;}}));
};
window.emit = (name, value) => events[name]?.(value);
window.mount();
</script></body></html>`;

let server, browser;
try {
  await mkdir(output, { recursive: true });
  await writeFile(fixture, html);
  server = await createServer({ configFile: path.join(app, 'vite.config.browser.mts'), root: path.join(app, 'src'), server: { host: '127.0.0.1', port: 5190, strictPort: true }, logLevel: 'error' });
  await server.listen();
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => request.url().includes('/skip-segments')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{"segments":[]}' })
    : request.continue());
  const loaderShown = () => page.evaluate(() => Boolean(document.querySelector('.native-loader--visible')));
  // The seek bar is always in the page; it is hidden until the picture shows.
  const controlsShown = () => page.evaluate(() => {
    const seek = document.querySelector('input[type="range"]');
    return Boolean(seek) && getComputedStyle(seek).visibility === 'visible';
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Still turning (portrait), player already "playing", clock moving: the
  // loader stays and no controls show over the black screen.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:5190/__native-reveal-smoke.html');
  await page.waitForSelector('.native-loader--visible');
  await page.evaluate(() => {
    window.emit('Buffering', { active: false });
    window.emit('State', 'playing');
    window.emit('Time', { currentTime: 770, duration: 1386 });
    window.emit('Time', { currentTime: 770.4, duration: 1386 });
  });
  await sleep(600);
  assert.equal(await loaderShown(), true, 'loader stays while the phone is still portrait');
  assert.equal(await controlsShown(), false, 'no controls over the black screen');
  await page.screenshot({ path: path.join(output, 'turning.png') });

  // Landscape reached: the picture shows within a moment.
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
  await page.waitForFunction(() => !document.querySelector('.native-loader--visible'), { timeout: 1500 });
  assert.equal(await controlsShown(), true, 'controls once the picture is there');
  await page.screenshot({ path: path.join(output, 'shown.png') });

  // Landscape, "playing" but no frame yet (clock still): loader stays...
  await page.evaluate(() => window.mount(null, 'Dragon Ball Z Kai', 1, 53));
  await page.waitForSelector('.native-loader--visible');
  await page.evaluate(() => {
    window.emit('State', 'playing');
    window.emit('Time', { currentTime: 770, duration: 1386 });
  });
  await sleep(600);
  assert.equal(await loaderShown(), true, 'loader stays until the clock moves');
  // ...and gives way after 3 s at most (paused at the start, audio only).
  await page.waitForFunction(() => !document.querySelector('.native-loader--visible'), { timeout: 4000 });
  assert.deepEqual(errors, []);
  console.log('Native reveal smoke passed. Captures: ' + output);
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { force: true });
}
