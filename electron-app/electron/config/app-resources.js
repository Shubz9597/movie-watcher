import path from "path";

export function createAppResourcePaths(appDirectory) {
  return {
    appIcon: path.join(appDirectory, "build", "torwatch-icon.png"),
    mainPreload: path.join(appDirectory, "electron", "preloads", "preload.js"),
    playerPreload: path.join(appDirectory, "electron", "preloads", "player-preload.cjs"),
    setupPreload: path.join(appDirectory, "electron", "preloads", "setup-preload.cjs"),
    startupPreload: path.join(appDirectory, "electron", "preloads", "startup-preload.cjs"),
  };
}

export const SETUP_GUIDE_URLS = {
  setupGuide: "https://github.com/Shubz9597/movie-watcher#first-time-setup",
  tmdbGuide: "https://www.themoviedb.org/settings/api",
  openSubtitlesGuide: "https://www.opensubtitles.com/en/consumers",
  vpnGuide: "https://github.com/qdm12/gluetun-wiki/tree/main/setup/providers",
  prowlarrGuide: "https://github.com/Shubz9597/movie-watcher/blob/main/docs/prowlarr-indexers.md",
};
