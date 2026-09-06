// Shared UI component fixtures (feature 002 M2.1/M2.2). Node --test cannot
// strip JSX, so this harness bundles the primitives with esbuild (already a
// vite dependency) into a temp ESM module and renders them with
// react-dom/server. These are the "representative component fixtures" for
// the token source, accessible primitives, and the Continue carousel.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
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

process.on("exit", () => {
  primitives.cleanup();
  carousel.cleanup();
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
