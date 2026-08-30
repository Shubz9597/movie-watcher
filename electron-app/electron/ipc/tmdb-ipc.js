const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const SAFE_PATH = /^\/[a-z0-9_/-]+$/i;

function requestError(message, status = 0, requiresSetup = false) {
  return { ok: false, error: message, status, requiresSetup };
}

export function registerTmdbIpc(ipcMain, {
  getCredentials,
  getCatalogState,
  publishCatalogState,
  requireTmdbSetup,
  tmdbFetch = fetch,
}) {
  ipcMain.handle("catalog:get-state", () => getCatalogState());

  ipcMain.handle("tmdb:request", async (_event, request = {}) => {
    const requestPath = String(request.path || "").trim();
    if (!SAFE_PATH.test(requestPath)) {
      return requestError("TMDb request path is invalid.", 400);
    }

    const { tmdbAccessToken, tmdbApiKey } = getCredentials();
    if (!tmdbAccessToken && !tmdbApiKey) {
      const message = "Add a TMDb API key or read access token to continue.";
      requireTmdbSetup(message);
      return requestError(message, 401, true);
    }

    const url = new URL(`${TMDB_BASE_URL}${requestPath}`);
    const params = request.params && typeof request.params === "object" ? request.params : {};
    for (const [key, value] of Object.entries(params).slice(0, 30)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = { Accept: "application/json" };
    if (tmdbAccessToken) headers.Authorization = `Bearer ${tmdbAccessToken}`;
    else url.searchParams.set("api_key", tmdbApiKey);

    let response;
    try {
      response = await tmdbFetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      const message = error?.code === "TMDB_UNREACHABLE"
        ? error.message
        : "TMDb could not be reached. Check your internet connection and try again.";
      return requestError(message);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const message = "TMDb rejected the saved credential. Enter a replacement to continue.";
        requireTmdbSetup(message);
        return requestError(message, response.status, true);
      }
      if (response.status === 429 || response.status >= 500) {
        const message = `TMDb is unavailable (HTTP ${response.status}). Try again to continue.`;
        return requestError(message, response.status);
      }
      return requestError(`TMDb request failed (HTTP ${response.status}).`, response.status);
    }

    try {
      const data = await response.json();
      publishCatalogState({ status: "ready", issue: "" });
      return { ok: true, data, status: response.status };
    } catch {
      return requestError("TMDb returned an unreadable response.", response.status);
    }
  });
}
