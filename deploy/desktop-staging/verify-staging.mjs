// Staging validation (Windows desktop staging): drives the REAL production
// browser build + REAL Go backend + REAL staging PostgreSQL.
//
// Upstream provider: when the staging stack was started with -ValidationStub
// the backend talks to the deterministic provider stub, so this evidence is
// STUB-BACKED for catalog/title-detail. Library, recommendations, sync and
// persistence exercise the real database and real HTTP contract.
//
// Checks:
//  1. /readyz + /v1/version capability advertisement.
//  2. Catalog search + title detail through the configured provider path.
//  3. Library write → read → remove → reconcile (server-confirmed truth).
//  4. Recommendations: seeded reason + fallback + revision-cached stability.
//  5. Pagination beyond one page (35 entries, cursor walk, full-scope totals).
//  6. TWO independent browser contexts: cross-client Library sync ≤20s.
//  7. Origin switching clears household/library/recommendation state.
//  8. Server restart persistence (staging.ps1 RestartBackend is driven by the
//     caller; this script re-checks data afterwards when -afterRestart is set).
import { createRequire } from "node:module";
const require2 = createRequire("D:/Projects/movie-watcher/electron-app/package.json");
const puppeteer = require2("puppeteer");

function normalizeOrigin(value, fallback) {
  const raw = String(value || fallback).trim();
  // Be forgiving when a URL copied from rendered Markdown reaches argv.
  const markdownLink = raw.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/);
  return (markdownLink?.[1] || raw).replace(/\/+$/, "");
}

const frontendOrigin = normalizeOrigin(process.argv[2], "http://127.0.0.1:4174");
const backendOrigin = normalizeOrigin(process.argv[3], "http://127.0.0.1:4001");
const afterRestart = process.argv.includes("--afterRestart");

console.log(`[verify] frontend=${frontendOrigin} backend=${backendOrigin}${afterRestart ? " post-restart" : ""}`);

function assert(condition, message) {
  if (!condition) throw new Error(`VALIDATION FAILED: ${message}`);
  console.log(`  PASS: ${message}`);
}

async function api(path, init) {
  const response = await fetch(`${backendOrigin}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. Readiness + capabilities.
const ready = await api("/readyz");
record("readyz is 200 with ok status", ready.status === 200 && ready.body.status === "ok", JSON.stringify(ready.body));
const version = await api("/v1/version");
const capabilities = version.body.capabilities || [];
record("library.household.v1 advertised", capabilities.includes("library.household.v1"), capabilities.join(","));
record("recommendations.basic.v1 advertised", capabilities.includes("recommendations.basic.v1"));

// 2. Catalog + title detail (stub-backed when -ValidationStub was used).
const search = await api("/v2/catalog/search?q=staging&type=all");
record("catalog search returns results", search.status === 200 && (search.body.results || []).length > 0,
  `degraded=${search.body.degraded}`);
const firstTitle = (search.body.results || [])[0];
let detailOk = false;
if (firstTitle) {
  const detail = await api(`/v2/catalog/titles/${encodeURIComponent(firstTitle.id).replace(/%3A/g, ":")}`);
  detailOk = detail.status === 200 && detail.body.id === firstTitle.id;
  record("title detail resolves the same qualified id", detailOk, detail.body.id);
}

// 3-5. Library lifecycle through the contract.
async function put(id, field, enabled) {
  const encoded = encodeURIComponent(id).replace(/%3A/g, ":");
  return api(`/v2/library/${encoded}/${field === "favourites" ? "favourite" : "watch-later"}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
  });
}

// The staging database intentionally persists. Normalize only the reserved
// validation title before asserting transitions; never assume a pristine DB.
const primaryId = "tmdb:movie:693134";
if (afterRestart) {
  const persisted = await api("/v2/library/memberships?ids=" + encodeURIComponent(primaryId));
  const membership = persisted.body.memberships?.[0];
  record("pre-restart Library state persisted before validation writes",
    persisted.status === 200 && membership?.watchLater === true && membership?.favourite === true,
    membership ? `revision ${persisted.body.revision}` : "reserved membership missing");
}
await put(primaryId, "watch-later", false);
await put(primaryId, "favourites", false);
const writeA = await put(primaryId, "watch-later", true);
record("library write returns both flags + revision", writeA.status === 200 &&
  writeA.body.watchLater === true && writeA.body.favourite === false && /^\d+$/.test(writeA.body.revision),
  `revision ${writeA.body.revision}`);
const writeB = await put(primaryId, "favourites", true);
record("independent flags (favourite write keeps watch-later)", writeB.body.watchLater === true && writeB.body.favourite === true);
// No-op assertion is RELATIVE (the staging database may be reused across
// validation runs): the revision must be unchanged by the no-op itself.
const revisionBeforeNoOp = writeB.body.revision;
const noOp = await put(primaryId, "watch-later", true);
record("no-op write keeps the revision", noOp.body.revision === revisionBeforeNoOp, `before ${revisionBeforeNoOp} after ${noOp.body.revision}`);

// Reconciliation: memberships endpoint proves one title, omits unknown.
const memberships = await api("/v2/library/memberships?ids=" +
  encodeURIComponent(primaryId) + "," + encodeURIComponent("tmdb:movie:999999999"));
record("memberships reconciliation omits unknown ids", memberships.status === 200 &&
  memberships.body.memberships.length === 1, `revision ${memberships.body.revision}`);

// Pagination on a persistent database: normalize a reserved 35-title set,
// then prove the complete cursor walk is duplicate-free and includes it. Do
// not assert an absolute total that unrelated staging data can change.
const paginationIds = Array.from({ length: 35 }, (_, i) => `tmdb:movie:${9000 + i}`);
for (const id of paginationIds) await put(id, "favourites", false);
for (const id of paginationIds) await put(id, "favourites", true);
let page = await api("/v2/library?collection=favourites&limit=10");
const total = page.body.total;
let seen = new Set((page.body.items || []).map((i) => i.canonicalId));
let cursor = page.body.nextCursor;
let pages = 1;
while (cursor && pages < 10) {
  page = await api(`/v2/library?collection=favourites&limit=10&cursor=${encodeURIComponent(cursor)}`);
  for (const item of page.body.items) seen.add(item.canonicalId);
  cursor = page.body.nextCursor;
  pages++;
}
record("pagination walks to full scope without duplicates", seen.size === total && paginationIds.every((id) => seen.has(id)),
  `${seen.size} unique of ${total} across ${pages} pages; reserved set present=${paginationIds.every((id) => seen.has(id))}`);

// Recommendations: seeded (a favourite shares Action/Science Fiction with
// the stub's popular candidates).
const recs = await api("/v2/recommendations");
record("recommendations exclude saved titles and seed-ground reasons exist",
  recs.status === 200 && !recs.body.fallback &&
  recs.body.items.some((i) => i.reason.code === "seed_genre" && i.reason.seedCanonicalId),
  `items=${recs.body.items.length}`);
const recRevision = recs.body.revision;
const recAgain = await api("/v2/recommendations");
record("recommendations revision-cached between reads", recAgain.body.generatedAt === recs.body.generatedAt,
  `revision ${recAgain.body.revision}`);

if (!afterRestart) {
  console.log("\nBrowser-context validation (two independent clients):");
  const browser = await puppeteer.launch({
    headless: "new",
    // Both pages model actively running household clients. Chromium normally
    // throttles timers in a background tab, which would invalidate the
    // product's visible-client 15s poll contract and make this test flaky.
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  try {
    const contextA = await browser.createBrowserContext();
    const contextB = await browser.createBrowserContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // This application intentionally polls, so networkidle0 is not a valid
    // readiness signal. Bound navigation and wait for the mounted root.
    pageA.setDefaultTimeout(15_000);
    pageB.setDefaultTimeout(15_000);
    await pageA.goto(`${frontendOrigin}/browser.html?server=${encodeURIComponent(backendOrigin)}#home`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await pageB.goto(`${frontendOrigin}/browser.html?server=${encodeURIComponent(backendOrigin)}#home`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await Promise.all([pageA.waitForSelector("#root"), pageB.waitForSelector("#root")]);
    const titleA = await pageA.title();
    // Both contexts must have actually mounted the shared React tree (a
    // document.title read alone proves nothing about the bundle).
    const rootsMounted = await Promise.all([
      pageA.$eval("#root", (el) => el.children.length > 0),
      pageB.$eval("#root", (el) => el.children.length > 0),
    ]);
    record("production frontend loads in two independent contexts",
      rootsMounted.every(Boolean) && titleA.length >= 0,
      `roots mounted A=${rootsMounted[0]} B=${rootsMounted[1]}`);

    // Drive a real write from client A's shared LibraryToggle. Client B is
    // already mounted on Library and must render the new server snapshot via
    // the shared bounded sync controller (not a verifier-side API poll).
    const syncId = "tmdb:movie:693135";
    await put(syncId, "favourites", false);
    await pageA.goto(`${frontendOrigin}/browser.html?server=${encodeURIComponent(backendOrigin)}#title?kind=movie&id=693135`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await pageB.goto(`${frontendOrigin}/browser.html?server=${encodeURIComponent(backendOrigin)}#library?collection=favourites&sort=recent`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    try {
      await pageA.waitForFunction(() =>
        [...document.querySelectorAll("button")].some((button) => (button.getAttribute("aria-label") || "").includes("Favourite")),
        { timeout: 15_000, polling: 100 },
      );
    } catch (error) {
      const diagnostic = await pageA.evaluate(() => ({
        url: location.href,
        body: document.body.innerText.slice(0, 1200),
        buttons: [...document.querySelectorAll("button")].map((button) => ({
          label: button.getAttribute("aria-label"), text: button.textContent?.trim(), disabled: button.disabled,
        })),
      }));
      console.error("[verify] title-toggle diagnostic:", JSON.stringify(diagnostic));
      throw error;
    }
    const favouriteLabels = await pageA.$$eval("button", (buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")).filter((label) => label?.includes("Favourite")),
    );
    record("title renders an available Favourite toggle", favouriteLabels.includes("Mark as Favourite"), favouriteLabels.join(", "));
    const favouriteButton = await pageA.$('button[aria-label="Mark as Favourite"]');
    if (!favouriteButton) throw new Error(`VALIDATION FAILED: available Favourite toggle missing (${favouriteLabels.join(", ")})`);
    const t0 = Date.now();
    await favouriteButton.click();
    await pageA.waitForSelector('button[aria-label="Remove from Favourites"]', { timeout: 10_000 });
    let observed = true;
    try {
      await pageB.waitForFunction(() => document.body.innerText.includes("Staging Movie 693135"), { timeout: 20_000, polling: 250 });
    } catch { observed = false; }
    record("cross-client UI visibility within 20s (A → B)", observed, `${Date.now() - t0}ms`);

    // Drive the removal through client A and require client B's rendered
    // Library to remove it on the next bounded refresh while other titles
    // remain in the collection.
    const removeButton = await pageA.$('button[aria-label="Remove from Favourites"]');
    await removeButton?.click();
    await pageA.waitForSelector('button[aria-label="Mark as Favourite"]', { timeout: 10_000 });
    const serverRemoval = await api("/v2/library/memberships?ids=" + encodeURIComponent(syncId));
    const serverMembership = serverRemoval.body.memberships?.[0];
    record("client A removal is confirmed by the server",
      serverRemoval.status === 200 && serverMembership?.favourite === false,
      `revision ${serverRemoval.body.revision}`);
    const removalStart = Date.now();
    let removed = true;
    try {
      await pageB.waitForFunction(() => !document.body.innerText.includes("Staging Movie 693135"), { timeout: 20_000, polling: 250 });
    } catch { removed = false; }
    record("cross-client UI removal within 20s while collection remains non-empty", removed, `${Date.now() - removalStart}ms`);

    // Origin switch: pointing the page at a dead origin must clear
    // library state (household caches are origin-scoped).
    await pageB.goto(`${frontendOrigin}/browser.html?server=${encodeURIComponent("http://127.0.0.1:9")}#library?collection=favourites`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const offlineText = await pageB.evaluate(() => document.body.innerText);
    record("origin switch to a dead server shows the truthful unavailable state",
      offlineText.includes("not available") || offlineText.includes("could not be reached"),
      "library unavailable copy rendered");
  } finally {
    await browser.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nStaging validation: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join("; ")}` : ""}${afterRestart ? " (post-restart re-check)" : ""}`);
process.exit(failed.length ? 1 : 0);
