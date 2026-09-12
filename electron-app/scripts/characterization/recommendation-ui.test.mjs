// M4.2 recommendation UI characterization: the REAL RecommendationRow /
// RecommendationsAllPage VIEW components rendered with deterministic contract
// fixture states — truthful reasons, fallback/degraded/empty/error states,
// capability gating, accessible naming. (The views are pure so SSR can render
// exact states; the hook wiring is exercised by the browser captures.)
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const nodeRequire = createRequire(import.meta.url);
const appRoot = path.resolve(".");

function buildBundles() {
  const outDir = path.resolve("node_modules", ".recs-fixture");
  mkdirSync(outDir, { recursive: true });
  esbuild.buildSync({
    stdin: {
      contents: `
        import { RecommendationRowView, RecommendationsAllPageView } from "${appRoot.replace(/\\/g, "/")}/src/components/shared/RecommendationRow";
        export { RecommendationRowView, RecommendationsAllPageView };
      `,
      resolveDir: appRoot,
      loader: "tsx",
    },
    outfile: path.join(outDir, "recs.cjs"),
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "node",
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server"],
    logLevel: "silent",
  });
  esbuild.buildSync({
    entryPoints: [path.join(appRoot, "src", "platform", "recommendation-fixtures.ts")],
    outfile: path.join(outDir, "recs-fixtures.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    external: ["react", "react/jsx-runtime"],
    logLevel: "silent",
  });
  return {
    load() {
      return {
        views: nodeRequire(path.join(outDir, "recs.cjs")),
        fixtures: nodeRequire(path.join(outDir, "recs-fixtures.cjs")),
      };
    },
    cleanup() {
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

const bundles = buildBundles();
process.on("exit", () => bundles.cleanup());

function readyState(fixtures, scenario) {
  return { status: "ready", data: fixtures.recommendationsFixtureData(scenario), error: null };
}

test("seeded recommendations show truthful grounded reasons and accessible card names", async () => {
  const { views, fixtures } = bundles.load();
  const html = renderToStaticMarkup(
    React.createElement(views.RecommendationRowView, {
      state: readyState(fixtures, "seeded"),
      retry: () => {},
      navigate: () => {},
    }),
  );
  assert.match(html, /Because you favourited Blade Runner 2049/, "the server's seed-grounded reason renders verbatim");
  assert.match(html, /aria-label="Dune: Part Two, Because you favourited Blade Runner 2049"/, "cards carry title + reason as accessible names");
  assert.match(html, /Recommended for your household/, "favourite-based section is distinguishable from fallback");
  assert.match(html, /See all/, "See-all affordance present");
  assert.match(html, /focus-visible:ring-2/, "keyboard focus treatment on cards and controls");
});

test("cold start renders the labelled Popular picks fallback", async () => {
  const { views, fixtures } = bundles.load();
  const html = renderToStaticMarkup(
    React.createElement(views.RecommendationRowView, {
      state: readyState(fixtures, "popular"),
      retry: () => {},
      navigate: () => {},
    }),
  );
  assert.match(html, /Popular picks/, "fallback section label");
  assert.match(html, /Popular pick/, "fallback card reasons");
  assert.doesNotMatch(html, /Because you favourited/, "fallback never claims a favourite signal");
});

test("degraded state is labelled truthfully", async () => {
  const { views, fixtures } = bundles.load();
  const html = renderToStaticMarkup(
    React.createElement(views.RecommendationRowView, {
      state: readyState(fixtures, "degraded"),
      retry: () => {},
      navigate: () => {},
    }),
  );
  assert.match(html, /degraded — the server is serving its last computed list/, "degraded is announced in text");
});

test("provider failure renders a bounded Retry row (Home is not blocked)", async () => {
  const { views } = bundles.load();
  const html = renderToStaticMarkup(
    React.createElement(views.RecommendationRowView, {
      state: { status: "error", data: null, error: "The TorWatch server could not be reached." },
      retry: () => {},
      navigate: () => {},
    }),
  );
  assert.match(html, /Recommendations could not be loaded\. Everything else keeps working\./);
  assert.match(html, /aria-label="Retry recommendations"/, "Retry is a labelled control");
});

test("an older server renders NO recommendation section", async () => {
  const { views } = bundles.load();
  const html = renderToStaticMarkup(
    React.createElement(views.RecommendationRowView, {
      state: { status: "hidden", data: null, error: null },
      retry: () => {},
      navigate: () => {},
    }),
  );
  assert.equal(html.trim(), "", "capability absence means the section does not exist — never a fake row");
});

test("missing artwork and long titles render placeholders without clipping the reason", async () => {
  const { views, fixtures } = bundles.load();
  const html = renderToStaticMarkup(
    React.createElement(views.RecommendationRowView, {
      state: readyState(fixtures, "seeded"),
      retry: () => {},
      navigate: () => {},
    }),
  );
  // The long-title fixture card has no artwork → the sparkle placeholder.
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /line-clamp-2/, "titles clamp; the reason stays readable beneath");
});

test("See-all page shows the full bounded list with truthful empty state", async () => {
  const { views, fixtures } = bundles.load();
  const html = renderToStaticMarkup(
    React.createElement(views.RecommendationsAllPageView, {
      state: readyState(fixtures, "seeded"),
      retry: () => {},
      navigate: () => {},
    }),
  );
  assert.match(html, /aria-label="Dune: Part Two, /, "cards are open-detail controls with titled accessible names");
  assert.match(html, /Filter recommendations by title type/, "desktop type filters are exposed as one labelled control group");
  assert.match(html, />Anime <span/, "mixed recommendation sets can be narrowed to anime");

  const emptyHtml = renderToStaticMarkup(
    React.createElement(views.RecommendationsAllPageView, {
      state: readyState(fixtures, "empty"),
      retry: () => {},
      navigate: () => {},
    }),
  );
  assert.match(emptyHtml, /No recommendations right now/, "truthful empty state");
});
