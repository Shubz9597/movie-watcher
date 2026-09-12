// M3.3 Library capture harness: captures the REAL shared Library pages and
// LibraryToggle components through the development browser fixture entry
// (?fixtures=ok&library=<scenario>) in a desktop viewport, per visual-qa.md.
// Screenshots land in specs/002-mobile-shared-ui/evidence/captures/.
import http from "node:http";
import { stat, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const distDir = path.resolve(appRoot, "dist-browser");
const outDir = path.resolve(appRoot, "../specs/002-mobile-shared-ui/evidence/captures");

const STATIC_PORT = 4173;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function serveStatic(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let filePath = path.join(distDir, decodeURIComponent(url.pathname));
    if (!existsSync(filePath)) filePath = path.join(distDir, "browser.html");
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const send = (p, status = 200) => {
      res.writeHead(status, { "Content-Type": MIME[path.extname(p)] ?? "application/octet-stream" });
      createReadStream(p).pipe(res);
    };
    stat(filePath).then((info) => {
      // A directory (e.g. the root path) serves the SPA shell.
      if (!info.isFile()) send(path.join(distDir, "browser.html"));
      else send(filePath);
    }).catch(() => {
      send(path.join(distDir, "browser.html"));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const CAPTURES = [
  { name: "desktop-library-populated-shelves", url: "fixtures=ok&library=populated#library?collection=watch-later", waitFor: "Synced with your TorWatch server" },
  { name: "desktop-library-empty", url: "fixtures=ok&library=empty#library?collection=watch-later", waitFor: "Nothing here yet" },
  { name: "desktop-library-scoped-grid", url: "fixtures=ok&library=populated#library-category?collection=watch-later&kind=movie&sort=recent", waitFor: "Load more" },
  { name: "desktop-library-unavailable-server", url: "fixtures=ok&library=unavailable#library?collection=watch-later", waitFor: "not available on this server" },
  { name: "desktop-library-failure-retry", url: "fixtures=ok&library=error#library?collection=watch-later", waitFor: "Retry" },
  { name: "desktop-library-unavailable-metadata", url: "fixtures=ok&library=populated#library?collection=watch-later", waitFor: "Info unavailable" },
  { name: "desktop-toggle-inactive-active", url: "fixtures=ok&library=populated#library-states", waitFor: "Save states" },
  { name: "desktop-toggle-pending", url: "fixtures=ok&library=write-pending#library-states", waitFor: "Save states", clickToggle: "watch-later", afterMs: 300 },
  { name: "desktop-toggle-failed-retry", url: "fixtures=ok&library=write-failure#library-states", waitFor: "Save states", clickToggle: "watch-later", afterMs: 900 },
];

const browser = await puppeteer.launch({ headless: "new" });
const server = await serveStatic(STATIC_PORT);
await mkdir(outDir, { recursive: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  for (const capture of CAPTURES) {
    await page.goto(`http://127.0.0.1:${STATIC_PORT}/?${capture.url}`, { waitUntil: "networkidle0" });
    try {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        { timeout: 8000 },
        capture.waitFor,
      );
    } catch {
      console.warn(`[capture] warning: "${capture.waitFor}" not visible for ${capture.name}`);
    }
    if (capture.clickToggle) {
      // Click the real toggle control, then wait for the requested state to
      // settle (pending immediately; failure after the scripted latency).
      await page.evaluate((field) => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const toggle = buttons.find((b) =>
          field === "watch-later"
            ? /Watch Later/.test(b.getAttribute("aria-label") ?? "")
            : /Favourite/.test(b.getAttribute("aria-label") ?? ""));
        toggle?.click();
      }, capture.clickToggle);
      await new Promise((resolve) => setTimeout(resolve, capture.afterMs ?? 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.screenshot({ path: path.join(outDir, `${capture.name}.png`) });
    console.log(`[capture] ${capture.name}.png`);
  }
} finally {
  await browser.close();
  server.close();
}
