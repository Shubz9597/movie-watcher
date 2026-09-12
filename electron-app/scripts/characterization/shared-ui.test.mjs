// Shared UI component fixtures (feature 002 M2.1/M2.2). Node --test cannot
// strip JSX, so this harness bundles the primitives with esbuild (already a
// vite dependency) into a temp ESM module and renders them with
// react-dom/server. These are the "representative component fixtures" for
// the token source, accessible primitives, and the Continue carousel.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
import esbuild from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

function buildComponent(entry, name) {
  // Output must live inside the project so the external "react" require
  // resolves against the project's node_modules. CJS keeps one React
  // instance between the bundle and this test process.
  const outDir = path.resolve("node_modules", ".shared-ui-fixture");
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `${name}.cjs`);
  esbuild.buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "node",
    loader: { ".png": "dataurl" },
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server"],
    logLevel: "silent",
  });
  return {
    load() {
      return nodeRequire(outfile);
    },
    cleanup() {
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

const primitives = buildComponent("src/components/primitives/index.tsx", "primitives");
const carousel = buildComponent("src/components/shared/ContinueCarousel.tsx", "carousel");
const catalogFilters = buildComponent("src/components/shared/CatalogFilters.tsx", "catalog-filters");

process.on("exit", () => {
  primitives.cleanup();
  carousel.cleanup();
  catalogFilters.cleanup();
});

test("IconButton enforces the shared 48px target, focus ring, and accessible name", async () => {
  const { IconButton } = primitives.load();
  const html = renderToStaticMarkup(
    React.createElement(IconButton, {
      label: "Pause playback",
      icon: React.createElement("span", null, "⏸"),
      variant: "outline",
    }),
  );
  assert.match(html, /aria-label="Pause playback"/, "accessible name is mandatory");
  assert.match(html, /title="Pause playback"/);
  assert.match(html, /min-h-\[var\(--touch-target\)\]/, "48px target comes from the shared token");
  assert.match(html, /focus-visible:ring-2/, "shared focus treatment");
  assert.match(html, /border/, "outline variant");
});

test("UnderlineTabs render the selected tab with an underline and tablist semantics", async () => {
  const { UnderlineTabs } = primitives.load();
  const html = renderToStaticMarkup(
    React.createElement(UnderlineTabs, {
      ariaLabel: "Library collections",
      active: "favourites",
      onChange: () => {},
      tabs: [
        { id: "watch-later", label: "Watch Later" },
        { id: "favourites", label: "Favourites" },
      ],
    }),
  );
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /aria-selected="false"/);
  assert.match(html, /opacity-100/, "the active tab's underline is visible");
});

test("SelectionSurface renders nothing closed and a labelled dialog open", async () => {
  const { SelectionSurface } = primitives.load();
  const closed = renderToStaticMarkup(
    React.createElement(SelectionSurface, { open: false, title: "Filter results", onClose: () => {} }, null),
  );
  assert.equal(closed, "", "no stray DOM when closed");
  const open = renderToStaticMarkup(
    React.createElement(SelectionSurface, { open: true, title: "Filter results", onClose: () => {} }, "children"),
  );
  assert.match(open, /role="dialog"/);
  assert.match(open, /aria-modal="true"/);
  assert.match(open, /aria-label="Close Filter results"/);
  assert.match(open, /animation:torwatch-sheet-in var\(--motion-sheet\)/, "sheet enter uses the shared motion token");
  assert.match(open, /max-h-\[60dvh\] overflow-y-auto/, "content is height-bounded with internal scroll");
});

test("ContinueCarousel separates resume and detail targets with progress on artwork", async () => {
  const { ContinueCarousel } = carousel.load();
  const items = [
    {
      seriesId: "tmdb:movie:693134", season: 0, episode: 0, position_s: 3900, duration_s: 10020,
      percent: 39, updated_at: "2026-09-06T12:00:00Z", sourceAvailable: true,
      title: "Dune: Part Two", posterPath: "https://poster.example/dune.jpg", kind: "movie", upNext: false,
    },
    {
      seriesId: "tmdb:tv:1396", season: 1, episode: 4, position_s: 600, duration_s: 2820,
      percent: 21, updated_at: "2026-09-06T11:00:00Z", sourceAvailable: true,
      title: "Breaking Bad", posterPath: null, kind: "tv", upNext: false,
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(ContinueCarousel, {
      items,
      onResumeRequest: () => {},
      onOpenTitle: () => {},
    }),
  );
  assert.match(html, /snap-mandatory/, "snap scrolling (no timer autoplay)");
  assert.match(html, /aria-label="Resume Dune: Part Two"/, "resume is its own named target");
  assert.match(html, /aria-label="Resume Breaking Bad"/);
  assert.match(html, /width:39%/, "progress lives on the artwork");
  assert.match(html, /width:21%/);
  assert.match(html, /Dune: Part Two/, "title text is a separate element (detail intent)");
  assert.doesNotMatch(html, /Resume bar/, "no full-width resume bar exists");
});

test("Home keeps the featured carousel, Continue, recommendations, then rotating catalog shelves", () => {
  const home = readFileSync("src/pages/HomePage.tsx", "utf8");
  const continueAt = home.indexOf("<ContinueRail navigate");
  const recommendationsAt = home.indexOf("<RecommendationRow navigate");
  const catalogAt = home.indexOf("<CarouselRow", recommendationsAt);
  assert.ok(continueAt > 0 && continueAt < recommendationsAt && recommendationsAt < catalogAt, "personal rows precede broad trending shelves");
  assert.doesNotMatch(readFileSync("src/components/CarouselRow.tsx", "utf8"), /Now in rotation/, "removed rotation label stays removed");
  assert.match(readFileSync("src/components/shared/BrowseRail.tsx", "utf8"), /md:hidden/, "browse pills remain phone-only");
});

test("desktop Library destination has visual weight beside Search", () => {
  const header = readFileSync("src/components/AppHeader.tsx", "utf8");
  const libraryButton = header.match(/onClick=\{\(\) => navigate\('library'[\s\S]*?<\/button>/)?.[0];
  assert.ok(libraryButton, "Library destination remains present");
  assert.match(header, /LibraryBig/, "the stronger library glyph is used");
  assert.match(libraryButton, /font-semibold/, "the label carries more weight than secondary browse links");
  assert.match(libraryButton, /rounded-full[^\"]*hover:bg-white\/\[0\.06\]/, "the rounded surface appears on hover");
  assert.doesNotMatch(libraryButton, /\bborder\b|bg-white\/\[0\.03\]|min-w-28/, "no permanent button container is shown");
  assert.match(header, /LibraryBig className="h-5 w-5 shrink-0" strokeWidth=\{1\.9\}/, "the icon is optically larger and heavier");
});

test("shared header does not require requestIdleCallback on Safari or WKWebView", () => {
  const header = readFileSync("src/components/AppHeader.tsx", "utf8");
  assert.match(header, /typeof window\.requestIdleCallback === 'function'/, "the optional idle API is feature-detected");
  assert.match(header, /window\.setTimeout\(preload, 250\)/, "a non-blocking timer fallback preloads search on WebKit");
  assert.match(header, /window\.clearTimeout\(timeoutId\)/, "the fallback timer is cleaned up when the header unmounts");
});

test("CatalogFilters offers an inline desktop panel and a compact-screen selection sheet", () => {
  const { CatalogFilters } = catalogFilters.load();
  const html = renderToStaticMarkup(
    React.createElement(CatalogFilters, {
      kind: "movie",
      api: "tmdb:trending:movie",
      navigate: () => {},
    }),
  );
  assert.match(html, /aria-haspopup="dialog"/, "compact trigger advertises the modal filter sheet");
  assert.match(html, /hidden md:block/, "desktop filter disclosure is breakpoint-specific");
  assert.match(html, /md:hidden/, "phone filter trigger is breakpoint-specific");
  assert.match(html, /Science Fiction/, "provider-backed movie genres are offered");
  assert.doesNotMatch(html, /Title type|>Series<|>Anime</, "the movie page does not repeat cross-catalog navigation inside its filters");
  assert.doesNotMatch(html, /Ecchi/, "anime-only genres do not leak into movie filters");

  const anime = renderToStaticMarkup(
    React.createElement(CatalogFilters, {
      kind: "anime",
      api: "anilist:genre:anime:Slice of Life",
      navigate: () => {},
    }),
  );
  assert.match(anime, /Slice of Life/, "AniList named genres are exposed in the same responsive filter surface");
  assert.match(anime, /Filters · Slice of Life/, "the active AniList genre is visible on the compact trigger");
  assert.doesNotMatch(anime, /Title type|>Movies<|>Series</, "the anime page only filters anime");
  assert.doesNotMatch(anime, /Documentary/, "movie-only genres do not leak into anime filters");
  assert.doesNotMatch(anime, /not exposed by the current catalog provider/, "obsolete unsupported copy stays removed");
});
