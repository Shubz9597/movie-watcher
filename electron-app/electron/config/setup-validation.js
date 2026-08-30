import crypto from "crypto";
import fs from "fs";
import path from "path";

export function verifyStorageDirectory(dataDir) {
  const requested = String(dataDir || "").trim();
  if (!requested) throw new Error("Choose a storage folder.");
  const resolved = path.resolve(requested);
  fs.mkdirSync(resolved, { recursive: true });
  const probe = path.join(resolved, `.torwatch-write-test-${process.pid}-${crypto.randomBytes(5).toString("hex")}`);
  try {
    fs.writeFileSync(probe, "TorWatch storage check", { encoding: "utf8", flag: "wx" });
  } finally {
    try { fs.unlinkSync(probe); } catch {}
  }
}

export async function verifyTmdbConnection({ tmdbAccessToken, tmdbApiKey }, options = {}) {
  const accessToken = String(tmdbAccessToken || "").trim().replace(/^Bearer\s+/i, "").trim();
  const apiKey = String(tmdbApiKey || "").trim();
  if (!accessToken && !apiKey) {
    const error = new Error("Enter a TMDb access token or API key.");
    error.code = "TMDB_CREDENTIAL_MISSING";
    throw error;
  }
  const url = new URL("https://api.themoviedb.org/3/configuration");
  const headers = { Accept: "application/json" };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    url.searchParams.set("api_key", apiKey);
  }
  let response;
  try {
    const request = options.fetch || fetch;
    response = await request(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    if (cause?.code === "TMDB_UNREACHABLE") throw cause;
    const error = new Error("TMDb could not be reached. Check your internet connection and try again.", { cause });
    error.code = "TMDB_UNREACHABLE";
    throw error;
  }
  if (!response.ok) {
    const credentialRejected = response.status === 401 || response.status === 403;
    const error = new Error(credentialRejected
      ? "TMDb rejected this credential. Check the token or API key."
      : `TMDb is unavailable (HTTP ${response.status}). Try again in a moment.`);
    error.code = credentialRejected ? "TMDB_CREDENTIAL_REJECTED" : "TMDB_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
}

export async function verifyOpenSubtitlesConnection({ openSubApiKey, openSubUserToken }) {
  if (!openSubApiKey && openSubUserToken) {
    throw new Error("An OpenSubtitles API key is required when a user token is provided.");
  }
  if (!openSubApiKey) return false;

  const headers = {
    Accept: "application/json",
    "Api-Key": openSubApiKey,
    "User-Agent": "TorWatch v1.2",
  };
  const languagesResponse = await fetch("https://api.opensubtitles.com/api/v1/infos/languages", {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!languagesResponse.ok) {
    throw new Error(languagesResponse.status === 401 || languagesResponse.status === 403
      ? "OpenSubtitles rejected this API key."
      : "OpenSubtitles could not be reached. Check your internet connection and try again.");
  }

  if (openSubUserToken) {
    const userResponse = await fetch("https://api.opensubtitles.com/api/v1/infos/user", {
      headers: { ...headers, Authorization: `Bearer ${openSubUserToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!userResponse.ok) {
      throw new Error(userResponse.status === 401 || userResponse.status === 403
        ? "OpenSubtitles accepted the API key but rejected the user token."
        : "OpenSubtitles could not check the user token. Try again later.");
    }
  }
  return true;
}
