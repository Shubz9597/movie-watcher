// Design-artifact capture only. Run from the repository root with Node.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../electron-app/package.json', import.meta.url));
const puppeteer = require('puppeteer');
const base = new URL('./', import.meta.url);
await mkdir(new URL('captures/', base), { recursive: true });
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1150, deviceScaleFactor: 1 });
  await page.goto(new URL('wireframes.html', base).href);
  for (const board of ['reference', 'connection', 'downloads', 'system']) {
    await page.click(`[data-board="${board}"]`);
    await page.screenshot({ path: fileURLToPath(new URL(`captures/${board}.png`, base)), fullPage: true });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.group:not([hidden]) .phone')].some(el => el.scrollWidth > el.clientWidth + 1));
    if (overflow) throw new Error(`Horizontal frame overflow: ${board}`);
    if (board === 'connection' || board === 'downloads') {
      for (const id of board === 'connection' ? ['WF01', 'WF02'] : ['WF06', 'WF12']) {
        await page.locator(`#${id}`).wait();
        await (await page.$(`#${id}`)).screenshot({ path: fileURLToPath(new URL(`captures/${id}.png`, base)) });
      }
    }
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.click('[data-board="connection"]');
  await page.screenshot({ path: fileURLToPath(new URL('captures/board-mobile.png', base)), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw new Error('Mobile board overflows viewport');
  console.log('Captured four boards, four detail frames and mobile layout; no horizontal overflow.');
} finally {
  await browser.close();
}
