// Screens for a design review round: the production React app with showcase
// fixture data (no server needed). Run after build:browser.
//   node scripts/capture-review.mjs <round-name>
// Writes PNGs to docs/ui-design-evidence/<round-name>/.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-browser');
const out = path.resolve(root, '../docs/ui-design-evidence', process.argv[2] || 'review');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(dist, `.${pathname}`);
    if (!file.startsWith(`${dist}${path.sep}`)) throw new Error('outside dist');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/browser.html?fixtures=1&showcase=1&library=populated&downloads=items`;
// GPU raster in headless Chromium at 2x painted page content over the fixed
// tab bar in screenshots (hit-testing was correct); software raster is exact.
const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--disable-gpu-compositing'] });
const sizes = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter((img) => img.loading !== 'lazy').map((img) => img.decode().catch(() => {})));
  });
  await wait(900);
}
const shots = [];
async function shot(page, name) {
  await settle(page);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, captureBeyondViewport: false });
  shots.push(file);
}
async function open(page, hash, selector) {
  // A fresh document per screen: reusing a scrolled one left stale paint
  // over the fixed tab bar in later screenshots.
  await page.goto('about:blank');
  await page.goto(`${base}${hash}`, { waitUntil: 'networkidle2' });
  if (selector) await page.waitForSelector(selector, { timeout: 15000 });
}
async function scrollTo(page, selector, offset = 0) {
  await page.evaluate((sel, off) => {
    const element = document.querySelector(sel);
    if (element) window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' });
  }, selector, offset);
}
try {
  for (const [device, viewport] of Object.entries(sizes)) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    // Downloads keep each episode's title and still on the device; the
    // preview seeds what the phone would have saved.
    await page.evaluateOnNewDocument(() => {
      const still = 'https://images.metahub.space/background/medium/tt0903747/img';
      localStorage.setItem('torwatch_download_meta_v1', JSON.stringify({
        'fixture-download-2': { episodeTitle: 'Cancer Man', still },
        'fixture-download-5': { episodeTitle: 'Gray Matter', still },
        'fixture-download-3': { episodeTitle: 'The Celestial Realm', still: 'https://images.metahub.space/background/medium/tt22248376/img' },
      }));
    });
    await open(page, '', '.featured-copy h1');
    await shot(page, `${device}-01-home`);
    await scrollTo(page, '.catalog-shelf', 80);
    await shot(page, `${device}-02-home-shelves`);
    await open(page, '#title?kind=movie&id=693134', '.title-page h1');
    await shot(page, `${device}-03-title-movie`);
    await open(page, '#title?kind=tv&id=1396', '.title-page h1');
    await shot(page, `${device}-04-title-series`);
    await page.waitForFunction(() => document.body.innerText.includes('Pilot'), { timeout: 15000 }).catch(() => {});
    await scrollTo(page, '.content-auto-row', device === 'phone' ? 170 : 250);
    await shot(page, `${device}-05-episodes`);
    if (device === 'phone') {
      await open(page, '#library', '[role="tabpanel"]');
      await shot(page, `${device}-06-library`);
      await open(page, '#search', 'input[type="search"]');
      await page.type('input[type="search"]', 'Dune');
      await page.waitForSelector('.search-result-grid .poster-card', { timeout: 15000 });
      await shot(page, `${device}-07-search`);
      await open(page, '#downloads');
      await page.waitForFunction(() => document.body.innerText.includes('Breaking Bad'), { timeout: 15000 });
      await shot(page, `${device}-08-downloads`);
      await open(page, '#downloads-series?series=tmdb%3Atv%3A1396');
      await page.waitForFunction(() => document.body.innerText.includes('Breaking Bad'), { timeout: 15000 });
      await shot(page, `${device}-09-downloads-series`);
    }
    await page.close();
  }
  console.log(shots.join('\n'));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
