// Verify the shipped mobile web bundle; native launch handoff still needs devices.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(app, 'dist-mobile');
const out = path.join(app, 'node_modules/.launch-screen-check');
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' })[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ headless: true, pipe: true });
  const boot = await browser.newPage();
  await boot.setViewport({ width: 390, height: 844 });
  await boot.setJavaScriptEnabled(false);
  await boot.goto(base);
  const bootLogo = await boot.$eval('.tw-startup-splash img', img => {
    const rect = img.getBoundingClientRect();
    return { loaded: img.complete && img.naturalWidth > 0, center: rect.y + rect.height / 2 };
  });
  assert.equal(bootLogo.loaded, true);
  assert.equal(bootLogo.center, 422);
  await boot.screenshot({ path: path.join(out, 'before-javascript.png') });
  await boot.close();
  for (const [name, width, height, reduce] of [
    ['phone', 390, 844, false], ['narrow', 320, 740, false],
    ['landscape', 844, 390, false], ['desktop', 1280, 900, false],
    ['reduced-motion', 390, 844, true],
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width, height, isMobile: width < 1024, hasTouch: width < 1024 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }]);
    await page.evaluateOnNewDocument(() => {
      window.launchFrames = [];
      const frame = () => {
        const logo = document.querySelector('.tw-launch-logo');
        if (logo) {
          const rect = logo.getBoundingClientRect();
          window.launchFrames.push({ y: rect.y + rect.height / 2, stage: logo.parentElement.dataset.stage });
        }
        if (window.launchFrames.length < 100) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.goto(`${base}/?fixtures=unreachable`, { waitUntil: 'domcontentloaded' });
    if (!reduce) {
      await page.waitForSelector('[data-stage="splash"]');
      await page.screenshot({ path: path.join(out, `${name}-splash.png`) });
    }
    await page.waitForSelector('#server-origin');
    await page.waitForFunction(() => {
      const fades = [...document.querySelectorAll('.tw-launch-fade')];
      return fades.length === 3 && fades.every(el => getComputedStyle(el).opacity === '1');
    });
    const geometry = await page.evaluate(() => {
      const logo = document.querySelector('.tw-launch-logo');
      const rect = logo.getBoundingClientRect();
      return {
        centerY: rect.y + rect.height / 2,
        overflow: document.documentElement.scrollWidth > innerWidth,
        transition: getComputedStyle(logo).transitionDuration,
        frames: window.launchFrames,
      };
    });
    assert.equal(geometry.overflow, false, `${name}: horizontal overflow`);
    assert.ok(geometry.centerY < height / 2 - 20, `${name}: logo moved up`);
    // Global reduced-motion rules use 0.01ms so animation events still fire.
    if (reduce) assert.ok(parseFloat(geometry.transition) <= 0.00001);
    else {
      assert.ok(Math.abs(geometry.frames[0].y - height / 2) < 2, `${name}: starts centered`);
      assert.ok(new Set(geometry.frames.map(f => Math.round(f.y))).size > 4, `${name}: continuous movement`);
    }
    await page.screenshot({ path: path.join(out, `${name}-connect.png`), fullPage: true });
    await page.focus('#server-origin');
    await page.$eval('#server-origin', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    // Use keyboard input so React observes the change.
    await page.click('#server-origin', { clickCount: 3 });
    await page.type('#server-origin', 'not-a-server');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="alert"]');
    assert.match(await page.$eval('[role="alert"]', el => el.textContent), /complete server address/);
    assert.deepEqual(errors, []);
    console.log(`${name}: centered splash, upward transition, form, validation, and overflow checks passed`);
    await page.close();
  }

  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().startsWith(base) || req.url().startsWith('data:')) void req.continue();
    else setTimeout(() => { void req.abort(); }, 350);
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#server-origin');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.tw-launch-delay-3')).opacity === '1');
  await page.focus('#server-origin');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type('http://127.0.0.1:49999');
  await page.evaluate(() => { window.originalField = document.querySelector('#server-origin'); });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled === true);
  assert.equal(await page.$eval('.tw-launch-screen', el => el.dataset.stage), 'form');
  await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled === false);
  assert.equal(await page.evaluate(() => window.originalField === document.querySelector('#server-origin')), true);
  assert.equal(await page.$eval('#server-origin', el => el.value), 'http://127.0.0.1:49999');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'server-origin');
  console.log('Failed connection retry retains the form, entered address, and keyboard focus.');
  await page.goto(`${base}/?fixtures=ok`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.torwatch-app-shell');
  assert.equal(await page.$('.tw-launch-screen'), null);
  console.log('Saved connection enters the app without showing the connect form.');
  await page.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
