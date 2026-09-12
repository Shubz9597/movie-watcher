// LibraryToggle component fixtures (feature 002 M3.3): the REAL shared
// toggle rendered through the real LibraryContext with the deterministic
// fixture library states — accessible names, aria-pressed, 48px targets,
// pending (aria-busy), error/retry markup, and flag independence.
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

function buildToggles() {
  const outDir = path.resolve("node_modules", ".library-toggle-fixture");
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, "library-toggle.cjs");
  esbuild.buildSync({
    stdin: {
      contents: `
        import { LibraryToggle } from "${appRoot.replace(/\\/g, "/")}/src/components/shared/LibraryToggle";
        import { LibraryContextProvider } from "${appRoot.replace(/\\/g, "/")}/src/lib/library-react";
        export { LibraryToggle, LibraryContextProvider };
      `,
      resolveDir: appRoot,
      loader: "tsx",
    },
    outfile,
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "node",
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

function buildFixtureStore() {
  const outDir = path.resolve("node_modules", ".library-toggle-fixture");
  const outfile = path.join(outDir, "fixture-store.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(appRoot, "src", "platform", "library-fixtures.ts")],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    external: ["react", "react/jsx-runtime"],
    logLevel: "silent",
  });
  return nodeRequire(outfile);
}

const toggles = buildToggles();
const fixtureStore = buildFixtureStore();
process.on("exit", () => toggles.cleanup());

const DUNE = "tmdb:movie:693134";

async function settle(ms = 600) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function render({ LibraryToggle, LibraryContextProvider }, store, field) {
  return renderToStaticMarkup(
    React.createElement(
      LibraryContextProvider,
      { store },
      React.createElement(LibraryToggle, { canonicalId: DUNE, field }),
    ),
  );
}

test("LibraryToggle exposes an accessible name, aria-pressed and the shared 48px target", async () => {
  const t = toggles.load();
  const { createLibraryStateFixture } = fixtureStore;
  const store = createLibraryStateFixture("populated");
  // Preseeded fixture membership: tmdb:movie:693134 is in Watch Later only.
  const watchLater = render(t, store, "watch-later");
  assert.match(watchLater, /aria-pressed="true"/, "active flag reads as pressed");
  assert.match(watchLater, /aria-label="Remove from Watch Later"/);
  assert.match(watchLater, /min-h-\[var\(--touch-target\)\]/, "48px target from the shared token");
  assert.match(watchLater, /focus-visible:ring-2/, "shared focus treatment");
  assert.match(watchLater, /fill-current/, "active state is visible beyond color");

  const favourite = render(t, store, "favourites");
  assert.match(favourite, /aria-pressed="false"/, "the other flag stays independent");
  assert.match(favourite, /aria-label="Mark as Favourite"/);
  assert.doesNotMatch(favourite, /fill-current/, "inactive favourite is not filled");
});

test("LibraryToggle renders the pending state with aria-busy and announced copy", async () => {
  const t = toggles.load();
  const { createLibraryStateFixture } = fixtureStore;
  const store = createLibraryStateFixture("write-pending");
  // The fixture preseeds the title in Watch Later, so the toggle's target is
  // removal — the pending copy names the in-flight intent either way.
  store.toggle(DUNE, "watch-later");
  const html = render(t, store, "watch-later");
  assert.match(html, /aria-busy="true"/, "pending is announced, not just animated");
  assert.match(html, /(Saving to Watch Later|Removing from Watch Later)/, "pending copy is truthful text");
  assert.match(html, /aria-live="polite"/, "state changes reach screen readers");
});

test("LibraryToggle renders failure with a retry affordance and truthful error copy", async () => {
  const t = toggles.load();
  const { createLibraryStateFixture } = fixtureStore;
  const store = createLibraryStateFixture("write-failure");
  store.toggle(DUNE, "watch-later");
  await settle();
  const html = render(t, store, "watch-later");
  assert.match(html, /Watch Later save failed — activate to retry/, "failure names the retry action");
  assert.match(html, /aria-pressed="true"/, "confirmed server state is restored after failure (the removal did not happen)");
  assert.match(html, /ring-red/, "the failure is also visible beyond text");
  assert.match(html, /role="status"/, "state changes are announced to screen readers");
  assert.match(html, /Activate the control to retry/, "screen-reader copy includes the retry instruction");
});

test("both LibraryToggle flags render independently for the same title", async () => {
  const t = toggles.load();
  const { createLibraryStateFixture } = fixtureStore;
  const store = createLibraryStateFixture("populated");
  store.toggle(DUNE, "favourites");
  await settle();
  const watchLater = render(t, store, "watch-later");
  const favourite = render(t, store, "favourites");
  assert.match(watchLater, /aria-pressed="true"/, "watch-later untouched by the favourite write");
  assert.match(favourite, /aria-pressed="true"/, "favourite now active");
});
