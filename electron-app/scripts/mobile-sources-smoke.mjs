// Exercise the real title page and source panels using the explicit browser
// fixture transport. Checks page scrolling and episode/source navigation.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(app, '..', '.tmp', 'mobile-sources-review');
const baseline = process.argv.includes('--baseline');
let server, browser;
try {
  await mkdir(output, {recursive:true});
  server = await createServer({configFile:path.join(app, 'vite.config.browser.mts'), root:path.join(app, 'src'), server:{host:'127.0.0.1',port:5190,strictPort:true}, logLevel:'error'});
  await server.listen();
  browser = await puppeteer.launch({headless:true});
  for (const [name, width, height] of [['phone',390,844], ['landscape',844,390], ['tablet',1180,820]]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({width,height,isMobile:true,hasTouch:true});
    await page.goto('http://127.0.0.1:5190/browser.html?fixtures=ok#title?kind=anime&id=154587');
    await page.waitForSelector('button[aria-label="Episode 24"]');
    if (baseline) {
      await page.$eval('button[aria-label="Episode 24"]', el => el.scrollIntoView({block:'center',behavior:'instant'}));
      await page.screenshot({path:path.join(output, `before-${name}.png`)});
      console.log(name, await page.$eval('button[aria-label="Episode 24"]', el => ({scrollHeight:el.parentElement.scrollHeight,clientHeight:el.parentElement.clientHeight,overflow:getComputedStyle(el.parentElement).overflowY})));
      await page.close();
      continue;
    }
    const assertPageScroll = async () => {
      const nested = await page.$$eval('[data-source-panel] *', nodes => nodes.filter(el => ['auto','scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2).map(el => el.tagName + '.' + el.className));
      assert.deepEqual(nested, [], `${name}: source lists must not have nested vertical scrolling`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    };
    await assertPageScroll();
    await page.$eval('button[aria-label="Episode 24"]', el => el.scrollIntoView({block:'center',behavior:'instant'}));
    assert.ok(await page.$eval('h1', el => el.getBoundingClientRect().bottom < 0), `${name}: title scrolls offscreen`);
    await page.screenshot({path:path.join(output, `${name}-episodes.png`)});
    await page.click('button[aria-label="Episode 24"]');
    await page.waitForSelector('[data-source-heading]');
    await page.waitForFunction(() => !document.body.textContent.includes('Finding sources for episode'));
    await assertPageScroll();
    const top = await page.$eval('[data-source-heading]', el => el.getBoundingClientRect().top);
    assert.ok(top >= 0 && top < height / 2, `${name}: selected episode header stays in view (${top})`);
    assert.ok(await page.$eval('h1', el => el.getBoundingClientRect().bottom < 0), `${name}: source selection does not return to title`);
    if (name === 'landscape') {
      const firstSource = await page.$eval('[data-source-panel] .content-auto-row', el => el.getBoundingClientRect().top);
      assert.ok(firstSource < height - 70, 'landscape: the first source is visible below the compact episode header');
    }
    await page.screenshot({path:path.join(output, `${name}-sources.png`)});
    await page.click('[data-back-to-episodes]');
    await page.waitForSelector('button[aria-label="Episode 24"]');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Episode 24');
    const rect = await page.$eval('button[aria-label="Episode 24"]', el => ({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}));
    assert.ok(rect.top >= 0 && rect.bottom <= height, `${name}: back restores the selected episode`);
    await page.goto('http://127.0.0.1:5190/browser.html?fixtures=ok#title?kind=movie&id=693134');
    await page.waitForSelector('[aria-label="Available torrent sources"]');
    await assertPageScroll();
    await page.$eval('[data-source-panel]', el => el.scrollIntoView({block:'start',behavior:'instant'}));
    assert.ok(await page.$eval('h1', el => el.getBoundingClientRect().bottom < 0), `${name}: movie title scrolls away`);
    await page.screenshot({path:path.join(output, `${name}-movie.png`)});
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${name}: page scroll, episode/source transition, return position and movie sources passed`);
  }
  console.log('Captures: ' + output);
} finally {
  await browser?.close();
  await server?.close();
}
