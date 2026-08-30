export function buildPlaybackIdentity(title, payload) {
  const fallbackTitle = String(title || "Playing").trim() || "Playing";
  const cleanTitle = fallbackTitle.replace(/\s*[-\u2013\u2014\u00b7]\s*S\d{1,3}E\d{1,4}\s*$/i, "").trim() || fallbackTitle;
  const season = Number(payload?.season);
  const episode = Number(payload?.episode);
  const hasEpisode = Number.isInteger(season) && season >= 0
    && Number.isInteger(episode) && episode > 0;

  return {
    title: cleanTitle,
    kind: String(payload?.cat || "movie").toLowerCase(),
    season: hasEpisode ? season : undefined,
    episode: hasEpisode ? episode : undefined,
    episodeCode: hasEpisode
      ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : undefined,
    episodeLabel: hasEpisode ? `Season ${season}, Episode ${episode}` : undefined,
  };
}
