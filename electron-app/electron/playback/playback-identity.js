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
    // The show its audio/subtitle choices are remembered for (as on the
    // phone), and whether credits at the end lead to a next episode.
    showKey: showKeyOf(payload),
    hasNextEpisode: Number.isInteger(Number(payload?.nextEpisode)) && Number(payload?.nextEpisode) > 0,
  };
}

function showKeyOf(payload) {
  if (payload?.seriesId) return String(payload.seriesId);
  if (payload?.anilistId) return `anilist:${payload.anilistId}`;
  if (payload?.tmdbId) return `tmdb:${String(payload?.cat) === "movie" ? "movie" : "tv"}:${payload.tmdbId}`;
  return undefined;
}
