import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DESKTOP_PROTOCOL_RANGE = [1, 1];

export function normalizeDesktopConnection(input) {
  if (input?.mode !== "local" && input?.mode !== "remote") {
    throw new Error("Choose a server on this PC or a homeserver.");
  }
  const raw = String(input.origin || "").trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error("Enter a complete server URL starting with http:// or https://.");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid server URL."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Enter only the server address and port, without a path, password or query.");
  }
  if (input.mode === "local" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("For a server on this PC, use localhost or a loopback address. Choose Homeserver for another computer.");
  }
  const connection = { mode: input.mode, origin: url.origin };
  const progressSubjectId = String(input.progressSubjectId || '').trim();
  if (input.mode === 'remote' && progressSubjectId) {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(progressSubjectId)) throw new Error('Enter the phone viewing profile ID without spaces or punctuation.');
    connection.progressSubjectId = progressSubjectId;
  }
  return connection;
}

export function createDesktopConnectionStore(userDataPath) {
  const filePath = path.join(userDataPath, "desktop-server.json");
  return {
    filePath,
    getClientId() {
      const clientPath = path.join(userDataPath, "desktop-client-id");
      try {
        const saved = fs.readFileSync(clientPath, "utf8").trim();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)) return saved;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const clientId = randomUUID();
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.writeFileSync(clientPath, clientId, { mode: 0o600 });
      return clientId;
    },
    load() {
      try { return normalizeDesktopConnection(JSON.parse(fs.readFileSync(filePath, "utf8"))); }
      catch (error) {
        if (error.code !== "ENOENT") console.warn("[Desktop] Saved server address could not be loaded; open Settings to reconnect.");
        return null;
      }
    },
    save(input) {
      const connection = normalizeDesktopConnection(input);
      fs.mkdirSync(userDataPath, { recursive: true });
      const temporary = `${filePath}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(connection)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return connection;
    },
  };
}

export async function probeDesktopServer(input, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const connection = normalizeDesktopConnection(input);
  const request = async (endpoint) => {
    try {
      return await fetchImpl(`${connection.origin}${endpoint}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Error("The server could not be reached. Check its URL, start the server, and connect to the same network or Tailscale.");
    }
  };
  const ready = await request("/readyz");
  if (!ready.ok) throw new Error(`The server is not ready (HTTP ${ready.status}). Check the server services and retry.`);
  const response = await request("/v1/version");
  if (!response.ok) throw new Error("This address does not expose the TorWatch version API. Use the server gateway URL.");
  let version;
  try { version = await response.json(); } catch { throw new Error("The server returned an invalid version response."); }
  const range = version?.supportedProtocolRange;
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger) || range[0] > range[1]
    || range[1] < DESKTOP_PROTOCOL_RANGE[0] || range[0] > DESKTOP_PROTOCOL_RANGE[1]) {
    throw new Error("This server uses an incompatible protocol. Update the desktop app or server before connecting.");
  }
  return { ...connection, serverVersion: String(version.serverVersion || "unknown"), capabilities: version.capabilities || [] };
}
