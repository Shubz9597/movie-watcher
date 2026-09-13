// Shared-web checks with simulated phone insets/keyboard height. Native
// AVPlayer presentation and real WKWebView keyboard behavior need an iPhone.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(app, 'dist-mobile');
const out = path.join(app, 'node_modules/.mobile-polish-check');
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  for (const [name, width, height] of [['phone', 390, 844], ['narrow', 320, 740], ['desktop', 1280, 900]]) {
    const page = await browser.newPage();
    const closePlayer = async () => {
      const nativeWebClose = '[role="dialog"][aria-label^="Playing "] [aria-label="Close player"]';
      await page.click(await page.$(nativeWebClose) ? nativeWebClose : '.player-transition [aria-label="Close player"]');
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width, height, isMobile: width < 1024, hasTouch: width < 1024 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?fixtures=ok&recs=seeded&library=populated`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[aria-label="See all Movies – Trending"]');
    await page.addStyleTag({ content: `:root { --app-safe-top:${width < 1024 ? 62 : 0}px; --app-safe-bottom:${width < 1024 ? 34 : 0}px; }` });
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/episodes')) return new Response('{}', { status: 503 });
        if (url.includes('/v1/torrents/search')) return Response.json({ results: [{
          title: 'Frieren S01E01 1080p HEVC', indexer: 'Test source', size: 1200000000, seeders: 42,
          magnetUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), infoHash: 'a'.repeat(40),
        }] });
        const response = await original(input, init);
        if (url.includes('/v2/catalog/search')) {
          const body = await response.json();
          body.results = Array.from({ length: 30 }, (_, i) => ({ ...body.results[0], id: `tmdb:movie:${10000 + i}`, providerIds: { tmdb: `movie:${10000 + i}` }, type: 'movie', title: `Movie result ${i + 1}` }));
          return Response.json(body);
        }
        return response;
      };
      location.hash = '#title?kind=anime&id=154587';
    });
    await page.waitForSelector('button[aria-label="Episode 28"]');
    assert.equal(await page.$$eval('button[aria-label^="Episode "]', rows => rows.length), 28, 'known anime count survives metadata failure');
    const actionBox = await page.$eval('[aria-label="Title actions"]', el => ({ right: el.getBoundingClientRect().right, left: el.getBoundingClientRect().left }));
    if (width < 1024) assert.ok(actionBox.right >= width - 32 && actionBox.right <= width, 'title actions align right');
    await page.screenshot({ path: path.join(out, `${name}-title.png`) });
    await page.$eval('button[aria-label="Episode 1"]', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.screenshot({ path: path.join(out, `${name}-episodes.png`) });
    await page.click('button[aria-label="Episode 1"]');
    await page.waitForSelector('button[aria-label^="Play source "]');
    if (width < 1024) {
      await page.$eval('button[aria-label^="Play source "]', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const play = await page.$eval('button[aria-label^="Play source "]', el => {
        const a = el.getBoundingClientRect(), b = el.nextElementSibling.getBoundingClientRect();
        return { width: a.width, height: a.height, left: a.right <= b.left };
      });
      assert.ok(play.width >= 48 && play.height >= 48 && play.left, 'direct Play is left of the source and tappable');
      await page.screenshot({ path: path.join(out, `${name}-source.png`) });
      await page.click('button[aria-label^="Play source "]');
      await page.waitForSelector('.player-transition');
      assert.equal(await page.$('[aria-label="Main destinations"]'), null, 'player has no application footer');
      assert.equal(await page.$('.torwatch-app-shell'), null, 'player is outside app chrome');
      await page.screenshot({ path: path.join(out, `${name}-player.png`) });
      await closePlayer();
      await page.waitForFunction(() => location.hash.startsWith('#title?'));
      await page.evaluate(() => { location.hash = '#title?kind=movie&id=693134'; });
      await page.waitForFunction(() => document.querySelector('h1')?.textContent.includes('Dune'));
      await page.waitForSelector('button[aria-label^="Play source "]');
      await page.$eval('button[aria-label^="Play source "]', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: path.join(out, `${name}-movie-source.png`) });
      await page.click('button[aria-label^="Play source "]');
      await page.waitForSelector('.player-transition');
      assert.equal(await page.$('.torwatch-app-shell'), null, 'movie Play enters fullscreen directly');
      await closePlayer();
      await page.waitForFunction(() => location.hash.startsWith('#title?'));
    }
    await page.evaluate(() => { location.hash = '#search'; });
    await page.waitForSelector('input[aria-label="Search titles"]');
    await page.type('input[aria-label="Search titles"]', 'movie');
    await page.waitForFunction(() => document.querySelector('[aria-label="Search results"]').textContent.includes('Movie result'));
    const checkScroll = async () => {
      const result = await page.evaluate(async () => {
        const pane = document.querySelector('[aria-label="Search results"]');
        const footer = document.querySelector('[aria-label="Main destinations"]');
        const input = document.querySelector('input[aria-label="Search titles"]');
        const before = { footer: footer.getBoundingClientRect().top, input: input.getBoundingClientRect().top };
        pane.scrollTop = pane.scrollHeight;
        await new Promise(requestAnimationFrame);
        return { before, after: { footer: footer.getBoundingClientRect().top, input: input.getBoundingClientRect().top }, paneScroll: pane.scrollTop, paneHeight: pane.clientHeight, footerBottom: footer.getBoundingClientRect().bottom, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(result.before, result.after, 'results scroll without moving input/footer');
      assert.ok(result.paneScroll > 0 && result.paneHeight > 50, 'results have a usable internal scroller');
      assert.equal(result.overflow, false, 'no horizontal overflow');
      if (width < 1024) assert.ok(result.footerBottom <= (await page.evaluate(() => visualViewport.height)) + 1, 'footer stays inside visible viewport');
    };
    await checkScroll();
    await page.screenshot({ path: path.join(out, `${name}-search.png`) });
    if (name === 'phone') {
      await page.setViewport({ width, height: 460, isMobile: true, hasTouch: true });
      await page.waitForFunction(() => document.querySelector('.search-frame').getBoundingClientRect().height <= 460);
      await checkScroll();
      await page.screenshot({ path: path.join(out, 'phone-keyboard-height.png') });
    }
    assert.deepEqual(errors, [], `${name}: no uncaught UI errors`);
    console.log(`PASS ${name}: anime fallback, source playback, fixed search frame`);
    await page.close();
  }
  console.log(`Screenshots: ${out}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
