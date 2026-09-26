import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
const distDir = path.resolve(process.cwd(), 'dist-browser');
const server = http.createServer((req, res) => {
  let fp = path.join(distDir, req.url === '/' ? 'browser.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(fp)) fp = path.join(distDir, 'browser.html');
  res.writeHead(200, { 'Content-Type': fp.endsWith('.html') ? 'text/html' : fp.endsWith('.css') ? 'text/css' : 'application/javascript' });
  createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(4199, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 160)));
await page.setViewport({ width: 390, height: 844 });
await page.goto('http://127.0.0.1:4199/browser.html', { waitUntil: 'networkidle2', timeout: 30000 });
const info = await page.evaluate(() => {
  const sheets = Array.from(document.styleSheets).map((s) => {
    let count = -1; let err = '';
    try { count = s.cssRules.length; } catch (e) { err = String(e).slice(0, 60); }
    return { href: (s.href ?? 'inline').split('/').pop(), count, err, disabled: s.disabled };
  });
  const probe = document.createElement('div');
  probe.className = 'hidden';
  document.body.appendChild(probe);
  const d = getComputedStyle(probe).display;
  probe.remove();
  return { sheets, probeDisplay: d, links: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.href.split('/').pop()) };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
server.close();
