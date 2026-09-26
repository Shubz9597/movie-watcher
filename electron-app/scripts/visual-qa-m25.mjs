// M2.5 visual-QA matrix (docs/mobile-ui/visual-qa.md, bounded browser pass).
// Captures the REAL built dist-browser app across the browser viewport
// matrix and stress states, exercises carousel/search interactions, and
// writes results + a capture index for the report.
// UPDATED for the M1.4 shell redesign: the search trigger NAVIGATES to the
// `search` route (SearchPage); the GlobalSearch modal is desktop-only.
// The library back-restoration interaction was SUPERSEDED — LibraryPage now
// renders through the M3 library store and is covered by that work stream.
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
      await shoot(browser, `home-${viewport}`, `${base}?fixtures=1`, viewport);
    }

    // Library + title at key widths.
    for (const viewport of ['320x568', '390x844', '768x1024', '1440x900']) {
      await shoot(browser, `library-${viewport}`, `${base}?fixtures=1#/library`, viewport);
      await shoot(browser, `title-${viewport}`, `${base}?fixtures=1#title?kind=movie&id=693134`, viewport);
    }

    // Search page (M1.4 shell redesign: the search trigger NAVIGATES to the
    // search route — the old modal is desktop-only now). Captures the page
    // with recents + the progressive results state while typing.
    for (const viewport of ['320x568', '390x844', '1440x900']) {
      await shoot(browser, `search-sheet-${viewport}`, `${base}?fixtures=1#search`, viewport, {
        before: async (page) => {
          await page.waitForSelector('.search-page input', { timeout: 30000 });
          await page.type('.search-page input', 'dune', { delay: 25 });
          await page.waitForFunction(() => document.querySelectorAll('.search-result-grid > li').length > 0, { timeout: 20000 }).catch(() => undefined);
        },
      });
    }

    // 200% text scale: home + library + title (stress readability).
    for (const name of ['home', 'library', 'title']) {
      const url = name === 'home' ? `${base}?fixtures=1` : `${base}?fixtures=1#/${name === 'title' ? 'title?kind=movie&id=693134' : 'library'}`;
      await shoot(browser, `text200-${name}-390x844`, url, '390x844', { textScale: 2 });
    }

    // Reduced motion: home + search route.
    await shoot(browser, 'reduced-motion-home-390x844', `${base}?fixtures=1`, '390x844', { reducedMotion: true });
    await shoot(browser, 'reduced-motion-search-390x844', `${base}?fixtures=1#search`, '390x844', {
      reducedMotion: true,
      before: async (page) => {
        await page.waitForSelector('.search-page input', { timeout: 30000 });
        await page.type('.search-page input', 'dune', { delay: 25 });
        await page.waitForFunction(() => document.querySelectorAll('.search-result-grid > li').length > 0, { timeout: 20000 }).catch(() => undefined);
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
    // artwork tap opens the title page WITH resume context (the browser has
    // no native player — real playback stays behind M1.3). Functional checks.
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
      const afterDrag = await page.evaluate(() => ({ hash: window.location.hash }));
      // Plain tap: real pointer sequence (down→up) like a user's tap — it
      // navigates to the title page WITH the resume context. (A synthetic
      // click without a pointerdown would trip the carousel's stale-gesture
      // suppression, which exists to protect drag-release-on-artwork.)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForFunction(() => window.location.hash.includes('title?'), { timeout: 15000 }).catch(() => undefined);
      const afterTap = await page.evaluate(() => ({
        hash: window.location.hash,
        hasResumeContext: window.location.hash.includes('resumeSubjectId='),
      }));
      const swipeOk = !afterDrag.hash && !afterDrag.hash.includes('title');
      const tapOk = afterTap.hash.includes('title?') && afterTap.hasResumeContext;
      console.log(`[interaction] swipe-vs-tap: drag-no-play=${swipeOk} tap-resume-context=${tapOk}`);
      index.push({ name: 'interaction-swipe-vs-tap', result: { swipeOk, tapOk, afterDrag, afterTap } });
      if (!swipeOk || !tapOk) failures.push({ name: 'swipe-vs-tap', error: `drag=${swipeOk} tap=${tapOk}` });
      await page.close();
    }

    // Simulated keyboard occlusion (NOT a native software keyboard): focus
    // the search input at phone size; the viewport does not resize because
    // no IME is present — captured and labelled as simulated only.
    await shoot(browser, 'simulated-keyboard-focus-search-390x844', `${base}?fixtures=1#search`, '390x844', {
      before: async (page) => {
        await page.waitForSelector('.search-page input', { timeout: 30000 });
        await page.focus('.search-page input');
        await page.type('.search-page input', 'dune', { delay: 30 });
      },
    });
    index.push({ name: 'note-simulated-keyboard', result: 'Captured with a focused input at phone size; no native software keyboard is present in headless Chromium. Native IME occlusion is verified only on devices (M5/M6).' });
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
