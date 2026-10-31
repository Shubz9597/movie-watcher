// Downloads filed by a pack's numbering instead of the episode they are.
// Dragon Ball Z Kai's complete pack numbers The Final Chapters as the
// 69-episode international release; the catalog lists the 61 broadcast
// episodes, so episodes downloaded by number before b152561 were filed up
// to 7 episodes off (S2E27 held "Episode 125 Turn Into Candy!", S2E20), with
// another episode's name, still and watched mark. On start each download is
// checked once against the name of the file it was made from: a file named
// for a catalog episode moves to it; a file the catalog doesn't list (the
// international release's extra episodes) moves to Extras (season 0),
// numbered as the pack numbers it. Offline, nothing moves and the next start
// tries again.
import { titleSimilarity } from '../lib/anime-matching.ts';
import type { NativeDownloadItem, TorWatchDownloadsPluginInterface } from '../platform/native-downloads.ts';

const CHECKED_KEY = 'torwatch_refiled_v1';
const SAME_EPISODE = 0.75; // the same title, worded a little differently
const MARGIN = 0.1; // ...and clearly closer than any other episode's
// Below this for every episode: the catalog lacks it. Kai's pack: real
// episodes match at 0.85 or more, its international-only ones at 0.52 or less.
const NOT_LISTED = 0.6;
// Extras need this many downloads of the show matched by title (the pack
// names episodes as the catalog does), so a catalog missing new episodes
// never sends real ones there.
const TITLED_EVIDENCE = 3;

/** The episode title in a file name: the words after its episode number
 *  ("Episode 125 Turn Into Candy! ...mkv"); "" when there are none
 *  ("Dragon Ball Z Kai - 012.mkv"). */
export function titleAfterNumber(fileName: string): string {
  const base = fileName.replace(/^.*\//, '').replace(/\.[a-z0-9]{2,4}$/i, '');
  const match = /(?:S\d{1,2}[\s._-]*E\d{1,4}|(?:Episode|Ep\.?)[\s._-]*\d{1,4}|(?:^|[\s._-])\d{1,4})(?!\d)[\s._-]*(?:[-–:]\s*)?(.*)$/i.exec(base);
  const rest = (match?.[1] ?? '').trim();
  return (rest.match(/[A-Za-z]{2,}/g) ?? []).length >= 2 ? rest : '';
}

export type CatalogEpisode = { season: number; episode: number; title: string; still?: string | null };

export type RefileMove = {
  downloadId: string;
  seriesId: string;
  from: { season: number; episode: number };
  to: { season: number; episode: number };
  title: string;
  still?: string | null;
  extra: boolean;
  finished: boolean;
  /** It was played on this phone (its progress was synced to the old episode). */
  played: boolean;
};

type Deps = {
  native: Pick<TorWatchDownloadsPluginInterface, 'list' | 'relocate'> | null;
  /** The name of the file a download was made from ("" when not a pack's file); null when unreachable. */
  sourceFileName: (item: NativeDownloadItem) => Promise<string | null>;
  /** Every catalog episode of a show (all seasons). */
  episodes: (seriesId: string) => Promise<CatalogEpisode[]>;
  /** Re-sends a download's local progress under its new episode. */
  resendProgress: (downloadIds: string[]) => void;
  setWatched: (seriesId: string, items: Array<{ season: number; episode: number }>, watched: boolean) => Promise<void>;
  saveMeta: (downloadId: string, meta: { episodeTitle?: string; stillUrl?: string | null; posterUrl?: string | null }) => Promise<void>;
  checked: { read(): Set<string>; write(ids: Set<string>): void };
};

/** The episode a source file names, an Extras slot, or null (unsure). */
export function placeByTitle(fileName: string, episodes: CatalogEpisode[]): { season: number; episode: number; title: string; still?: string | null; extra: boolean } | null {
  const title = titleAfterNumber(fileName);
  if (title.replace(/[^a-z0-9]/gi, '').length < 8) return null;
  const ranked = episodes
    .map((episode) => ({ episode, score: titleSimilarity(title, episode.title) }))
    .sort((left, right) => right.score - left.score);
  const [best, runnerUp] = ranked;
  if (best && best.score >= SAME_EPISODE && (!runnerUp || best.score - runnerUp.score >= MARGIN)) {
    return { season: best.episode.season, episode: best.episode.episode, title: best.episode.title, still: best.episode.still, extra: false };
  }
  if (best && best.score >= NOT_LISTED) return null;
  // Not one of the catalog's episodes: Extras, by the pack's own number.
  const number = Number(/(?:^|[\s._-])(?:Episode|Ep\.?|E)?\s*(\d{1,4})(?!\d)/i.exec(fileName)?.[1] ?? 0);
  if (!number) return null;
  return { season: 0, episode: 1000 + number, title, extra: true };
}

export async function refileDownloads(deps: Deps): Promise<RefileMove[]> {
  const native = deps.native;
  if (!native?.relocate) return [];
  const { items } = await native.list();
  const checked = deps.checked.read();
  const episodesBySeries = new Map<string, CatalogEpisode[] | null>();
  const moves: RefileMove[] = [];
  const planned: Array<{ item: NativeDownloadItem; place: NonNullable<ReturnType<typeof placeByTitle>> }> = [];
  const titled = new Map<string, number>(); // series -> downloads matched by title
  for (const item of items) {
    if (checked.has(item.downloadId) || !item.seriesId.startsWith('tmdb:tv:') || item.season <= 0 || item.episode <= 0) continue;
    const fileName = await deps.sourceFileName(item);
    if (fileName === null) continue; // unreachable: next start
    if (!fileName) {
      checked.add(item.downloadId);
      continue;
    }
    if (!episodesBySeries.has(item.seriesId)) {
      episodesBySeries.set(item.seriesId, await deps.episodes(item.seriesId).catch(() => null));
    }
    const episodes = episodesBySeries.get(item.seriesId);
    if (!episodes?.length) continue;
    const place = placeByTitle(fileName, episodes);
    checked.add(item.downloadId);
    if (!place) continue;
    if (!place.extra) titled.set(item.seriesId, (titled.get(item.seriesId) ?? 0) + 1);
    if (place.season === item.season && place.episode === item.episode) continue;
    planned.push({ item, place });
  }
  for (const { item, place } of planned) {
    if (place.extra && (titled.get(item.seriesId) ?? 0) < TITLED_EVIDENCE) {
      checked.delete(item.downloadId); // decided once more of the show is known
      continue;
    }
    const label = place.extra ? `Extra · ${place.episode - 1000}` : `S${place.season} E${place.episode}`;
    await native.relocate({ downloadId: item.downloadId, seriesId: item.seriesId, season: place.season, episode: place.episode, subtitleLabel: label });
    await deps.saveMeta(item.downloadId, { episodeTitle: place.title, stillUrl: place.still ?? null, posterUrl: item.posterUrl || null }).catch(() => {});
    moves.push({
      downloadId: item.downloadId,
      seriesId: item.seriesId,
      from: { season: item.season, episode: item.episode },
      to: { season: place.season, episode: place.episode },
      title: place.title,
      still: place.still,
      extra: place.extra,
      finished: (item.durationS ?? 0) > 0 && (item.positionS ?? 0) / (item.durationS ?? 1) >= 0.9,
      played: (item.positionS ?? 0) > 0,
    });
  }
  deps.checked.write(checked);
  if (moves.length) await fixWatchedMarks(moves, items, deps);
  return moves;
}

// The old episode carried this download's watched mark; the new one gets
// it. An old episode keeps its mark when a download now filed there (or
// one never moved) was watched to the end.
async function fixWatchedMarks(moves: RefileMove[], items: NativeDownloadItem[], deps: Deps): Promise<void> {
  deps.resendProgress(moves.filter((move) => !move.extra).map((move) => move.downloadId));
  const placeOf = new Map(items.map((item) => [item.downloadId, { season: item.season, episode: item.episode }]));
  for (const move of moves) placeOf.set(move.downloadId, move.to);
  const finishedAt = new Set<string>();
  for (const item of items) {
    const place = placeOf.get(item.downloadId);
    if (place && (item.durationS ?? 0) > 0 && (item.positionS ?? 0) / (item.durationS ?? 1) >= 0.9) {
      finishedAt.add(`${item.seriesId}|${place.season}|${place.episode}`);
    }
  }
  const bySeries = new Map<string, { unwatch: Array<{ season: number; episode: number }>; watch: Array<{ season: number; episode: number }> }>();
  for (const move of moves) {
    const entry = bySeries.get(move.seriesId) ?? { unwatch: [], watch: [] };
    // Only a mark this download's own progress put there is cleared.
    if (move.played && !finishedAt.has(`${move.seriesId}|${move.from.season}|${move.from.episode}`)) entry.unwatch.push(move.from);
    if (move.finished && !move.extra) entry.watch.push(move.to);
    bySeries.set(move.seriesId, entry);
  }
  for (const [seriesId, { unwatch, watch }] of bySeries) {
    if (unwatch.length) await deps.setWatched(seriesId, unwatch, false).catch(() => {});
    if (watch.length) await deps.setWatched(seriesId, watch, true).catch(() => {});
  }
}

export const checkedStore = {
  read(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(CHECKED_KEY) || '[]') as string[]);
    } catch {
      return new Set();
    }
  },
  write(ids: Set<string>): void {
    try {
      localStorage.setItem(CHECKED_KEY, JSON.stringify([...ids]));
    } catch {
      // Storage full: checked again next start.
    }
  },
};

/** Runs the check against this server, its catalog and the phone's downloads. */
export async function refileFromServer(connection: { loadOrigin(): Promise<string> }): Promise<RefileMove[]> {
  const [{ getNativeDownloads }, { getDeviceId }, { bffTitleDetail, bffEpisodes }, { setWatched }, { cacheDownloadMeta }, sync] = await Promise.all([
    import('./downloads-adapter.ts'),
    import('../lib/device-id.ts'),
    import('../lib/services/catalog-bff.ts'),
    import('../lib/services/watched-service.ts'),
    import('../lib/offline-download-meta.ts'),
    import('./offline-progress-sync.ts'),
  ]);
  const origin = await connection.loadOrigin();
  const moves = await refileDownloads({
    native: getNativeDownloads(),
    sourceFileName: async (item) => {
      // Downloads of another server are left alone.
      if (item.origin && item.origin !== origin) return '';
      try {
        const params = new URLSearchParams({ downloadId: item.downloadId, clientId: getDeviceId() });
        const response = await fetch(`${origin}/downloads/source?${params.toString()}`, { signal: AbortSignal.timeout(60_000) });
        if (response.status === 404) return ''; // the server no longer has it: nothing to check
        if (!response.ok) return null;
        const body = await response.json() as { fileName?: string };
        return body.fileName ?? '';
      } catch {
        return null;
      }
    },
    episodes: async (seriesId) => {
      const seasons = (await bffTitleDetail(seriesId)).seasons ?? [];
      const all: CatalogEpisode[] = [];
      for (const season of seasons) {
        if ((season.episodeCount ?? 0) <= 0) continue;
        for (const episode of await bffEpisodes(seriesId, season.number)) {
          if (episode.title) all.push({ season: episode.season, episode: episode.episode, title: episode.title, still: episode.still ?? null });
        }
      }
      return all;
    },
    resendProgress: (ids) => sync.resendOfflineProgress(ids),
    setWatched: (seriesId, items, watched) => setWatched(seriesId, items, watched),
    saveMeta: (downloadId, meta) => cacheDownloadMeta(downloadId, meta),
    checked: checkedStore,
  });
  if (moves.length) console.info(`[Downloads] refiled ${moves.length} download(s) to the episodes their files are`);
  return moves;
}
