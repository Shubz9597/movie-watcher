import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_SUPPORTED_PROTOCOL_RANGE,
  ProtocolMismatchError,
  ensureServerCompatible,
  fetchServerVersion,
  highestMutualProtocol,
  rangesOverlap,
  resetVersionCheckCache,
} from "../../src/lib/version-check.ts";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("range overlap and highest-mutual-protocol helpers follow the contract", () => {
  assert.equal(rangesOverlap([1, 1], CLIENT_SUPPORTED_PROTOCOL_RANGE), true);
  assert.equal(rangesOverlap([1, 3], CLIENT_SUPPORTED_PROTOCOL_RANGE), true);
  assert.equal(rangesOverlap([2, 3], CLIENT_SUPPORTED_PROTOCOL_RANGE), false, "newer server, no overlap");
  assert.equal(rangesOverlap(null, CLIENT_SUPPORTED_PROTOCOL_RANGE), false);
  assert.equal(highestMutualProtocol([1, 3], [1, 1]), 1, "highest mutually supported");
  assert.equal(highestMutualProtocol([2, 3], [1, 1]), null);
});

test("compatible server ranges never block workflows regardless of app versions", async () => {
  resetVersionCheckCache();
  // Deliberately absurd application version on BOTH sides: compatibility is
  // decided by protocol ranges only (FR-011 rule 5).
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    assert.ok(String(url).includes("/v1/version"), "negotiation must consult version discovery");
    return jsonResponse(200, {
      serverVersion: "0.0.1-ancient",
      protocolVersion: 1,
      supportedProtocolRange: [1, 1],
      capabilities: ["catalog.bff.v2"],
    });
  };
  await ensureServerCompatible({ fetchImpl });
  assert.equal(requests, 1);

  resetVersionCheckCache();
  await ensureServerCompatible({ fetchImpl: async () => jsonResponse(200, {
    serverVersion: "99.0.0-future",
    protocolVersion: 1,
    supportedProtocolRange: [1, 2],
    capabilities: [],
  }) });
});

test("non-overlapping server ranges block only the incompatible workflow with an actionable message", async () => {
  resetVersionCheckCache();
  const fetchImpl = async () => jsonResponse(200, {
    serverVersion: "3.0.0",
    protocolVersion: 3,
    supportedProtocolRange: [2, 3],
    capabilities: [],
  });
  await assert.rejects(
    ensureServerCompatible({ fetchImpl }),
    (error) => {
      assert.ok(error instanceof ProtocolMismatchError);
      assert.match(error.message, /protocol range/);
      assert.match(error.message, /Upgrade TorWatch/);
      assert.deepEqual(error.serverRange, [2, 3]);
      assert.deepEqual(error.clientRange, [1, 1]);
      return true;
    },
  );
});

test("missing or unreachable version endpoints fail open for pre-P1 backends", async () => {
  resetVersionCheckCache();
  await ensureServerCompatible({ fetchImpl: async () => jsonResponse(404, { error: { code: "not_found" } }) });

  resetVersionCheckCache();
  await ensureServerCompatible({ fetchImpl: async () => { throw new Error("connection refused"); } });

  resetVersionCheckCache();
  await ensureServerCompatible({ fetchImpl: async () => jsonResponse(200, { serverVersion: "1.0.0" }) });
});

test("version discovery itself stays accessible and cacheable", async () => {
  resetVersionCheckCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { serverVersion: "2.0.0", protocolVersion: 1, supportedProtocolRange: [1, 1] });
  };
  const first = await fetchServerVersion({ fetchImpl });
  const second = await fetchServerVersion({ fetchImpl });
  assert.equal(first.serverVersion, "2.0.0");
  assert.equal(second.serverVersion, "2.0.0");
  assert.equal(calls, 1, "version payload is cached per session");
  resetVersionCheckCache();
});
