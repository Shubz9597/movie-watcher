// Mobile-shell design captures: the REAL mobile entry (dist-mobile) driven as
// an iPhone-class touch device with notch/home-indicator safe areas.
// Run after build:mobile. Fixture data only; no server or device needed.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-mobile');
const out = path.resolve(root, '../docs/ui-design-evidence', process.argv[2] || 'mobile-1');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${dist}${path.sep}`)) throw new Error('outside dist');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/index.html?fixtures=1&showcase=1&library=populated`;
const base = `${origin}&downloads=items`;
// `--only downloads` captures every Downloads state instead of the tour.
const onlyDownloads = process.argv.includes('--only') && process.argv[process.argv.indexOf('--only') + 1] === 'downloads';

// iPhone 14-class viewport with notch/home-indicator insets. Chrome's
// safe-area override drives env(safe-area-inset-*) itself; older Chrome
// falls back to pinning the shell's safe-area variables.
const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };
const SAFE_AREAS = `:root{--app-safe-top:${INSETS.top}px!important;--app-safe-bottom:${INSETS.bottom}px!important}`;
let nativeInsets = false;
const browser = await puppeteer.launch({ headless: true });
const report = { screenshots: [], runtimeErrors: [] };

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter(img => img.loading !== 'lazy').map(img => img.decode().catch(() => {})));
  });
  await new Promise(resolve => setTimeout(resolve, 700));
}
async function capture(page, name) {
  await settle(page);
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  report.screenshots.push({ name, ...layout });
  if (layout.scrollWidth > layout.width) throw new Error(`Horizontal overflow on ${name}: ${JSON.stringify(layout)}`);
}
async function open(page, hash, selector, url = base) {
  // A full load per screen: tab roots restore their earlier scroll position
  // within one session, which would leak between captures.
  await page.goto('about:blank');
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* blank page */ } });
  await page.goto(`${url}${hash}`, { waitUntil: 'networkidle2' });
  if (!nativeInsets) await page.addStyleTag({ content: SAFE_AREAS });
  await page.waitForSelector(selector, { timeout: 15000 });
  // A hash-only navigation keeps the previous screen's scroll position.
  await page.evaluate(() => window.scrollTo(0, 0));
}

try {
  const page = await browser.newPage();
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  });
  page.on('pageerror', error => report.runtimeErrors.push(error.message));
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: INSETS });
    nativeInsets = true;
  } catch { /* unsupported: CSS-variable fallback */ }
  report.safeAreaEmulation = nativeInsets ? 'chrome-override' : 'css-variables';

  if (onlyDownloads) {
    await open(page, '#downloads', 'main h1');
    await capture(page, 'downloads');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await capture(page, 'downloads-end');
    await open(page, '#downloads-series?series=tmdb%3Atv%3A1396', 'main h1');
    await capture(page, 'downloads-series');
    await open(page, '#downloads', 'main h1');
    await page.evaluate(() => [...document.querySelectorAll('main button')].find(button => button.textContent.trim() === 'Select')?.click());
    await capture(page, 'downloads-select');
    await open(page, '#downloads', 'main h1', `${origin}&downloads=empty`);
    await capture(page, 'downloads-empty');
    await open(page, '#downloads', 'main h1', `${origin}&downloads=storage-error`);
    await capture(page, 'downloads-error');
    await writeFile(path.join(out, 'checks.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.runtimeErrors.length) process.exitCode = 1;
  } else {
  await open(page, '', '.featured-copy h1');
  await capture(page, 'home');
  await page.evaluate(() => window.scrollTo(0, document.querySelector('.catalog-shelf').getBoundingClientRect().top + scrollY - 60));
  await capture(page, 'shelves');
  await open(page, '#title?kind=movie&id=693134', '.title-page h1');
  await capture(page, 'title-movie');
  await page.evaluate(() => document.querySelector('[data-source-panel]')?.scrollIntoView({ block: 'start' }));
  await capture(page, 'title-movie-sources');
  await open(page, '#title?kind=tv&id=1396', '.title-page h1');
  await capture(page, 'title-series');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
  await capture(page, 'title-series-episodes');
  await open(page, '#library', '[role="tabpanel"]');
  await capture(page, 'library');
  await open(page, '#search', 'input[type="search"]');
  await page.type('input[type="search"]', 'Dune');
  await page.waitForSelector('.search-result-grid .poster-card');
  await capture(page, 'search');
  await open(page, '#downloads', 'main');
  await capture(page, 'downloads');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('torwatch:open-settings')));
  await capture(page, 'settings');
  await writeFile(path.join(out, 'checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.runtimeErrors.length) process.exitCode = 1;
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
