// Bulk delete on the Downloads screens, against the fixture inventory
// (?downloads=items): hold a row to start selecting, tap to tick, Select
// all, Delete with one confirmation. A short tap never starts selecting.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(app, 'dist-mobile');
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
const origin = `http://127.0.0.1:${server.address().port}/?fixtures=ok&downloads=items`;

const heading = page => page.$eval('h1', el => el.textContent);
const waitHeading = (page, text) => page.waitForFunction(t => document.querySelector('h1')?.textContent === t, { timeout: 5000 }, text)
  .catch(async error => { throw new Error(`expected heading "${text}", saw "${await heading(page)}" at ${await page.evaluate(() => location.hash)}`, { cause: error }); });
// The list settles (storage line, rows) before a hold: a row moving under
// the pointer cancels it, as a scroll would.
const settle = () => new Promise(resolve => setTimeout(resolve, 500));
async function hold(page, selector) {
  await page.waitForSelector(selector);
  await settle();
  const box = await (await page.$(selector)).boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await new Promise(resolve => setTimeout(resolve, 650));
  await page.mouse.up();
}

let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  // Fixture: Dune (ready movie), Breaking Bad (S1E4 ready, S1E5
  // downloading), Frieren (downloading), Interstellar (interrupted).
  // Rows are tagged by their text so the steps read clearly.
  const tagRows = () => page.evaluate(() => {
    for (const li of document.querySelectorAll('main li, section li')) {
      const text = li.innerText;
      li.dataset.row = text.includes('Dune') ? 'dune' : text.includes('Breaking Bad') ? 'bb-show'
        : /Play|Resume/.test(text) ? 'ready' : 'busy';
    }
  });

  // A show's screen: a short tap never starts selecting; a hold does; a row
  // still downloading cannot be ticked.
  await page.goto(`${origin}#downloads-series?series=${encodeURIComponent('tmdb:tv:1396')}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelectorAll('section li').length === 2);
  await settle();
  await page.evaluate(() => {
    for (const li of document.querySelectorAll('section li')) li.dataset.row = /Pause|Resume|downloading/i.test(li.innerText) ? 'busy' : 'ready';
  });
  const ready = 'section li[data-row="ready"]';
  const busy = 'section li[data-row="busy"]';
  const readyBox = await (await page.$(ready)).boundingBox();
  await page.mouse.click(readyBox.x + 20, readyBox.y + 20);
  await settle();
  assert.ok(!(await page.$('[role="toolbar"]')), 'a short tap does not start selecting');
  await page.goto(`${origin}#downloads-series?series=${encodeURIComponent('tmdb:tv:1396')}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelectorAll('section li').length === 2);
  await page.evaluate(() => {
    for (const li of document.querySelectorAll('section li')) li.dataset.row = /Pause|Resume|downloading/i.test(li.innerText) ? 'busy' : 'ready';
  });
  await hold(page, ready);
  await waitHeading(page, '1 selected');
  assert.equal(await page.$eval(ready, el => el.getAttribute('aria-checked')), 'true', 'the held row is ticked');
  assert.equal(await page.$eval(busy, el => el.getAttribute('aria-disabled')), 'true', 'a downloading row cannot be ticked');
  await page.click(ready);
  await waitHeading(page, 'Select downloads');
  await page.click(ready);
  await waitHeading(page, '1 selected');
  await page.click('button[aria-label="Cancel selection"]');
  await waitHeading(page, 'Breaking Bad');

  // Overview: holding a show ticks its finished episodes; other rows toggle;
  // Select all takes every finished download; one confirmation removes them.
  await page.goto(`${origin}#downloads`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Breaking Bad'));
  await settle();
  await tagRows();
  await hold(page, 'li[data-row="bb-show"] button');
  await waitHeading(page, '1 selected');
  await page.click('li[data-row="dune"]');
  await waitHeading(page, '2 selected');
  await page.click('li[data-row="dune"]');
  await waitHeading(page, '1 selected');
  await page.evaluate(() => [...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.trim() === 'Select all').click());
  await waitHeading(page, '2 selected');
  await page.evaluate(() => [...document.querySelectorAll('[role="toolbar"] button')].find(b => b.textContent.includes('Delete')).click());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Remove 2 downloads'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove 2 downloads').click());
  await waitHeading(page, 'Downloads');
  await page.waitForFunction(() => !document.body.innerText.includes('Dune'));
  assert.ok(!(await page.$('[role="toolbar"]')), 'selection ends after deleting');
  assert.ok((await page.evaluate(() => document.body.innerText)).includes('Frieren'), 'downloads still in progress are kept');
  console.log('Downloads bulk delete smoke passed: hold to select (row and show), tap toggles, short tap ignored, select all, one confirmation removes all.');
} finally {
  await browser?.close();
  server.close();
}
