// M4.2 recommendations capture harness: the REAL shared RecommendationRow /
// RecommendationsAllPage via the dev-only browser fixture entry
// (?fixtures=ok&recs=<scenario>) at desktop and phone viewports.
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

const STATIC_PORT = 4174;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
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
    const send = (p) => {
      res.writeHead(200, { "Content-Type": MIME[path.extname(p)] ?? "application/octet-stream" });
      createReadStream(p).pipe(res);
    };
    stat(filePath).then((info) => {
      if (!info.isFile()) send(path.join(distDir, "browser.html"));
      else send(filePath);
    }).catch(() => send(path.join(distDir, "browser.html")));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const CAPTURES = [
  { name: "recs-desktop-seeded", viewport: "desktop", url: "fixtures=ok&recs=seeded#recommendations-states" },
  { name: "recs-phone-seeded", viewport: "phone", url: "fixtures=ok&recs=seeded#recommendations-states" },
  { name: "recs-desktop-popular", viewport: "desktop", url: "fixtures=ok&recs=popular#recommendations-states" },
  { name: "recs-desktop-degraded", viewport: "desktop", url: "fixtures=ok&recs=degraded#recommendations-states" },
  { name: "recs-desktop-error-retry", viewport: "desktop", url: "fixtures=ok&recs=error#recommendations-states" },
  { name: "recs-phone-error-retry", viewport: "phone", url: "fixtures=ok&recs=error#recommendations-states" },
  { name: "recs-desktop-empty-seeall", viewport: "desktop", url: "fixtures=ok&recs=empty#recommendations" },
  { name: "recs-phone-seedrow", viewport: "phone", url: "fixtures=ok&recs=seeded#recommendations" },
];

const browser = await puppeteer.launch({ headless: "new" });
const server = await serveStatic(STATIC_PORT);
await mkdir(outDir, { recursive: true });
try {
  for (const capture of CAPTURES) {
    const page = await browser.newPage();
    await page.setViewport(capture.viewport === "phone"
      ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${STATIC_PORT}/?${capture.url}`, { waitUntil: "networkidle0" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.screenshot({ path: path.join(outDir, `${capture.name}.png`) });
    console.log(`[capture] ${capture.name}.png`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
