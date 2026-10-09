// Exercise real controls through stop/remount and a WebView reload. The
// deterministic bridge verifies persistence without requiring an iOS runtime.
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(app, 'src', '__native-preferences-smoke.html');
const html = `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import Controls from '/mobile/NativePlayerControls.tsx';
import { setBackendOrigin } from '/lib/connection-service.ts';
import { readVideoPlaybackPreferences, videoPlaybackPreferenceKey } from '/mobile/video-playback-preferences.ts';
import '/globals.css';
setBackendOrigin(location.origin);
const events = {};
window.calls = [];
const player = {seekTo(){}, seekBy(){}, togglePlayback(){window.calls.push(['togglePlayback']);}, setVideoScale(){}, setEmbeddedSubtitleScale(){}, loadSubtitle:async()=>null};
for (const name of ['setSubtitleDelay','setAudioDelay','selectSubtitleTrack','selectAudioTrack']) player[name] = value => window.calls.push([name, value]);
for (const name of ['Time','State','Buffering','Tracks']) player['subscribe' + name] = callback => {events[name]=callback; return () => {delete events[name];};};
const root = createRoot(document.getElementById('root'));
let generation = 0;
const input = {origin:location.origin, magnet:'magnet:?xt=urn:btih:abcdef123456', cat:'anime', season:1, episode:1, fileIndex:0};
window.readPreferences = (change = {}) => readVideoPlaybackPreferences(videoPlaybackPreferenceKey({...input, ...change}));
window.mount = (change = {}) => {
  window.calls = [];
  root.render(React.createElement(Controls, {...input, ...change, key:++generation, player, title:'Dragon Ball Z Kai', posterUrl:null, logoUrl:null, onClose:()=>{root.render(null);}}));
};
window.emit = (name, value) => events[name]?.(value);
window.mount();
</script></body></html>`;

let server, browser;
let pendingResponse;
let slowNextSubtitle = false;
let downloads = 0;
const errors = [];
try {
  await writeFile(fixture, html);
  server = await createServer({configFile:path.join(app,'vite.config.browser.mts'), root:path.join(app,'src'), server:{host:'127.0.0.1',port:5190,strictPort:true}, logLevel:'error'});
  await server.listen();
  browser = await puppeteer.launch({headless:true});
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({width:874,height:402});
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    const json = body => request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if (url.pathname === '/subtitles/list') return json({tracks:[{source:'opensub',lang:'en',label:'English',fileName:'release-a.srt',url:'/subtitles/external?source=opensub&id=100',format:'vtt'}]});
    if (url.pathname === '/skip-segments') return json({segments:[]});
    if (url.pathname === '/subtitles/external') {
      downloads++;
      const respond = () => request.respond({status:200,contentType:'text/vtt',body:'WEBVTT\n\n00:00:14.000 --> 00:00:16.000\nSaved subtitle dialogue\n'});
      if (slowNextSubtitle) {slowNextSubtitle=false; pendingResponse=respond; return;}
      return respond();
    }
    return request.continue();
  });
  const url = 'http://127.0.0.1:5190/__native-preferences-smoke.html';
  const ready = async (tracks = {audio:[{id:1,label:'English',language:'en'}, {id:2,label:'Japanese',language:'ja'}],subtitles:[{id:4,label:'English embedded',language:'en'}]}) => {
    await page.waitForSelector('.native-loader--visible');
    await page.evaluate(tracks => {
      window.emit('State','paused');
      window.emit('Time',{currentTime:10,duration:1400});
      window.emit('Tracks',{...tracks,selectedSubtitleTrackId:-1});
    }, tracks);
    await page.waitForFunction(() => !document.querySelector('.native-loader--visible'));
  };
  const mount = async change => {
    await page.evaluate(change => window.mount(change), change ?? {});
    await ready();
  };
  const clickText = async text => {
    await page.waitForFunction(text => [...document.querySelectorAll('button')].some(el => el.textContent === text || el.querySelector('span')?.textContent === text), {}, text);
    await page.evaluate(text => [...document.querySelectorAll('button')].find(el => el.textContent === text || el.querySelector('span')?.textContent === text).click(), text);
  };
  await page.goto(url);
  await ready();
  // Track changes make VLC rebuild its streams (a frozen frame): a playing
  // video pauses while Audio and subtitles is open and resumes after; a
  // paused one stays paused.
  const toggles = () => page.evaluate(() => window.calls.filter(([name]) => name === 'togglePlayback').length);
  await page.evaluate(() => { window.emit('State','playing'); window.calls = []; });
  await page.click('button[aria-label="Audio and subtitles"]');
  assert.equal(await toggles(), 1, 'opening the panel pauses playback');
  await page.click('button[aria-label="Close Audio and subtitles"]');
  assert.equal(await toggles(), 2, 'closing the panel resumes playback');
  await page.evaluate(() => { window.emit('State','paused'); window.calls = []; });
  await page.click('button[aria-label="Audio and subtitles"]');
  await page.click('button[aria-label="Close Audio and subtitles"]');
  assert.equal(await toggles(), 0, 'a paused video stays paused');
  await page.click('button[aria-label="Audio and subtitles"]');
  await clickText('Search online subtitles'); // the video has its own track
  await clickText('release-a.srt');
  await page.waitForFunction(() => window.readPreferences()?.subtitle?.kind === 'external');
  await page.click('button[aria-label="Close Audio and subtitles"]');
  await page.click('button[aria-label="Timing sync"]');
  // Four presses of -1 s reach -4 s (the old control needed 40 presses);
  // fine steps and the slider land on the same tenths.
  for (let index = 0; index < 4; index++) await page.click('button[aria-label="Subtitles 1 second earlier"]');
  await page.click('button[aria-label="Subtitles earlier"]');
  await page.click('button[aria-label="Subtitles later"]');
  await page.waitForFunction(() => window.readPreferences()?.subtitleDelay === -4);
  await page.$eval('input[aria-label="Subtitles timing"]', input => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '-2.5');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await page.waitForFunction(() => window.readPreferences()?.subtitleDelay === -2.5);
  for (let index = 0; index < 15; index++) await page.click('button[aria-label="Subtitles earlier"]');
  await page.waitForFunction(() => window.readPreferences()?.subtitleDelay === -4);
  assert.equal(await page.evaluate(() => document.body.textContent.includes('Saved subtitle dialogue')), true, 'negative delay must move the actual overlay, not just the timing display');
  // Holding a step button repeats it (once on press, then every 100 ms).
  await page.$eval('button[aria-label="Audio 1 second later"]', el => el.scrollIntoView({block: 'center'}));
  const holdBox = await (await page.$('button[aria-label="Audio 1 second later"]')).boundingBox();
  await page.mouse.move(holdBox.x + holdBox.width / 2, holdBox.y + holdBox.height / 2);
  await page.mouse.down();
  await new Promise(resolve => setTimeout(resolve, 900));
  await page.mouse.up();
  const held = await page.evaluate(() => window.readPreferences()?.audioDelay);
  assert.ok(held >= 4, `holding +1s must repeat (got ${held})`);
  await page.click('button[aria-label="Reset audio timing"]');
  await page.waitForFunction(() => window.readPreferences()?.audioDelay === 0);
  await page.click('button[aria-label="Audio later"]');
  await page.click('button[aria-label="Close Timing sync"]');
  await page.click('button[aria-label="Audio and subtitles"]');
  await clickText('Japanese');
  await page.click('button[aria-label="Close Audio and subtitles"]');
  await page.click('button[aria-label="Close player"]');
  await page.waitForFunction(() => !document.querySelector('.native-loader'));

  // Reload clears all React/bridge memory, preserving only durable storage.
  await page.reload();
  await ready({audio:[{id:11,label:'English',language:'en'},{id:22,label:'Japanese',language:'ja'}],subtitles:[{id:44,label:'English embedded',language:'en'}]});
  await page.waitForFunction(() => document.body.textContent.includes('Saved subtitle dialogue'));
  const restoredCalls = await page.evaluate(() => window.calls);
  assert.ok(restoredCalls.some(([name,value]) => name === 'setSubtitleDelay' && value === -4));
  assert.ok(restoredCalls.some(([name,value]) => name === 'setAudioDelay' && value === 0.1));
  assert.ok(restoredCalls.some(([name,value]) => name === 'selectAudioTrack' && value === 22));
  assert.equal(await page.$('h2'), null, 'automatic restore must not open a settings sheet');
  assert.equal(downloads, 2, 'the same selected OpenSubtitles URL is restored directly');
  await page.click('button[aria-label="Audio and subtitles"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.querySelector('span')?.textContent === 'release-a.srt' && el.getAttribute('aria-pressed') === 'true'));
  await clickText('Off');
  await page.waitForFunction(() => window.readPreferences()?.subtitle?.kind === 'off');
  await mount();
  await page.waitForFunction(() => window.calls.some(([name,value]) => name === 'selectSubtitleTrack' && value === null));
  assert.equal(downloads, 2, 'Off remains Off on resume');
  assert.equal(await page.evaluate(() => document.body.textContent.includes('Saved subtitle dialogue')), false);

  await page.click('button[aria-label="Audio and subtitles"]');
  await clickText('English embedded');
  await page.waitForFunction(() => window.readPreferences()?.subtitle?.kind === 'embedded');
  await page.evaluate(() => {window.calls=[]; window.mount();});
  await page.waitForSelector('.native-loader--visible');
  await page.evaluate(() => window.emit('State','paused'));
  assert.equal(await page.evaluate(() => window.calls.some(([name]) => name === 'selectSubtitleTrack')), false, 'embedded restoration waits for its inventory');
  await page.evaluate(() => window.emit('Tracks',{audio:[],subtitles:[{id:77,label:'English embedded',language:'en'}],selectedSubtitleTrackId:-1}));
  await page.waitForFunction(() => window.calls.some(([name,value]) => name === 'selectSubtitleTrack' && value === 77));

  await mount({episode:2,fileIndex:1});
  assert.equal(await page.evaluate(() => window.readPreferences({episode:2,fileIndex:1})), null);
  assert.equal(await page.evaluate(() => document.body.textContent.includes('Saved subtitle dialogue')), false);
  await page.click('button[aria-label="Timing sync"]');
  assert.deepEqual(await page.$$eval('output', els => els.map(el => el.textContent)), ['0.0s','0.0s']);

  // A restore response completing after replacement cannot touch the new video.
  await mount();
  await page.click('button[aria-label="Audio and subtitles"]');
  await clickText('Search online subtitles'); // the video has its own track
  await clickText('release-a.srt');
  await page.waitForFunction(() => window.readPreferences()?.subtitle?.kind === 'external');
  slowNextSubtitle = true;
  await mount();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Audio and subtitles"]'));
  const started = Date.now();
  while (!pendingResponse && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve,20));
  assert.ok(pendingResponse, 'restore request should be pending');
  await mount({episode:2,fileIndex:1});
  await page.evaluate(() => {window.calls=[];});
  await pendingResponse();
  pendingResponse = null;
  await new Promise(resolve => setTimeout(resolve,150));
  assert.equal(await page.evaluate(() => document.body.textContent.includes('Saved subtitle dialogue')), false);
  assert.equal(await page.evaluate(() => window.calls.some(([name]) => name === 'selectSubtitleTrack')), false);
  // No saved choice: the video's own full English track is shown (not a
  // signs-only default), and tracks read as languages.
  await page.evaluate(() => { window.calls = []; window.mount({episode: 9, fileIndex: 5}); });
  await ready({audio:[{id:1,label:'Track 1 - [Japanese]'}], subtitles:[{id:2,label:'Signs & Songs - [English]'},{id:3,label:'Full Subtitles - [English]'}]});
  await page.waitForFunction(() => window.calls.some(([name, value]) => name === 'selectSubtitleTrack' && value === 3));
  await page.click('button[aria-label="Audio and subtitles"]');
  for (const name of ['Japanese', 'English · Signs & Songs', 'English · Full Subtitles']) {
    await page.waitForFunction(name => [...document.querySelectorAll('button span')].some(el => el.textContent === name), {}, name);
  }
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed="true"] span')].map(el => el.textContent).includes('English · Full Subtitles')), true);
  await page.click('button[aria-label="Close Audio and subtitles"]');
  assert.deepEqual(errors, []);
  console.log('Video preferences smoke passed: default full-dialogue track, readable names, external selection, real overlay delay, reload/restore, Off, delayed embedded inventory, audio, episode isolation, stale-download cancellation.');
} finally {
  await pendingResponse?.().catch(() => {});
  await browser?.close();
  await server?.close();
  await rm(fixture,{force:true});
}
