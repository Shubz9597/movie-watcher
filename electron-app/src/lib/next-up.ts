// The episode to watch next from this device's watched marks: the furthest
// episode watched or started; if it is finished, the one after it, rolling
// over to the first episode of the next season after a season's last.

export type NextUp = { season: number; episode: number; started: boolean };
export type WatchedMark = { season: number; episode: number; percent: number; watched: boolean };

export function nextUpEpisode(
  marks: Iterable<WatchedMark>,
  seasonNumbers: ReadonlyArray<number>,
  seasonLength: (season: number) => number,
  includeSpecials = false,
): NextUp | null {
  let last: WatchedMark | null = null;
  for (const mark of marks) {
    if (mark.season <= 0 && !includeSpecials) continue; // specials don't advance a show
    if (!mark.watched && mark.percent <= 0) continue;
    if (!last || mark.season > last.season || (mark.season === last.season && mark.episode > last.episode)) last = mark;
  }
  if (!last) return null;
  if (!last.watched) return { season: last.season, episode: last.episode, started: true };
  const length = seasonLength(last.season);
  if (length === 0 || last.episode < length) return { season: last.season, episode: last.episode + 1, started: false };
  const following = [...seasonNumbers].filter((number) => number > last.season).sort((a, b) => a - b)[0];
  return following === undefined ? null : { season: following, episode: 1, started: false };
}
