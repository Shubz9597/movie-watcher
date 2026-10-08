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
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.native-loader')).opacity === '0');
    await page.evaluate(() => window.emit('State', 'paused'));
    // Size changes must reach the player once, including while paused, and
    // the brief mode pill belongs immediately below the centered title.
    for (const mode of ['Fill', 'Stretch', 'Fit']) {
      await page.click(`button[aria-label="${mode}"]`);
      await page.waitForFunction(mode => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent === mode), {}, mode);
      const placement = await page.$eval('[role="status"]', pill => {
        const title = pill.previousElementSibling;
        return {
          title: title?.textContent,
          centered: Math.abs(pill.getBoundingClientRect().left + pill.getBoundingClientRect().width / 2 - innerWidth / 2) < 1,
          below: pill.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
          alignment: getComputedStyle(title).textAlign,
        };
      });
      assert.deepEqual(placement, {title:'Interstellar', centered:true, below:true, alignment:'center'});
      await page.screenshot({ path: path.join(output, `landscape-${mode.toLowerCase()}.png`) });
    }
    assert.deepEqual(await page.evaluate(() => window.controlCalls), [['scale','fill'], ['scale','stretch'], ['scale','fit']], 'sizing must not toggle playback or seek');
    assert.equal(await page.$('[data-player-episode]'), null, 'movies have no episode suffix');
    await page.evaluate(() => window.emit('State', 'playing'));
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
    await page.evaluate(() => {
      window.emit('State', 'paused');
      window.emit('Time', {currentTime:250, duration:1400});
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.native-loader')).opacity === '0');
    await page.click('button[aria-label="Fill"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent === 'Fill'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, 'tablet-controls-long-title.png') });
    await page.setViewport({ width:390, height:844, deviceScaleFactor:1 });
    await page.screenshot({ path: path.join(output, 'portrait-controls-long-title.png') });
    for (const [title, season, episode, expected, width, height] of [
      ['Dragon Ball Z Kai', 1, 1, 'S01E01', 874, 402],
      ['Dragon Ball Z Kai', 1, 125, 'S01E125', 874, 402],
      ['Dragon Ball Z Kai', 0, 3, 'S00E03', 874, 402],
      ['A very long episode title that should truncate without hiding the episode number', 2, 12, 'S02E12', 390, 844],
    ]) {
      await page.setViewport({width, height, deviceScaleFactor:1});
      await page.evaluate(([title, season, episode]) => {
        window.localStorage.setItem('mw_video_scale', 'fill');
        window.mount(null, title, season, episode);
      }, [title, season, episode]);
      await page.waitForFunction(title => document.querySelector('.native-loader-title')?.textContent === title, {}, title);
      await page.evaluate(() => window.emit('State', 'paused'));
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.native-loader')).opacity === '0');
      assert.equal(await page.$eval('[data-player-episode]', el => el.textContent), expected);
      await page.click('button[aria-label="Stretch"]');
      await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent === 'Stretch'));
      const placement = await page.$eval('[data-player-heading]', heading => {
        const episode = heading.querySelector('[data-player-episode]');
        const pill = heading.nextElementSibling;
        return {
          centered: Math.abs(heading.getBoundingClientRect().left + heading.getBoundingClientRect().width / 2 - innerWidth / 2) < 1,
          pillCentered: Math.abs(pill.getBoundingClientRect().left + pill.getBoundingClientRect().width / 2 - innerWidth / 2) < 1,
          below: pill.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom,
          episodeVisible: episode.getBoundingClientRect().right <= innerWidth && episode.getBoundingClientRect().left >= 0,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.deepEqual(placement, {centered:true, pillCentered:true, below:true, episodeVisible:true, overflow:false});
      await page.screenshot({path:path.join(output, `episode-${expected.toLowerCase()}.png`)});
      // Return to Fit so each remount exercises the same first mode change.
      await page.click('button[aria-label="Fit"]');
    }
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
  console.log(baseline ? 'Baseline captured: ' + output : 'Native controls smoke passed: sizing cycle while paused, title/pill placement, startup, rebuffer, auto-hide, artwork fallback, responsive layout, reduced motion, close. Captures: ' + output);
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { force: true });
}
