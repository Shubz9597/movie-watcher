// Shared-web UI verification only. Insets are simulated; native WebKit's
// interactive swipe and real device safe areas still need an iPhone run.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(app, 'dist-mobile');
const out = path.join(app, 'node_modules/.mobile-navigation-check');
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
const base = `http://127.0.0.1:${server.address().port}/?fixtures=ok&recs=seeded&library=populated`;
let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  for (const [name, width, height, top, bottom, side] of [
    ['phone', 390, 844, 62, 34, 0],
    ['narrow', 320, 740, 62, 34, 0],
    ['landscape', 844, 390, 0, 21, 59],
    ['desktop', 1280, 900, 0, 0, 0],
  ]) {
    const page = await browser.newPage();
    const click = async selector => {
      await page.$eval(selector, el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
      await page.waitForFunction(selector => {
        const el = document.querySelector(selector);
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }, {}, selector);
      await page.click(selector);
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width, height, isMobile: width < 1024, hasTouch: width < 1024 });
    await page.evaluateOnNewDocument(() => { window.requestIdleCallback = undefined; });
    await page.goto(base, { waitUntil: 'networkidle2' });
    await page.addStyleTag({ content: `:root { --app-safe-top:${top}px; --app-safe-bottom:${bottom}px; --app-safe-left:${side}px; --app-safe-right:${side}px; }` });
    await page.waitForSelector('[aria-label="See all Movies – Trending"]');
    const layout = await page.evaluate(() => {
      const header = document.querySelector('.torwatch-app-shell > header');
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        pills: !!document.querySelector('[aria-label="Browse categories"]'),
        headerTop: header.querySelector('button').getBoundingClientRect().top,
        actions: [...document.querySelectorAll('.shelf-see-all')].map(button => {
          const box = button.getBoundingClientRect();
          const heading = button.previousElementSibling.getBoundingClientRect();
          return { nowrap: getComputedStyle(button).whiteSpace === 'nowrap', clear: box.left >= heading.right, fits: box.right <= innerWidth, height: box.height };
        }),
      };
    });
    assert.equal(layout.overflow, false, `${name}: no horizontal document overflow`);
    assert.equal(layout.pills, false, `${name}: Home category pills removed`);
    assert.ok(layout.actions.length >= 4, `${name}: recommendations and all trending rows have actions`);
    assert.ok(layout.actions.every(action => action.nowrap && action.clear && action.fits && action.height >= 48), `${name}: shelf actions are readable, separate, and tappable`);
    if (width < 1024) assert.ok(layout.headerTop >= top, `${name}: header clears simulated safe area`);
    await page.screenshot({ path: path.join(out, `${name}-home.png`) });
    await page.$eval('.shelf-heading', el => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(out, `${name}-shelves.png`) });
    await page.$eval('[aria-label="See all Movies – Trending"]', el => el.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.screenshot({ path: path.join(out, `${name}-trending.png`) });

    if (name === 'phone') {
      await click('[aria-label="See all Movies – Trending"]');
      await page.waitForFunction(() => location.hash.startsWith('#see-all?'));
      const collection = await page.evaluate(() => location.hash);
      await page.waitForSelector('.content-auto-card button');
      await click('.content-auto-card button');
      await page.waitForFunction(() => location.hash.startsWith('#title?'));
      await page.waitForSelector('.torwatch-app-shell > header [aria-label="Go back"]');
      await page.waitForSelector('[aria-label="Available torrent sources"]');
      await page.screenshot({ path: path.join(out, 'phone-title.png') });
      await page.click('.torwatch-app-shell > header [aria-label="Go back"]');
      await page.waitForFunction(expected => location.hash === expected, {}, collection);
      await page.click('nav[aria-label="Main destinations"] [aria-label="Go back"]');
      await page.waitForFunction(() => location.hash === '#home' || location.hash === '');

      await page.click('[aria-label="Open settings"]');
      await page.waitForSelector('[role="dialog"][aria-label="Server settings"]');
      const underlying = await page.evaluate(() => location.hash);
      await page.evaluate(() => history.back());
      await page.waitForSelector('[role="dialog"][aria-label="Server settings"]', { hidden: true });
      assert.equal(await page.evaluate(() => location.hash), underlying);
      await page.evaluate(() => history.forward());
      await page.waitForSelector('[role="dialog"][aria-label="Server settings"]');
      await page.click('[role="dialog"][aria-label="Server settings"] [aria-label="Go back"]');
      await page.waitForSelector('[role="dialog"][aria-label="Server settings"]', { hidden: true });

      await page.click('.torwatch-app-shell > header [aria-label="Search titles"]');
      await page.waitForSelector('[role="dialog"] input');
      await page.evaluate(() => history.back());
      await page.waitForSelector('[role="dialog"]', { hidden: true });
      await page.evaluate(() => history.forward());
      await page.waitForSelector('[role="dialog"] input');
      await page.screenshot({ path: path.join(out, 'phone-search.png') });
      await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [cmdk-item]')].find(el => el.textContent.includes('All movies')).click());
      await page.waitForFunction(() => location.hash.startsWith('#see-all?'));
      await page.waitForSelector('[role="dialog"]', { hidden: true });
      await page.evaluate(() => history.back());
      await page.waitForFunction(() => location.hash === '#home' || location.hash === '');
      assert.equal(await page.$('[role="dialog"]'), null, 'Back from search result returns directly to its page');

      await page.goto(base + '#title?kind=movie&id=693134', { waitUntil: 'networkidle2' });
      await page.click('.torwatch-app-shell > header [aria-label="Go back"]');
      await page.waitForFunction(() => location.hash === '#home');
      console.log('PASS nested Back buttons, Settings/Search history, search selection, and direct-link fallback');
    }
    assert.deepEqual(errors, [], `${name}: no uncaught UI errors`);
    console.log(`PASS ${name}: layout, safe-area spacing, and See all actions`);
    await page.close();
  }
  console.log(`Shared-web screenshots: ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
