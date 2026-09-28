// Connection-coordinator tests (offline-downloads C02): deduplicated checks,
// generation guards, probe-first save, protocol verification separate from
// optional capabilities, active-URL preservation on failed edits, and
// persistence readback/restore.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectionCoordinator,
  probeServer,
} from '../../src/lib/connection-coordinator.ts';

const ORIGIN = 'http://radxa.lan:4001';

function versionResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function fetchJson(handler) {
  return async (url) => {
    const path = new URL(url, 'http://probe.invalid').pathname;
    return handler(path, url);
  };
}

const okVersion = (capabilities = [], range = [1, 1]) =>
  fetchJson((path) => {
    if (path === '/readyz') return { ok: true, status: 200 };
    if (path === '/v1/version') return versionResponse({ serverVersion: '2.0.0', supportedProtocolRange: range, capabilities });
    return { ok: false, status: 404 };
  });

// --- probeServer -------------------------------------------------------------
test('probeServer: unreachable (readyz fails) and incompatible (bad version endpoint) stay separate', async () => {
  const down = await probeServer(fetchJson(() => ({ ok: false, status: 503 })), ORIGIN);
  assert.equal(down.kind, 'unreachable');
  const bad = await probeServer(fetchJson((path) => (path === '/readyz' ? { ok: true, status: 200 } : { ok: false, status: 404 })), ORIGIN);
  assert.equal(bad.kind, 'incompatible');
});

test('probeServer: protocol compatibility is verified separately from optional capabilities', async () => {
  const missingOptional = await probeServer(okVersion([]), ORIGIN);
  assert.equal(missingOptional.kind, 'ready');
  assert.equal(missingOptional.protocolCompatible, true, 'missing optional capability is NOT an incompatibility');
  assert.deepEqual(missingOptional.capabilities, []);

  const futureRange = await probeServer(okVersion(['downloads.offline.v1'], [9, 9]), ORIGIN);
  assert.equal(futureRange.kind, 'ready');
  assert.equal(futureRange.protocolCompatible, false, 'protocol range mismatch IS an incompatibility');
  assert.deepEqual(futureRange.capabilities, ['downloads.offline.v1'], 'capabilities still reported');
});

test('probeServer: a server without a protocol range fails open (pre-P1 compatibility)', async () => {
  const result = await probeServer(fetchJson((path) => (path === '/readyz' ? { ok: true, status: 200 } : versionResponse({ capabilities: [] }))), ORIGIN);
  assert.equal(result.kind, 'ready');
  assert.equal(result.protocolCompatible, true);
});

// --- check(): deduplication and generation guard ------------------------------
test('check(): concurrent checks share one in-flight probe', async () => {
  const coordinator = new ConnectionCoordinator();
  let readyzCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowFetch = async (url) => {
    const path = new URL(url, 'http://probe.invalid').pathname;
    if (path === '/readyz') {
      readyzCount += 1;
      await gate;
    }
    return okVersion([])(url);
  };
  const first = coordinator.check(ORIGIN, true, slowFetch);
  const second = coordinator.check(ORIGIN, true, slowFetch);
  release();
  await Promise.all([first, second]);
  assert.equal(readyzCount, 1, 'the second concurrent check must reuse the in-flight probe');
});

test('check(): a probe superseded by a newer generation commits nothing', async () => {
  const coordinator = new ConnectionCoordinator();
  let releaseStale;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  const fetchImpl = async (url) => {
    const target = new URL(url, 'http://probe.invalid');
    if (target.host === 'stale.lan' && target.pathname === '/readyz') {
      await staleGate; // the stale probe is still in flight when the newer one completes
    }
    return okVersion([])(url);
  };
  const stale = coordinator.check('http://stale.lan:4001', true, fetchImpl);
  // A newer check for a different origin supersedes the stale one and commits.
  await coordinator.check(ORIGIN, true, fetchImpl);
  releaseStale();
  await stale.catch(() => undefined);
  assert.equal(coordinator.getState().origin, ORIGIN, 'the superseded probe must not overwrite the newer commit');
});

test('check(): emits checking then commits the probe result', async () => {
  const coordinator = new ConnectionCoordinator();
  const events = [];
  coordinator.subscribe((state) => events.push(state.status));
  await coordinator.check(ORIGIN, true, okVersion(['downloads.offline.v1']));
  assert.deepEqual(events, ['checking', 'ready']);
  const state = coordinator.getState();
  assert.equal(state.configured, true);
  assert.deepEqual(state.capabilities, ['downloads.offline.v1']);
  assert.equal(state.protocolCompatible, true);
});

// --- save(): probe-first, durable, preserves active URL -----------------------
function saveDeps(overrides = {}) {
  const persisted = new Map(overrides.existing ? [['mw_server_origin', overrides.existing]] : []);
  return {
    deps: {
      persist: (origin) => { persisted.set('mw_server_origin', origin); },
      readPersisted: () => persisted.get('mw_server_origin') ?? null,
      activeOrigin: overrides.activeOrigin ?? '',
    },
    persisted,
  };
}

const saveIo = (fetchImpl) => ({
  fetchImpl,
  normalize: (raw) => {
    const trimmed = raw.trim().replace(/\/+$/, '');
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
      return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}`;
    } catch {
      return null;
    }
  },
  apply: async () => undefined,
});

test('save(): a syntactically invalid address is rejected without any probe or persistence', async () => {
  const coordinator = new ConnectionCoordinator();
  const { deps } = saveDeps();
  let probed = false;
  const outcome = await coordinator.save('not a url', deps, saveIo(async () => { probed = true; }));
  assert.deepEqual(outcome, { result: 'invalid' });
  assert.equal(probed, false);
  assert.equal(deps.readPersisted(), null);
});

test('save(): an unreachable candidate is blocked before persistence (draft stays a draft)', async () => {
  const coordinator = new ConnectionCoordinator();
  const { deps } = saveDeps();
  const unreachable = fetchJson(() => { throw new TypeError('down'); });
  const outcome = await coordinator.save(ORIGIN, deps, saveIo(unreachable));
  assert.equal(outcome.result, 'blocked-unreachable');
  assert.equal(deps.readPersisted(), null, 'nothing persisted on a failed probe');
});

test('save(): a protocol-incompatible candidate is blocked even with optional capabilities', async () => {
  const coordinator = new ConnectionCoordinator();
  const { deps } = saveDeps();
  const outcome = await coordinator.save(ORIGIN, deps, saveIo(okVersion(['downloads.offline.v1'], [9, 9])));
  assert.equal(outcome.result, 'blocked-incompatible');
  assert.equal(deps.readPersisted(), null);
});

test('save(): a reachable compatible server without optional capabilities saves successfully', async () => {
  const coordinator = new ConnectionCoordinator();
  const { deps } = saveDeps();
  const outcome = await coordinator.save(ORIGIN, deps, saveIo(okVersion([])));
  assert.equal(outcome.result, 'saved');
  assert.equal(outcome.protocolCompatible, true);
  assert.equal(deps.readPersisted(), ORIGIN, 'persisted ONLY after validation');
  assert.equal(coordinator.getState().status, 'ready');
  assert.equal(coordinator.getState().configured, true);
});

test('save(): a failed persistence readback reports blocked-persist-failed', async () => {
  const coordinator = new ConnectionCoordinator();
  const { deps } = saveDeps();
  const outcome = await coordinator.save(ORIGIN, {
    ...deps,
    // Simulate a broken durable store: persist() succeeds but the value is
    // not readable back.
    readPersisted: () => null,
  }, saveIo(okVersion([])));
  assert.equal(outcome.result, 'blocked-persist-failed');
  assert.equal(coordinator.getState().status, 'checking', 'state commits only for a durable save');
});

test('save(): re-saving the active persisted origin probes and reports saved without re-persisting', async () => {
  const coordinator = new ConnectionCoordinator();
  const { deps, persisted } = saveDeps({ existing: ORIGIN, activeOrigin: ORIGIN });
  let persistCalls = 0;
  const outcome = await coordinator.save(ORIGIN, {
    ...deps,
    persist: (origin) => { persistCalls += 1; persisted.set('mw_server_origin', origin); },
  }, saveIo(okVersion([])));
  assert.equal(outcome.result, 'saved');
  assert.equal(persistCalls, 0, 'no redundant persistence for the active origin');
});

// --- commit(): protocol mismatch maps to incompatible ------------------------
test('commit(): a ready probe with an incompatible protocol range surfaces as incompatible', () => {
  const coordinator = new ConnectionCoordinator();
  coordinator.commit({
    kind: 'ready',
    origin: ORIGIN,
    capabilities: ['downloads.offline.v1'],
    protocolCompatible: false,
    supportedProtocolRange: [9, 9],
    serverVersion: '9.0.0',
  }, true);
  const state = coordinator.getState();
  assert.equal(state.status, 'incompatible');
  assert.equal(state.protocolCompatible, false);
  assert.deepEqual(state.capabilities, ['downloads.offline.v1']);
});
