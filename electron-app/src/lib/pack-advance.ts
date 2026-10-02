// Batch-torrent auto-advance: a season pack already contains the following
// episodes, so when one ends the player continues with the next queued
// episode from the SAME source. packQueue is "season:episode:absolute,…";
// the advanced route resolves its file through the normal start path and
// keeps the old next-episode title route as the fallback when the pack does
// not contain that episode.
export function advancePackParams(params: Record<string, string>): Record<string, string> | null {
  const { magnet, packQueue, nextEpisodeRoute } = params;
  if (!magnet || !packQueue) return null;
  const [next, ...rest] = packQueue.split(',').filter(Boolean);
  const [season, episode, absolute] = (next ?? '').split(':');
  if (!season || !episode) return null;

  const advanced: Record<string, string> = {
    ...params,
    season,
    episode,
    absoluteEpisode: absolute || episode,
    resolveEpisodeFile: '1',
  };
  for (const key of ['fileIndex', 'packQueue', 'nextSeason', 'nextEpisode', 'nextEpisodeRoute', 'packFallbackRoute']) {
    delete advanced[key];
  }
  const titleRoute = nextEpisodeRoute?.startsWith('#title?') ? nextEpisodeRoute : null;
  if (titleRoute) advanced.packFallbackRoute = titleRoute;

  const [following] = rest;
  if (following) {
    const [followingSeason, followingEpisode] = following.split(':');
    advanced.packQueue = rest.join(',');
    advanced.nextSeason = followingSeason;
    advanced.nextEpisode = followingEpisode;
    if (titleRoute) {
      const routeParams = new URLSearchParams(titleRoute.slice('#title?'.length));
      routeParams.set('season', followingSeason);
      routeParams.set('episode', followingEpisode);
      advanced.nextEpisodeRoute = `#title?${routeParams.toString()}`;
    }
  }
  return advanced;
}
