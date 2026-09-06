// Single source of truth for the TorWatch backend origin.
// Consumed by the renderer (via src/lib/api-client.ts), the Electron main
// process (via electron/playback/constants.js), and the Vite CSP injection
// (vite.config.js). Override with the BACKEND_URL environment variable
// (main/build) or VITE_TORWATCH_BACKEND_URL (renderer build).
export const DEFAULT_BACKEND_ORIGIN = "http://localhost:4001";

export function resolveBackendOrigin(env = {}) {
  const override = String(env.BACKEND_URL ?? env.VITE_TORWATCH_BACKEND_URL ?? "").trim();
  if (override === "") {
    return DEFAULT_BACKEND_ORIGIN;
  }
  return override.replace(/\/+$/, "");
}
