import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The desktop shell remains file:// (Origin: null), preserving the server's
// existing Electron CORS contract. Assets stay in the packaged application.
export function desktopRendererHtml(html, origin, distDirectory) {
  const server = new URL(origin).origin;
  const result = html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]+)(")/i,
    (_match, prefix, policy, suffix) => {
      const updated = policy
        .replace(/connect-src[^;]*/, `connect-src 'self' ${server} https://api.themoviedb.org https://graphql.anilist.co https://api.jikan.moe https://api.ani.zip https://anime-kitsu.strem.fun https://v3.cinemeta.strem.io`)
        .replace(/media-src[^;]*/, `media-src 'self' blob: ${server}`);
      return `${prefix}${updated}${suffix}`;
    });
  return result.replace(/(src|href)="\.\/assets\/([^"]+)"/g,
    (_match, attribute, asset) => `${attribute}="${pathToFileURL(path.join(distDirectory, "assets", asset)).href}"`);
}

export function createDesktopRendererFile({ appDirectory, userDataPath, origin }) {
  const distDirectory = path.join(appDirectory, "dist");
  const html = fs.readFileSync(path.join(distDirectory, "index.html"), "utf8");
  const output = path.join(userDataPath, "desktop-index.html");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(output, desktopRendererHtml(html, origin, distDirectory));
  return output;
}
