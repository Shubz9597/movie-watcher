// The episode to watch next from this device's watched marks: the furthest
// episode watched or started; if it is finished, the one after it, rolling
// over to the first episode of the next season after a season's last.

export type NextUp = { season: number; episode: number; started: boolean };
/** updated_at: when it was last played or marked (Unix seconds; older
 *  servers leave it out). */
export type WatchedMark = { season: number; episode: number; percent: number; watched: boolean; updated_at?: number };

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
    // The episode played or marked most recently is where you are (a stray
    // start of a later episode does not move you there); same moment, or no
    // times known: the furthest one.
    const time = mark.updated_at ?? 0;
    const lastTime = last?.updated_at ?? 0;
    if (!last || time > lastTime || (time === lastTime
      && (mark.season > last.season || (mark.season === last.season && mark.episode > last.episode)))) last = mark;
  }
  if (!last) return null;
  if (!last.watched) return { season: last.season, episode: last.episode, started: true };
  const length = seasonLength(last.season);
  if (length === 0 || last.episode < length) return { season: last.season, episode: last.episode + 1, started: false };
  const following = [...seasonNumbers].filter((number) => number > last.season).sort((a, b) => a - b)[0];
  return following === undefined ? null : { season: following, episode: 1, started: false };
}
