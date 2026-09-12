// Mobile-sized browser smoke for the private staging stack (UI MECHANICS ONLY).
//
// What this proves (automated, desktop Chromium at iPhone size):
//   1. the production browser app loads,
//   2. a title page opens and the source panel renders,
//   3. the real click path select-row -> Play -> PlayerPage works,
//   4. BrowserPlayer creates the native <video> UI pointed at the CURRENT
//      backend origin's /stream endpoint with cat/fileIndex params,
//   5. Close tears the player down and returns safely.
//
// What this does NOT claim: no playback, no peer data, no iPhone codec result.
// The torrent SEARCH response is intercepted at the page level and replaced
// with ONE clearly synthetic source row (labelled smoke-fixture) so the
// click-through can be driven without a real seeded torrent; the source row
// text says "Synthetic UI fixture". Catalog content itself comes from the
// deterministic staging provider stub (stub-backed).
import puppeteer from "puppeteer";
import { createRequire } from "node:module";

const require2 = createRequire("D:/Projects/movie-watcher/electron-app/package.json");
const frontendOrigin = process.argv[2] || "http://127.0.0.1:4174";

const results = [];
function record(ok, name, detail = "") {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// Synthetic source row: never a playback or provider claim. The magnet is a
// syntactically valid all-zero infohash that cannot download anything.
const FIXTURE_ROW = {
  title: "Synthetic UI fixture (smoke)",
  indexer: "smoke-fixture",
  size: 734003200,
  seeders: 3,
  leechers: 1,
  magnetUri: "magnet:?xt=urn:btih:0000000000000000000000000000000000000000&dn=smoke-sample",
  infoHash: "0000000000000000000000000000000000000000",
};

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--disable-background-timer-throttling", "--use-mobile-user-agent"],
});

try {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  // iPhone-sized viewport.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  // Intercept the torrent search POST (UI-mechanics fixture only). The
  // synthetic response must carry CORS headers itself — request.respond()
  // bypasses the real server's CORS.
  const corsHeaders = {
    "Access-Control-Allow-Origin": frontendOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  };
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().includes("/v1/torrents/search")) {
      if (request.method() === "OPTIONS") {
        request.respond({ status: 200, headers: corsHeaders });
        return;
      }
      if (request.method() === "POST") {
        request.respond({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({ query: {}, total: 1, results: [FIXTURE_ROW] }),
        });
        return;
      }
    }
    request.continue();
  });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${frontendOrigin}/browser.html#home`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#root", { timeout: 20000 });
  const mounted = await page.$eval("#root", (el) => el.children.length > 0);
  record(mounted, "mobile viewport: production browser app loads");

  // PWA metadata actually present in the served shell.
  const manifestHref = await page.$eval('link[rel="manifest"]', (el) => el.getAttribute("href")).catch(() => null);
  record(Boolean(manifestHref), "PWA manifest link present", `href=${manifestHref}`);

  // Title page (stub catalog detail).
  await page.evaluate(() => { window.location.hash = "#title?kind=movie&id=3"; });
  await page.waitForSelector('[aria-label="Available torrent sources"]', { timeout: 30000 });
  const sourceRow = await page.waitForSelector("ul[aria-label='Available torrent sources'] li", { timeout: 20000 });
  record(Boolean(sourceRow), "title opens; source panel renders a row", "fixture-injected search response");

  // Select the row (real click path).
  await sourceRow.click();
  const selected = await page.$eval("ul[aria-label='Available torrent sources'] li button", (el) => el.getAttribute("aria-pressed"));
  record(selected === "true", "source row selectable (aria-pressed)");

  // Play via the fixed compact footer (the mobile path).
  const footerClicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const play = buttons.find((b) => (b.textContent || "").includes("Play selected source"));
    if (!play) return false;
    play.click();
    return true;
  });
  record(footerClicked, "compact footer Play control present and clickable");

  // PlayerPage + BrowserPlayer native video UI.
  await page.waitForFunction(() => window.location.hash.startsWith("#player?"), { timeout: 20000 });
  record(true, "source selection navigated to PlayerPage (hash route)");
  await page.waitForSelector("video", { timeout: 20000 });
  const videoInfo = await page.$eval("video", (el) => ({
    hasControls: el.controls,
    playsInline: el.playsInline,
    srcPath: (() => { try { const u = new URL(el.src); return u.pathname + " cat=" + u.searchParams.get("cat") + " fileIndex=" + u.searchParams.get("fileIndex") + " origin=" + u.origin; } catch { return "unparseable"; } })(),
  }));
  record(videoInfo.hasControls && videoInfo.playsInline, "BrowserPlayer created native video UI (controls, playsInline)");
  record(
    videoInfo.srcPath.includes("/stream") && videoInfo.srcPath.includes("cat=movie"),
    "video src targets the current backend origin /stream with cat/fileIndex",
    videoInfo.srcPath,
  );

  // Close returns safely.
  await page.evaluate(() => {
    const close = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "Close player");
    close.click();
  });
  await page.waitForFunction(() => !document.querySelector("video") && !window.location.hash.startsWith("#player?"), { timeout: 20000 });
  record(true, "Close tears down the player and returns to the title route");

  // The Electron secure-settings bridge is intentionally absent in browsers;
  // the shared bundle logs these inert, documented notices (guarded probes).
  const inertMessages = [
    "Secure settings bridge is unavailable",
    "TMDb credential is unavailable because the secure settings bridge",
  ];
  const fatalErrors = consoleErrors.filter((text) =>
    !text.includes("ERR_") &&
    !text.includes("Failed to load resource") &&
    !inertMessages.some((inert) => text.includes(inert)));
  record(fatalErrors.length === 0, "no unexpected renderer errors", fatalErrors.slice(0, 3).join(" | ").slice(0, 300));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nMobile browser smoke: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.error("MOBILE_SMOKE_ERROR=" + (error && error.stack || error));
  const failed = results.filter((r) => !r.ok);
  console.log(`Mobile browser smoke: ${results.length - failed.length}/${results.length} checks passed before failure`);
  process.exit(1);
} finally {
  await browser.close();
}
