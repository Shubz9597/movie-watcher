import assert from "node:assert/strict";
import test from "node:test";

import { verifyTmdbConnection } from "../electron/config/setup-validation.js";
import { createTmdbTransport } from "../electron/config/tmdb-transport.js";

function vpnNotConfigured() {
  const error = new Error("No embedded VPN");
  error.code = "VPN_NOT_CONFIGURED";
  return error;
}

test("TMDb transport keeps a direct server response when no embedded VPN exists", async () => {
  const directResponse = new Response("blocked", { status: 500 });
  let proxySessionRequested = false;
  const transport = createTmdbTransport({
    directFetch: async () => directResponse,
    ensureProxyReady: async () => { throw vpnNotConfigured(); },
    getProxySession: async () => {
      proxySessionRequested = true;
      return { fetch: async () => new Response("ok") };
    },
  });

  assert.equal(await transport.fetch("https://example.test"), directResponse);
  assert.equal(proxySessionRequested, false);
});

test("TMDb transport classifies a direct network failure without Gluetun as unreachable", async () => {
  const connectionReset = new TypeError("fetch failed");
  connectionReset.cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
  const transport = createTmdbTransport({
    directFetch: async () => { throw connectionReset; },
    ensureProxyReady: async () => { throw vpnNotConfigured(); },
    getProxySession: async () => { throw new Error("must not run"); },
  });

  await assert.rejects(
    transport.fetch("https://example.test"),
    (error) => error.code === "TMDB_UNREACHABLE" && /current network connection/i.test(error.message),
  );
});

test("TMDb transport reports an unreachable service when the Gluetun retry also resets", async () => {
  const connectionReset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
  const transport = createTmdbTransport({
    directFetch: async () => { throw connectionReset; },
    ensureProxyReady: async () => {},
    getProxySession: async () => ({
      fetch: async () => { throw connectionReset; },
    }),
  });

  await assert.rejects(
    transport.fetch("https://example.test"),
    (error) => error.code === "TMDB_UNREACHABLE" && /through the VPN/i.test(error.message),
  );
});

test("TMDb transport retries 5xx through Gluetun when it is configured", async () => {
  let fallbackMessage = "";
  const transport = createTmdbTransport({
    directFetch: async () => new Response("blocked", { status: 500 }),
    ensureProxyReady: async () => {},
    getProxySession: async () => ({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
    onFallback: (message) => { fallbackMessage = message; },
  });

  const response = await transport.fetch("https://example.test");
  assert.equal(response.status, 200);
  assert.match(fallbackMessage, /Retrying through VPN/i);
});

test("TMDb verification distinguishes credentials from availability", async () => {
  await assert.rejects(
    verifyTmdbConnection({}),
    (error) => error.code === "TMDB_CREDENTIAL_MISSING",
  );
  await assert.rejects(
    verifyTmdbConnection({ tmdbApiKey: "bad" }, { fetch: async () => new Response("", { status: 401 }) }),
    (error) => error.code === "TMDB_CREDENTIAL_REJECTED",
  );
  await assert.rejects(
    verifyTmdbConnection({ tmdbApiKey: "saved" }, { fetch: async () => new Response("", { status: 500 }) }),
    (error) => error.code === "TMDB_REQUEST_FAILED",
  );
});
