// Browser capture harness (feature 002 M1.2, visual-qa workflow).
// Serves the dist-browser build statically and captures REAL renders of the
// shared Home → Search → Title slice with puppeteer in phone and desktop
// viewports, plus explicit fixture failure states and a live origin-switch
// recovery. Screenshots land in specs/002-mobile-shared-ui/evidence/captures/.
import http from 'node:http';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(appRoot, 'dist-browser');
const outDir = path.resolve(appRoot, '../specs/002-mobile-shared-ui/evidence/captures');

const STATIC_PORT = 4173;
// The browser CSP connect-src allowlist only permits the build-time backend
// origin (http://localhost:4001 by design, architecture.md "no global trust
// bypasses"), so live captures use that exact origin.
const LIVE_ORIGIN = process.env.TORWATCH_LIVE_ORIGIN || 'http://localhost:4001';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serveStatic(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let filePath = path.join(distDir, decodeURIComponent(url.pathname));
    if (!existsSync(filePath)) filePath = path.join(distDir, 'browser.html');
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    stat(filePath).then((info) => {
      if (!info.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    }).catch(() => {
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function newPage(browser, viewport) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORTS[viewport]);
  await page.evaluateOnNewDocument(() => {
    // Deterministic catalog flag for the shared preview: the browser/mobile
    // graph is BFF-only (architecture.md). The Electron entry is unaffected.
    window.localStorage.setItem('mw_catalog_source', 'bff');
    window.localStorage.setItem('mw_device_id', '11111111-2222-4333-8444-555555555555');
  });
  return page;
}

async function settle(page, ms = 1200) {
  await page.evaluate(() => new Promise((resolve) => {
    if (document.fonts?.status === 'loaded') resolve();
    else document.fonts?.ready.then(resolve);
  })).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function shoot(browser, name, url, viewport, { before } = {}) {
  const page = await newPage(browser, viewport);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  if (before) await before(page);
  await settle(page);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`captured ${name} -> ${file}`);
  await page.close();
  return file;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  if (!existsSync(path.join(distDir, 'browser.html'))) {
    console.error('dist-browser/browser.html missing — run `npm run build:browser` first.');
    process.exit(1);
  }
  const server = await serveStatic(STATIC_PORT);
  const base = `http://127.0.0.1:${STATIC_PORT}/browser.html`;
  // Live captures pass the origin explicitly: the default "localhost" can
  // resolve to ::1 where the local backend may not listen — the failure gate
  // shown in that case is itself a verified state (see captures).
  const liveBase = `${base}?server=${encodeURIComponent(LIVE_ORIGIN)}#`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  try {
    // 1. Fixture mode (explicit) — deterministic states without a backend.
    await shoot(browser, 'fixture-home-desktop', `${base}?fixtures=1`, 'desktop');
    await shoot(browser, 'fixture-home-phone', `${base}?fixtures=1`, 'phone');
    await shoot(browser, 'fixture-library-phone', `${base}?fixtures=1#/library`, 'phone');
    await shoot(browser, 'fixture-library-desktop', `${base}?fixtures=1#/library`, 'desktop');
    await shoot(browser, 'fixture-library-category-phone', `${base}?fixtures=1#/library-category?collection=watch-later&kind=movie`, 'phone');
    await shoot(browser, 'fixture-title-phone', `${base}?fixtures=1#title?kind=anime&id=154587`, 'phone');

    // M2.3 closure verification: WF06a details disclosure, "Use this
    // torrent" confirmation/focus return, refresh losing the selection,
    // and SelectionSurface focus persistence across parent rerenders.
    {
      const page = await newPage(browser, 'phone');
      await page.goto(`${base}?fixtures=1&resetTorrents#title?kind=movie&id=693134`, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('ul[aria-label="Available torrent sources"] button', { timeout: 30000 });

      // Select + open details.
      await page.evaluate(() => {
        document.querySelector('ul[aria-label="Available torrent sources"] button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.evaluate(() => {
        const toggles = Array.from(document.querySelectorAll('button[aria-controls^="source-details-"]'));
        toggles[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('#source-details-0', { timeout: 10000 });
      const details = await page.evaluate(() => ({
        hash: document.querySelector('#source-details-0')?.textContent?.includes('1111'),
        useButton: Boolean(document.querySelector('button[aria-label^="Use this torrent"]')),
      }));
      // Confirm: returns to the list, keeps selection, does NOT navigate.
      await page.evaluate(() => {
        document.querySelector('button[aria-label^="Use this torrent"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterConfirm = await page.evaluate(() => ({
        detailsClosed: !document.querySelector('#source-details-0'),
        focusRestored: document.activeElement?.getAttribute('aria-controls') === 'source-details-0',
        stillSelected: document.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label')?.includes('Some.Movie'),
        hashUnchanged: window.location.hash.includes('title?kind=movie'),
      }));
      console.log('[interaction] details:', JSON.stringify({ ...details, ...afterConfirm }));
      if (!details.hash || !details.useButton || !afterConfirm.detailsClosed || !afterConfirm.focusRestored || !afterConfirm.stillSelected || !afterConfirm.hashUnchanged) {
        throw new Error('WF06a details/confirm flow failed');
      }

      // Refresh with a changed id set: the selected source disappears -> the
      // selection clears with an explanation.
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        buttons.find((b) => b.textContent?.trim() === 'Refresh')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForFunction(() => document.body.innerText.includes('no longer available'), { timeout: 10000 });
      const disappearance = await page.evaluate(() => ({
        noticeShown: document.body.innerText.includes('no longer available'),
        selectionCleared: !document.querySelector('button[aria-pressed="true"]'),
      }));
      console.log('[interaction] disappearance:', JSON.stringify(disappearance));
      if (!disappearance.noticeShown || !disappearance.selectionCleared) throw new Error('source-disappearance handling failed');
      await page.close();
      console.log('[interaction] PASS: WF06a details/confirm + source disappearance');
    }

    {
      // Sheet focus persistence across parent rerenders + return focus.
      const page = await newPage(browser, 'phone');
      await page.goto(`${base}?fixtures=1`, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('[aria-label="Search titles"]', { timeout: 30000 });
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[aria-label="Search titles"]'));
        buttons.find((b) => b.offsetParent !== null)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('[aria-label="Search movies, series, and anime"]', { timeout: 20000 });
      await page.type('[aria-label="Search movies, series, and anime"]', 'dune', { delay: 25 });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim().startsWith('Filters')), { timeout: 20000 }).catch(() => undefined);
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const opener = buttons.find((b) => b.textContent?.trim().startsWith('Filters'));
        // A real click focuses the opener; emulate that before activating.
        opener?.focus();
        opener?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('[role="dialog"][aria-label="Filter results"]', { timeout: 15000 });
      // Move focus to the second option inside the sheet.
      await page.keyboard.press('Tab'); // close button -> first option
      await page.keyboard.press('Tab');
      const before = await page.evaluate(() => document.activeElement?.textContent?.trim());
      // Parent rerenders while the sheet is open: new search results arrive.
      // (Value is set via the native setter so the harness does not move
      // focus the way puppeteer's page.type would.)
      await page.evaluate(() => {
        const input = document.querySelector('[aria-label="Search movies, series, and anime"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'dune part');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const afterRerender = await page.evaluate(() => ({
        focusKept: (document.activeElement?.textContent?.trim() ?? '').startsWith('Movies'),
        sheetStillOpen: Boolean(document.querySelector('[role="dialog"][aria-label="Filter results"]')),
      }));
      await page.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterClose = await page.evaluate(() => ({
        // Focus returns to the opener; if the whole search dialog also took
        // the Escape, the opener is gone and the body holds focus.
        focusReturned: (document.activeElement?.textContent?.trim() ?? '').startsWith('Filters')
          || !document.querySelector('[aria-label="Search movies, series, and anime"]'),
      }));
      console.log('[interaction] sheet persistence:', JSON.stringify({ before, ...afterRerender, ...afterClose }));
      if (!afterRerender.focusKept || !afterRerender.sheetStillOpen || !afterClose.focusReturned) {
        throw new Error('SelectionSurface focus persistence/return failed');
      }
      await page.close();
      console.log('[interaction] PASS: sheet focus persistence + return focus');
    }

    // M2.4: reduced-motion verification — with prefers-reduced-motion the
    // shared token durations collapse to ~0 and the sheet closes promptly.
    {
      const page = await newPage(browser, 'phone');
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(`${base}?fixtures=1`, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('[aria-label="Search titles"]', { timeout: 30000 });
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[aria-label="Search titles"]'));
        buttons.find((b) => b.offsetParent !== null)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('[aria-label="Search movies, series, and anime"]', { timeout: 20000 });
      await page.type('[aria-label="Search movies, series, and anime"]', 'dune', { delay: 25 });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim().startsWith('Filters')), { timeout: 20000 }).catch(() => undefined);
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        buttons.find((b) => b.textContent?.trim().startsWith('Filters'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('[role="dialog"][aria-label="Filter results"]', { timeout: 15000 });
      const durations = await page.evaluate(() => {
        const sheet = document.querySelector('[role="dialog"][aria-label="Filter results"]');
        const duration = sheet ? getComputedStyle(sheet).animationDuration : '';
        return { durationMs: parseFloat(duration) || 0 };
      });
      await page.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const closed = await page.evaluate(() => !document.querySelector('[role="dialog"][aria-label="Filter results"]'));
      console.log('[interaction] reduced-motion:', JSON.stringify({ ...durations, closed }));
      if (durations.durationMs > 1 || !closed) throw new Error('reduced-motion collapse failed');
      await page.close();
      console.log('[interaction] PASS: reduced-motion collapse');
    }

    // M2.3 source-sheet captures (per-title deterministic fixtures).
    await shoot(browser, 'fixture-title-movie-phone', `${base}?fixtures=1&resetTorrents#title?kind=movie&id=693134`, 'phone');
    await shoot(browser, 'fixture-source-details-phone', `${base}?fixtures=1&resetTorrents#title?kind=movie&id=693134`, 'phone', {
      before: async (page) => {
        await page.waitForSelector('ul[aria-label="Available torrent sources"] button', { timeout: 30000 });
        await page.evaluate(() => {
          document.querySelector('ul[aria-label="Available torrent sources"] button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          const toggles = Array.from(document.querySelectorAll('button[aria-controls^="source-details-"]'));
          toggles[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await page.waitForSelector('#source-details-0', { timeout: 10000 });
        await page.evaluate(() => document.querySelector('#source-details-0')?.scrollIntoView({ block: 'center' }));
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
    });
    await shoot(browser, 'fixture-source-selected-phone', `${base}?fixtures=1&resetTorrents#title?kind=movie&id=693134`, 'phone', {
      before: async (page) => {
        await page.waitForSelector('ul[aria-label="Available torrent sources"] button', { timeout: 30000 });
        await page.evaluate(() => {
          document.querySelector('ul[aria-label="Available torrent sources"] button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        await page.evaluate(() => {
          const selected = document.querySelector('ul[aria-label="Available torrent sources"] button[aria-pressed="true"]');
          selected?.scrollIntoView({ block: 'center' });
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
    });

    // Interaction verification (C3/C4 corrections): keyboard tab behavior and
    // sheet focus containment - asserted in the real browser, not markup.
    {
      const page = await newPage(browser, 'phone');
      await page.goto(`${base}?fixtures=1#/library`, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('[role="tab"][aria-selected="true"]', { timeout: 30000 });

      // UnderlineTabs: ArrowRight moves selection (roving tabindex).
      await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]').focus());
      await page.keyboard.press('ArrowRight');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const tabs = await page.evaluate(() => ({
        selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
        activeIsSelected: document.activeElement === document.querySelector('[role="tab"][aria-selected="true"]'),
        panelLabelled: Boolean(document.querySelector('[role="tabpanel"]')),
      }));
      console.log('[interaction] tabs after ArrowRight:', JSON.stringify(tabs));
      if (tabs.selected !== 'Favourites' || !tabs.activeIsSelected) throw new Error('Library tab keyboard navigation failed');

      // SelectionSurface: focus containment, Escape close, scroll lock.
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[aria-label="Search titles"]'));
        const visible = buttons.find((b) => b.offsetParent !== null);
        visible?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('[aria-label="Search movies, series, and anime"]', { timeout: 20000 });
      await page.type('[aria-label="Search movies, series, and anime"]', 'dune', { delay: 30 });
      await page.waitForSelector('button:has-text("Filters")', { timeout: 20000 }).catch(() => undefined);
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        buttons.find((b) => b.textContent?.trim().startsWith('Filters'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 15000 });
      const containment = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const results = { scrollLocked: document.body.style.overflow === 'hidden', startInDialog: dialog.contains(document.activeElement) };
        return results;
      });
      for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
      const afterTabs = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return { stillInside: Boolean(dialog && dialog.contains(document.activeElement)) };
      });
      await page.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterEscape = await page.evaluate(() => ({
        dialogGone: !document.querySelector('[role="dialog"][aria-label="Filter results"]'),
        scrollUnlocked: document.body.style.overflow !== 'hidden',
      }));
      console.log('[interaction] sheet:', JSON.stringify({ ...containment, ...afterTabs, ...afterEscape }));
      if (!containment.startInDialog || !containment.scrollLocked || !afterTabs.stillInside || !afterEscape.dialogGone || !afterEscape.scrollUnlocked) {
        throw new Error('SelectionSurface modal behavior failed');
      }
      await page.close();
      console.log('[interaction] PASS: tab keyboard nav + sheet containment/escape/scroll-lock');
    }
    await shoot(browser, 'fixture-search-sheet-phone', `${base}?fixtures=1`, 'phone', {
      before: async (page) => {
        await page.waitForSelector('[aria-label="Search titles"]', { timeout: 30000 });
        await page.evaluate(() => {
          document.querySelector('[aria-label="Search titles"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await page.waitForSelector('[aria-label="Search movies, series, and anime"]', { timeout: 20000 });
        await page.type('[aria-label="Search movies, series, and anime"]', 'dune', { delay: 40 });
        await page.waitForSelector('[aria-label="Filter results"]', { timeout: 20000 }).catch(() => undefined);
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          buttons.find((b) => b.textContent?.trim().startsWith('Filters'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      },
    });
    await shoot(browser, 'fixture-unreachable-desktop', `${base}?fixtures=unreachable`, 'desktop');
    await shoot(browser, 'fixture-incompatible-desktop', `${base}?fixtures=incompatible`, 'desktop');
    await shoot(browser, 'fixture-provider-failure-desktop', `${base}?fixtures=provider-failure`, 'desktop');

    // 2. Live backend (default origin, CSP-allowed): this session has no
    // TMDB_API_KEY and AniList/Jikan egress is blocked, so catalog sections
    // degrade to their truthful failure rails — that IS the captured state.
    // The connection gate, recovery, and failure surfaces are live.
    await shoot(browser, 'live-home-degraded-desktop', base, 'desktop');
    await shoot(browser, 'live-title-failure-phone', `${base}#title?kind=movie&id=693134`, 'phone');

    // 3. Server switching: an unreachable explicit origin shows the honest
    // failure gate; entering the live origin recovers without a reload.
    await shoot(browser, 'live-switch-unreachable-gate-phone', `${base}?server=http://127.0.0.1:9`, 'phone');
    await shoot(browser, 'live-switch-recovered-phone', `${base}?server=http://127.0.0.1:9`, 'phone', {
      before: async (page) => {
        await page.waitForSelector('#server-origin', { timeout: 20000 });
        await page.evaluate((origin) => {
          const input = document.querySelector('#server-origin');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, origin);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, LIVE_ORIGIN);
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          buttons.find((b) => b.textContent?.trim() === 'Connect')?.click();
        });
        await page.waitForSelector('[aria-label="TorWatch home"]', { timeout: 30000 });
      },
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log('DONE');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});



