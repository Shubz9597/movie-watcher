// M2.5 visual-QA matrix (docs/mobile-ui/visual-qa.md, bounded browser pass).
// Captures the REAL built dist-browser app across the browser viewport
// matrix and stress states, exercises carousel/library/sheet interactions,
// and writes results + a capture index for the report. Captures land in
// specs/002-mobile-shared-ui/evidence/captures/m25/.
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(appRoot, 'dist-browser');
const outDir = path.resolve(appRoot, '../specs/002-mobile-shared-ui/evidence/captures/m25');
const STATIC_PORT = 4195;
const base = `http://127.0.0.1:${STATIC_PORT}/browser.html`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const VIEWPORTS = {
  '320x568': { width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  '375x667': { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  '390x844': { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  '430x932': { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  '360x800': { width: 360, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  '844x390': { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  '768x1024': { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  '1440x900': { width: 1440, height: 900, deviceScaleFactor: 1 },
};

function serveStatic(port) {
  const server = http.createServer((req, res) => {
    let filePath = path.join(distDir, decodeURIComponent(req.url.split('?')[0]));
    if (!existsSync(filePath)) filePath = path.join(distDir, 'browser.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const index = [];
const failures = [];

async function newPage(browser, viewport, { reducedMotion = false, textScale = 1 } = {}) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument((scale) => {
    window.localStorage.setItem('mw_catalog_source', 'bff');
    window.localStorage.setItem('mw_device_id', '11111111-2222-4333-8444-555555555555');
    if (scale !== 1) {
      const apply = () => { document.documentElement.style.fontSize = `${scale * 100}%`; };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
      else apply();
    }
  }, textScale);
  return page;
}

async function shoot(browser, name, url, viewport, opts = {}) {
  const page = await newPage(browser, viewport, opts);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    if (opts.before) await opts.before(page);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    index.push({ name, viewport, url: url.replace(base, ''), file });
    console.log(`captured ${name}`);
  } catch (error) {
    failures.push({ name, error: String(error).slice(0, 200) });
    console.log(`FAILED ${name}: ${String(error).slice(0, 200)}`);
  } finally {
    await page.close();
  }
}

function clickVisible(page, selector) {
  return page.evaluate((sel) => {
    const elements = Array.from(document.querySelectorAll(sel));
    elements.find((e) => e.offsetParent !== null)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, selector);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const server = await serveStatic(STATIC_PORT);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  try {
    // Viewport matrix: Home at every width (primary phone sizes + stress).
    for (const viewport of Object.keys(VIEWPORTS)) {
      await shoot(browser, `home-${viewport.replace('x', 'x')}`, `${base}?fixtures=1`, viewport);
    }

    // Library + title at key widths.
    for (const viewport of ['320x568', '390x844', '768x1024', '1440x900']) {
      await shoot(browser, `library-${viewport}`, `${base}?fixtures=1#/library`, viewport);
      await shoot(browser, `title-${viewport}`, `${base}?fixtures=1#title?kind=movie&id=693134`, viewport);
    }

    // Open sheet at small + desktop widths (WF02a).
    for (const viewport of ['320x568', '390x844', '1440x900']) {
      await shoot(browser, `search-sheet-${viewport}`, `${base}?fixtures=1`, viewport, {
        before: async (page) => {
          await page.waitForSelector('[aria-label="Search titles"]', { timeout: 30000 });
          await clickVisible(page, '[aria-label="Search titles"]');
          await page.waitForSelector('[aria-label="Search movies, series, and anime"]', { timeout: 20000 });
          await page.type('[aria-label="Search movies, series, and anime"]', 'dune', { delay: 25 });
          await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim().startsWith('Filters')), { timeout: 20000 }).catch(() => undefined);
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const opener = buttons.find((b) => b.textContent?.trim().startsWith('Filters'));
            if (opener && opener.offsetParent !== null) { opener.focus(); opener.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
          });
          await page.waitForSelector('[role="dialog"][aria-label="Filter results"]', { timeout: 15000 }).catch(() => undefined);
        },
      });
    }

    // 200% text scale: home + library + title (stress readability).
    for (const name of ['home', 'library', 'title']) {
      const url = name === 'home' ? `${base}?fixtures=1` : `${base}?fixtures=1#/${name === 'title' ? 'title?kind=movie&id=693134' : 'library'}`;
      await shoot(browser, `text200-${name}-390x844`, url, '390x844', { textScale: 2 });
    }

    // Reduced motion: home + open sheet.
    await shoot(browser, 'reduced-motion-home-390x844', `${base}?fixtures=1`, '390x844', { reducedMotion: true });
    await shoot(browser, 'reduced-motion-sheet-390x844', `${base}?fixtures=1`, '390x844', {
      reducedMotion: true,
      before: async (page) => {
        await page.waitForSelector('[aria-label="Search titles"]', { timeout: 30000 });
        await clickVisible(page, '[aria-label="Search titles"]');
        await page.waitForSelector('[aria-label="Search movies, series, and anime"]', { timeout: 20000 });
        await page.type('[aria-label="Search movies, series, and anime"]', 'dune', { delay: 25 });
        await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim().startsWith('Filters')), { timeout: 20000 }).catch(() => undefined);
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const opener = buttons.find((b) => b.textContent?.trim().startsWith('Filters'));
          if (opener) { opener.focus(); opener.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
        });
        await page.waitForSelector('[role="dialog"][aria-label="Filter results"]', { timeout: 15000 }).catch(() => undefined);
      },
    });

    // Long content: 100-title library category (missing artwork is the
    // fixture default for the stress provider — text-only grid).
    await shoot(browser, 'stress100-library-category-390x844', `${base}?fixtures=1&stress=100#/library-category?collection=watch-later&kind=movie`, '390x844', {
      before: async (page) => {
        await page.waitForSelector('button[aria-label^="Open Stress"]', { timeout: 30000 });
        await page.evaluate(() => { for (let i = 0; i < 12; i += 1) { window.scrollBy(0, 600); } });
      },
    });

    // Carousel first/middle/end positions (WF01).
    for (const [name, ratio] of [['start', 0], ['middle', 0.5], ['end', 1]]) {
      await shoot(browser, `carousel-${name}-390x844`, `${base}?fixtures=1`, '390x844', {
        before: async (page) => {
          await page.waitForSelector('[aria-label="Continue watching"]', { timeout: 30000 }).catch(() => undefined);
          await page.evaluate((r) => {
            const scroller = document.querySelector('.snap-x');
            if (!scroller) return;
            scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) * r;
          }, ratio);
          await page.evaluate(() => document.querySelector('.snap-x')?.scrollIntoView({ block: 'center' }));
        },
      });
    }

    // Swipe-versus-tap: a drag release over artwork must NOT resume; a plain
    // artwork tap shows the truthful resume notice. Functional assertions.
    {
      const page = await newPage(browser, '390x844');
      await page.goto(`${base}?fixtures=1`, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('[aria-label^="Resume"]', { timeout: 30000 });
      const resumeButton = '[aria-label^="Resume"]';
      const box = await (await page.$(resumeButton)).boundingBox();
      // Drag across the artwork (pointer down/move/up), release ON the button.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) await page.mouse.move(box.x + box.width / 2 - i * 30, box.y + box.height / 2);
      await page.mouse.up();
      await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
      const afterDrag = await page.evaluate(() => ({
        noticeShown: document.body.innerText.includes('arrives with the mobile player'),
        hash: window.location.hash,
      }));
      // Plain tap: must show the truthful resume notice (no navigation).
      await page.evaluate((sel) => {
        document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, resumeButton);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
      const afterTap = await page.evaluate(() => ({
        noticeShown: document.body.innerText.includes('arrives with the mobile player'),
        hash: window.location.hash,
      }));
      const swipeOk = !afterDrag.noticeShown && afterDrag.hash === '';
      const tapOk = afterTap.noticeShown && afterTap.hash === '';
      console.log(`[interaction] swipe-vs-tap: drag-no-play=${swipeOk} tap-resume-intent=${tapOk}`);
      index.push({ name: 'interaction-swipe-vs-tap', result: { swipeOk, tapOk, afterDrag, afterTap } });
      if (!swipeOk || !tapOk) failures.push({ name: 'swipe-vs-tap', error: `drag=${swipeOk} tap=${tapOk}` });
      await page.close();
    }

    // Library back restoration: shelf -> View all -> back restores tab+scroll.
    // (Wait for the CATEGORY heading — the shelf previews' "Open Stress…"
    // labels also exist on the library page and would race.)
    {
      const page = await newPage(browser, '390x844');
      await page.goto(`${base}?fixtures=1&stress=100#/library?collection=watch-later`, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('[aria-label="Movies shelf"]', { timeout: 30000 });
      await page.evaluate(() => {
        const shelf = document.querySelector('[aria-label="Movies shelf"]');
        shelf?.scrollIntoView();
        shelf?.querySelector('button[aria-label^="View all"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForFunction(() => document.body.innerText.includes('Watch Later — Movies'), { timeout: 15000 });
      await page.evaluate(() => window.scrollBy(0, 900));
      const beforeBack = await page.evaluate(() => ({ hash: window.location.hash, scrollY: Math.round(window.scrollY) }));
      await page.evaluate(() => {
        const back = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '← Library');
        back?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('[aria-label="Movies shelf"]', { timeout: 30000 });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
      const afterBack = await page.evaluate(() => ({
        hash: window.location.hash,
        scrollY: Math.round(window.scrollY),
        maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        tabWatchLater: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
      }));
      // The Library page is shorter than the grid: a correct restore is the
      // saved position clamped to the page's actual max scroll.
      const restored = beforeBack.hash.includes('collection=watch-later')
        && afterBack.hash.includes('collection=watch-later')
        && afterBack.maxScroll > 0
        && afterBack.scrollY >= Math.min(beforeBack.scrollY, afterBack.maxScroll) - 5
        && afterBack.tabWatchLater === 'Watch Later';
      console.log(`[interaction] library back restoration: ${restored ? 'PASS' : 'FAIL'} ${JSON.stringify({ beforeBack, afterBack })}`);
      index.push({ name: 'interaction-library-back', result: { restored, beforeBack, afterBack } });
      if (!restored) failures.push({ name: 'library-back-restoration', error: 'scroll/tab not restored' });
      await page.close();
    }

    // Simulated keyboard occlusion (NOT a native software keyboard): focus
    // the search input at phone size; the viewport does not resize because
    // no IME is present — captured and labelled as simulated only.
    await shoot(browser, 'simulated-keyboard-focus-search-390x844', `${base}?fixtures=1`, '390x844', {
      before: async (page) => {
        await page.waitForSelector('[aria-label="Search titles"]', { timeout: 30000 });
        await clickVisible(page, '[aria-label="Search titles"]');
        await page.waitForSelector('[aria-label="Search movies, series, and anime"]', { timeout: 20000 });
        await page.focus('[aria-label="Search movies, series, and anime"]');
        await page.type('[aria-label="Search movies, series, and anime"]', 'dune', { delay: 30 });
      },
    });
    index.push({ name: 'note-simulated-keyboard', result: 'Captured with an focused input at phone size; no native software keyboard is present in headless Chromium. Native IME occlusion is verified only on devices (M5/M6).' });
  } finally {
    await browser.close();
    server.close();
  }

  writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ index, failures }, null, 2));
  console.log(`\nDONE: ${index.length} entries, ${failures.length} failures`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

