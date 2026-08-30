const FALLBACK_STATUS_CODES = new Set([429]);

function shouldUseVpnFallback(response) {
  return FALLBACK_STATUS_CODES.has(response.status) || response.status >= 500;
}

export function createTmdbTransport({
  directFetch = globalThis.fetch,
  ensureProxyReady,
  getProxySession,
  onFallback = () => {},
}) {
  async function fetchThroughVpn(input, init, directFailure, directResponse = null) {
    try {
      await ensureProxyReady();
      onFallback("TMDb is not reachable directly. Retrying through VPN…");
      const proxySession = await getProxySession();
      return await proxySession.fetch(input, {
        ...init,
        // A direct timeout aborts its signal permanently. The VPN attempt
        // needs a fresh deadline instead of inheriting that aborted signal.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (proxyFailure) {
      // A host/system VPN is already part of the direct route. If no embedded
      // tunnel is configured, keep an HTTP response from that route instead of
      // replacing it with a misleading VPN or credential error.
      if (proxyFailure?.code === "VPN_NOT_CONFIGURED" && directResponse) {
        return directResponse;
      }
      const error = new Error(
        proxyFailure?.code === "VPN_NOT_CONFIGURED"
          ? "TMDb could not be reached through the current network connection."
          : "TMDb could not be reached directly or through the VPN.",
        { cause: proxyFailure },
      );
      error.code = "TMDB_UNREACHABLE";
      error.directFailure = directFailure;
      throw error;
    }
  }

  return {
    async fetch(input, init) {
      let directResponse;
      try {
        directResponse = await directFetch(input, init);
      } catch (directFailure) {
        return fetchThroughVpn(input, init, directFailure);
      }

      if (!shouldUseVpnFallback(directResponse)) return directResponse;
      return fetchThroughVpn(input, init, directResponse.status, directResponse);
    },
  };
}
