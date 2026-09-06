# M1.1 adapter dependency map (shared mobile alpha)

Recorded: 2026-09-06 from the current working tree. Task: document every Electron/browser/provider dependency on the shared import graph plus the adapter signatures M1.2 must inject. No source was changed for this map (docs + existing characterization only).

## Direct `window.electronAPI` usage (must route through the Electron adapter)

| File | Usage | Port required |
|---|---|---|
| `src/App.tsx:58` | startup/config bridge | connection/config |
| `src/pages/PlayerPage.tsx` | `onMpvStopped`, `debugLog`, `playInMpv`, `stopMpv` | player (desktop MPV) |
| `src/pages/WatchPage.tsx:22,114,131` | bridge reads for watch flow | player/navigation |
| `src/components/EpisodePanelWrapper.tsx:107,627,907` | `isElectron` gating, `openSetup` | desktop chrome, config |
| `src/components/TorrentPanel.tsx:71,244,256,354` | `isElectron`, `debugLog`, playback start, `openSetup` | player, desktop chrome |
| `src/components/GlobalSearch.tsx:491`, `AppHeader.tsx:124`, `RuntimeStatusBar.tsx:9,31,69`, `HomePage.tsx:641,655`, `SeeAllPage.tsx:185` | `openSetup`, runtime status subscriptions | desktop chrome/config subscription |
| `src/components/TmdbConnectionGate.tsx:16,24,88` | `repairTmdb`, `openTmdbGuide` | provider credentials (desktop-only; phone never configures provider secrets) |
| `src/lib/services/tmdb-service.ts:23` | `requestTmdb` IPC transport (renderer mode only; now lazily imported) | legacy provider transport |

No static `import 'electron'`/Node built-ins exist in `src/**` (grep clean) — the renderer graph is browser-plausible except for the global accesses above.

## Import-time server origins / module-load state (M1.2 injection targets)

- `src/lib/api-client.ts:8` — `VOD_BASE` resolved once at module import via `backend-origin.mjs` (`build-time default http://localhost:4001`, `VITE_TORWATCH_BACKEND_URL` override). Violates "shared services must not read a mutable origin once at module import"; M1.2 must inject the origin/connection service and invalidate caches on change.
- `src/lib/api-client.ts:4` — `API_BASE = 'http://localhost:3000'` (legacy Next.js remnant; `apiFetch`/`getApiBase` consumers to inventory at M1.2; T066 removal candidate).
- `src/lib/device-id.ts` — `window.localStorage` at call time (device storage port: stable clientId, failure surfaced).
- `src/lib/catalog-source.ts` — `window.localStorage` override + async config IPC via `./config` (flag storage must become part of the connection/config adapter).
- CSP/connect-src in `src/index.html` (and setup/startup/player-controls entries) — mobile build needs matching origins without Electron assumptions.

## Existing characterization (M1.1 inventory)

- `scripts/characterization/api-client.test.mjs` — base URL resolution (T017).
- `scripts/characterization/catalog-gateway.test.mjs` — flag dispatch, bff client contracts, detail/season/genre/pagination mapping, continue-enrichment mapping (extended in T042.2).
- `scripts/characterization/version-check.test.mjs` — negotiation gating (T048).
- `scripts/characterization/catalog-merge.test.mjs`, `anime-matching.test.mjs` — merge/tie-break locks.
- Missing (failing-meaningfully characterization to add during M1.2 implementation): connection-state machine (checking/ready/unreachable/incompatible), origin-switch cache invalidation, device-storage failure surfacing. These require the adapter contracts to exist first (they are the thing M1.2 defines), so they are recorded as the first code change of M1.2, not as pre-existing gaps that block M1.1.

## Adapter port signatures (logical contracts; finalize types in M1.2 code)

- `ConnectionConfig`: `loadOrigin()`, `saveOrigin(origin)` (validated), `status(): checking|ready|unreachable|incompatible`, `version fetch without Electron prerequisites`, `subscribe(onChange)` — on change: cancel in-flight, end lease, clear origin-scoped caches.
- `DeviceStorage`: `getClientId()` (stable UUID), `get/setPreference(key)`, storage failure surfaced; no provider credentials; cache keys include origin.
- `Player`: `start(resolvedContext)`, `stop/seek/pause`, events `position|state|subtitle`, `capability(): supported|unknown|unsupported` per media, deterministic cleanup.
- `NavigationLifecycle`: system back, focus/visibility, keyboard, restore stack/scroll/filter.
- `DesktopChrome` (Electron-only): window actions, MPV host binding, `openSetup`, TMDB repair — optional, injected only for Electron.
- `TestFixtureProvider`: same shapes; production builds cannot silently select it.

## Next task

M1.2: implement `src/platform/contracts.ts`, `electron.ts`, `fixtures.ts`, shared composition root, and a separate browser-safe build entry (`vite.config.js` output separation), migrating the call sites above behind the ports without changing Electron behavior. Hardware-dependent M1.3/M1.4 remain open (no iPhone in this session).
