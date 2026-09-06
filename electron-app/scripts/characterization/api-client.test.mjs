import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BACKEND_ORIGIN,
  resolveBackendOrigin,
} from "../../backend-origin.mjs";
import {
  buildBackendUrl,
  getApiBase,
  getVodBase,
} from "../../src/lib/api-client.ts";

test("backend origin defaults to the V1 launch contract origin", () => {
  assert.equal(DEFAULT_BACKEND_ORIGIN, "http://localhost:4001");
  assert.equal(resolveBackendOrigin(), "http://localhost:4001");
  assert.equal(resolveBackendOrigin({}), "http://localhost:4001");
  assert.equal(resolveBackendOrigin({ BACKEND_URL: "" }), "http://localhost:4001");
  assert.equal(resolveBackendOrigin({ BACKEND_URL: "   " }), "http://localhost:4001");
});

test("backend origin honors BACKEND_URL and VITE_TORWATCH_BACKEND_URL overrides", () => {
  assert.equal(
    resolveBackendOrigin({ BACKEND_URL: "http://192.168.1.10:4001" }),
    "http://192.168.1.10:4001",
  );
  assert.equal(
    resolveBackendOrigin({ VITE_TORWATCH_BACKEND_URL: "https://torwatch.lan" }),
    "https://torwatch.lan",
  );
  assert.equal(
    resolveBackendOrigin({ BACKEND_URL: "http://override:4001", VITE_TORWATCH_BACKEND_URL: "http://ignored:4001" }),
    "http://override:4001",
    "BACKEND_URL takes precedence over the renderer build-time override",
  );
});

test("backend origin override strips trailing slashes", () => {
  assert.equal(resolveBackendOrigin({ BACKEND_URL: "http://host:4001///" }), "http://host:4001");
});

test("api-client exposes the resolved origin and joins request paths", () => {
  assert.equal(getVodBase(), "http://localhost:4001", "renderer default must be byte-identical to V1");
  assert.equal(buildBackendUrl("/v1/continue"), "http://localhost:4001/v1/continue");
  assert.equal(buildBackendUrl("v1/continue"), "http://localhost:4001/v1/continue");
});

test("api-client keeps the legacy Next.js API base untouched (P8 removal scope)", () => {
  assert.equal(getApiBase(), "http://localhost:3000");
});
