// Actual production React renders with explicit, deterministic preview data.
// Run after build:browser. No live server, credentials, or saved data needed.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-browser');
const out = path.resolve(root, '../docs/ui-design-evidence', process.argv[2] || 'round-1');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' };
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/browser.html?fixtures=1&showcase=1&library=populated`;
const browser = await puppeteer.launch({ headless: true });
const report = { fixtureData: true, screenshots: [], checks: [] };
const sizes = { desktop: { width: 1440, height: 1100 }, phone: { width: 390, height: 844, isMobile: true, hasTouch: true } };
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter(img => {
      const r = img.getBoundingClientRect();
      const clip = img.closest('.carousel-rail, .continue-carousel')?.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < Math.min(innerWidth, clip?.right ?? innerWidth) && r.right > Math.max(0, clip?.left ?? 0);
    }).map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await new Promise(resolve => setTimeout(resolve, 700));
}
async function capture(page, name) {
  await settle(page);
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    brokenVisibleImages: [...document.images].filter(img => {
      const r = img.getBoundingClientRect();
      const clip = img.closest('.carousel-rail, .continue-carousel')?.getBoundingClientRect();
      return (!img.complete || !img.naturalWidth) && r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < Math.min(innerWidth, clip?.right ?? innerWidth) && r.right > Math.max(0, clip?.left ?? 0);
    }).map(img => img.src),
  }));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  report.screenshots.push({ name, ...layout });
  if (layout.scrollWidth > layout.width || layout.brokenVisibleImages.length) throw new Error(`Invalid screenshot ${name}: ${JSON.stringify(layout)}`);
}
try {
  for (const [device, viewport] of Object.entries(sizes)) {
    const page = await browser.newPage();
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.featured-copy h1');
    await capture(page, `home-${device}`);
    await page.evaluate(() => {
      const shelf = document.querySelector('.catalog-shelf');
      const header = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 0;
      window.scrollTo(0, shelf.getBoundingClientRect().top + scrollY - header - 20);
    });
    await capture(page, `shelves-${device}`);
    await page.goto(`${base}#see-all?title=Trending%20movies&api=tmdb%3Atrending%3Amovie&kind=movie`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.poster-card');
    await capture(page, `browse-${device}`);
    await page.goto(`${base}#title?kind=movie&id=693134`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.title-page h1');
    await capture(page, `title-${device}`);
    await page.click('.source-details-toggle');
    await page.waitForSelector('[id^="source-details-"] dd');
    const fullReleaseName = await page.$eval('[id^="source-details-"] dd', el => el.textContent);
    if (!fullReleaseName.includes('GROUPNAMEWITHLONGTAGS')) throw new Error('Full release name unavailable');
    report.checks.push({ device, sourceDetailsDisclosure: true });
    await page.click('.source-details-toggle');
    await page.goto(`${base}#library`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[role="tabpanel"]');
    await capture(page, `library-${device}`);
    report.checks.push({ device, runtimeErrors: errors });
    if (errors.length) throw new Error(errors.join('\n'));
    if (device === 'phone') {
      await page.click('nav[aria-label="Main destinations"] button:nth-child(3)');
      await page.waitForSelector('input[type="search"]');
      await page.type('input[type="search"]', 'Dune');
      await page.waitForSelector('.search-result-grid .poster-card');
      await capture(page, 'search-phone');
      await page.click('.search-result-grid .poster-card');
      await page.waitForSelector('.title-page h1');
      report.checks.push({ mobileSearchToTitle: true });
    }
    await page.close();
  }
  // A narrow phone, tablet, and laptop are also checked for horizontal overflow.
  for (const width of [320, 768, 1024, 1920]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    for (const route of ['', '#title?kind=movie&id=693134', '#title?kind=tv&id=1396', '#library', '#see-all?title=Trending%20movies&api=tmdb%3Atrending%3Amovie&kind=movie']) {
      await page.goto(`${base}${route}`, { waitUntil: 'networkidle2' });
      await settle(page);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      report.checks.push({ width, route: route || 'home', scrollWidth });
      if (scrollWidth > width) throw new Error(`Horizontal overflow at ${width} on ${route}`);
    }
    await page.close();
  }
  await writeFile(path.join(out, 'checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
