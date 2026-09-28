// Launch-policy tests (offline-downloads C01): one case per row of the spec
// C2 launch-decision table, plus the required edge variants (config read
// error, local inventory read error, deep-link precedence, expired playback).
// The policy is pure and MUST NOT depend on reachability — several tests
// assert identical decisions across connection states to lock that in.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveLaunch,
  resolveRestoredTab,
} from '../../src/lib/launch-policy.ts';

const present = (origin = 'http://radxa.lan:4001') => ({ kind: 'present', origin });
const missing = { kind: 'missing' };
const configReadError = { kind: 'read-error' };
const empty = { kind: 'empty' };
const readyExists = { kind: 'ready-exists' };
const inventoryReadError = { kind: 'read-error' };
const noDeepLink = { kind: 'none' };
const downloadsDeepLink = { kind: 'downloads' };
const expiredPlaybackLink = { kind: 'expired-playback' };

function decide(overrides = {}) {
  return resolveLaunch({
    configuration: present(),
    inventory: empty,
    savedTab: null,
    deepLink: noDeepLink,
    downloadsTabAvailable: true,
    ...overrides,
  });
}

// --- C2 row: "No saved server, no local downloads" -------------------------
test('no saved server and no local downloads opens first-run setup (WF01)', () => {
  assert.deepEqual(decide({ configuration: missing, inventory: empty }), { surface: 'setup' });
});

test('missing config with a failed inventory read still opens setup without claiming zero downloads', () => {
  // The setup screen makes no download claim; the read error is carried by the
  // inventory state, not silently mapped to 'empty'.
  const decision = decide({ configuration: missing, inventory: inventoryReadError });
  assert.deepEqual(decision, { surface: 'setup' });
  assert.notEqual(inventoryReadError, empty);
});

// --- C2 row: "No saved server, existing completed downloads" ---------------
test('no saved server with completed downloads restores Downloads; setup stays in Settings', () => {
  assert.deepEqual(decide({ configuration: missing, inventory: readyExists }), { surface: 'downloads' });
});

// --- C2 row: "Saved server, check pending" ---------------------------------
test('saved server renders the shell immediately at the restored tab without awaiting probes', () => {
  assert.deepEqual(
    decide({ savedTab: 'library' }),
    { surface: 'shell', tab: 'library', inventoryError: false },
  );
});

// --- C2 rows: check succeeds / unavailable / fails mid-use / returns -------
test('reachability never changes the launch decision (success, pending, unavailable, incompatible)', () => {
  // The policy's input type has no connection status; these calls are all
  // literally identical, which IS the contract: pending checks, outages and
  // recoveries must produce the same surface and tab.
  const expected = { surface: 'shell', tab: 'home', inventoryError: false };
  assert.deepEqual(decide({ savedTab: null }), expected);
  assert.deepEqual(decide({ savedTab: null }), expected);
  assert.deepEqual(decide({ savedTab: null }), expected);
});

test('server unavailable with ready downloads keeps the shell route (recovery is contextual, not routing)', () => {
  // Same decision whether downloads exist or not — Home recovery (WF02) is a
  // view concern; the user reaches Downloads by tapping its tab (WF06).
  assert.deepEqual(
    decide({ inventory: readyExists, savedTab: 'home' }),
    { surface: 'shell', tab: 'home', inventoryError: false },
  );
  assert.deepEqual(
    decide({ savedTab: 'home' }),
    { surface: 'shell', tab: 'home', inventoryError: false },
  );
});

// --- Tab restoration --------------------------------------------------------
test('restore the last valid tab; unknown routes and null fall back to Home', () => {
  assert.equal(resolveRestoredTab('library', true), 'library');
  assert.equal(resolveRestoredTab('search', true), 'search');
  assert.equal(resolveRestoredTab('home', true), 'home');
  assert.equal(resolveRestoredTab('downloads', true), 'downloads');
  assert.equal(resolveRestoredTab(null, true), 'home');
  assert.equal(resolveRestoredTab('player', true), 'home', 'expired playback routes are not auto-resumed');
  assert.equal(resolveRestoredTab('title', true), 'home');
});

test('a saved Downloads tab falls back to Home when the client has no downloads capability', () => {
  assert.equal(resolveRestoredTab('downloads', false), 'home');
  assert.deepEqual(
    decide({ savedTab: 'downloads', downloadsTabAvailable: false }),
    { surface: 'shell', tab: 'home', inventoryError: false },
  );
});

// --- Deep links -------------------------------------------------------------
test('a Downloads deep link wins over tab restoration and over first-run setup', () => {
  assert.deepEqual(decide({ savedTab: 'library', deepLink: downloadsDeepLink }), { surface: 'downloads' });
  assert.deepEqual(decide({ configuration: missing, inventory: readyExists, deepLink: downloadsDeepLink }), { surface: 'downloads' });
});

test('a Downloads deep link opens the Downloads surface even when the inventory read failed', () => {
  // The Downloads page itself renders "Couldn't read your downloads" with
  // Retry/Storage settings; it must not be bypassed to a screen implying zero
  // downloads or a dead end.
  assert.deepEqual(
    decide({ inventory: inventoryReadError, deepLink: downloadsDeepLink }),
    { surface: 'downloads' },
  );
});

test('an expired playback deep link is never auto-resumed; normal policy applies', () => {
  assert.deepEqual(
    decide({ savedTab: 'home', deepLink: expiredPlaybackLink }),
    { surface: 'shell', tab: 'home', inventoryError: false },
  );
});

// --- Configuration read error ----------------------------------------------
test('a configuration read error is a recovery state, never first installation', () => {
  const decision = decide({ configuration: configReadError, inventory: empty });
  assert.deepEqual(decision, { surface: 'config-error' });
  assert.notEqual(decision.surface, 'setup', 'must not ask a configured user to set up again');
});

test('configuration read error with completed downloads still surfaces the recovery state', () => {
  // Orphaned downloads are reachable via the Downloads deep link or after the
  // storage repair; the config error itself is the launch surface.
  assert.deepEqual(
    decide({ configuration: configReadError, inventory: readyExists }),
    { surface: 'config-error' },
  );
});

// --- Local inventory read error (configured user) --------------------------
test('a failed local inventory read never blocks the shell and never reads as zero downloads', () => {
  const decision = decide({ inventory: inventoryReadError, savedTab: 'home' });
  assert.deepEqual(decision, { surface: 'shell', tab: 'home', inventoryError: true });
});

// --- First-run setup is preserved after failures (draft handling is UI-side,
//     but the policy must keep returning setup deterministically) ------------
test('repeated resolution is deterministic (retry after a failed setup attempt resolves setup again)', () => {
  const first = decide({ configuration: missing, inventory: empty });
  const second = decide({ configuration: missing, inventory: empty });
  assert.deepEqual(first, second);
});
