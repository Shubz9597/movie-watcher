// After a downloaded episode with no download of the next one: the show
// page link that opens the next episode's sources (into the next season
// after a season's last episode), like the end of a streamed episode.
type SeasonEpisodes = { episodes: Array<{ episode_number: number; air_date?: string | null }> };

export async function nextEpisodeTitleRoute(
  seriesId: string | undefined,
  season: number,
  episode: number,
  fetchSeason: (tvId: number, season: number) => Promise<SeasonEpisodes>,
  timeoutMs = 5000,
): Promise<string | null> {
  const match = /^tmdb:tv:(\d+)$/u.exec(seriesId ?? '');
  if (!match || season < 1 || episode < 1) return null;
  const tvId = Number(match[1]);
  const released = (item: { air_date?: string | null }) => !item.air_date || Date.parse(item.air_date) <= Date.now();
  const route = (nextSeason: number, nextEpisode: number) => `#title?${new URLSearchParams({
    kind: 'tv', provider: 'tmdb', mediaKind: 'tv', id: String(tvId),
    season: String(nextSeason), episode: String(nextEpisode),
  }).toString()}`;
  const find = async (): Promise<string | null> => {
    const current = await fetchSeason(tvId, season);
    const following = current.episodes.find((item) => item.episode_number === episode + 1);
    if (following) return released(following) ? route(season, episode + 1) : null;
    const nextSeason = await fetchSeason(tvId, season + 1);
    const first = nextSeason.episodes.find((item) => item.episode_number === 1);
    return first && released(first) ? route(season + 1, 1) : null;
  };
  // Offline (or the server away): back to where the viewer came from.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      find(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
