// Shows own their seasons (Stremio's layout); an AniList entry is one season
// or arc of a show. Earlier builds saved downloads, the download queue and
// per-show playback choices under the entry ("anilist:6033", Dragon Ball Z
// Kai's first season, episodes 1-98). On start they move to the show
// ("tmdb:tv:61709", season 1), as the server moved its own records, so a
// show's downloads list together. Offline, or with an older server, nothing
// moves and the next start tries again.
import { bffTitleDetail } from '../lib/services/catalog-bff.ts';
import type { TorWatchDownloadsPluginInterface } from '../platform/native-downloads.ts';
import { getNativeDownloads } from './downloads-adapter.ts';
import { remapPendingDownloads } from './download-queue.ts';

const SHOW_PREFS_KEY = 'torwatch_show_playback_v1';

type Placement = { show: string; season: number; offset: number };

type Deps = {
  native: Pick<TorWatchDownloadsPluginInterface, 'list' | 'relocate'> | null;
  detail: typeof bffTitleDetail;
};

export async function moveEntriesToShows(
  deps: Deps = { native: getNativeDownloads(), detail: bffTitleDetail },
): Promise<void> {
  const placements = new Map<string, Placement | null>();
  const place = async (seriesId: string): Promise<Placement | null> => {
    if (!seriesId.startsWith('anilist:')) return null;
    if (!placements.has(seriesId)) {
      try {
        const series = (await deps.detail(seriesId)).series;
        placements.set(seriesId, series?.id.startsWith('tmdb:tv:') && series.season > 0 && !series.absolute
          ? { show: series.id, season: series.season, offset: series.episodeOffset ?? 0 }
          : null);
      } catch {
        return null; // unreachable now: tried again next start
      }
    }
    return placements.get(seriesId) ?? null;
  };

  const native = deps.native;
  if (native?.relocate) {
    const { items } = await native.list();
    for (const item of items) {
      const placement = await place(item.seriesId);
      if (!placement || item.episode <= 0) continue;
      const episode = item.episode + placement.offset;
      await native.relocate({
        downloadId: item.downloadId,
        seriesId: placement.show,
        season: placement.season,
        episode,
        subtitleLabel: `S${placement.season} E${episode}`,
      });
    }
  }

  const queued = new Map<string, Placement>();
  for (const seriesId of remapPendingDownloads(null)) {
    const placement = await place(seriesId);
    if (placement) queued.set(seriesId, placement);
  }
  if (queued.size) {
    remapPendingDownloads((item) => {
      const placement = queued.get(item.seriesId);
      if (!placement || item.episode <= 0) return item;
      const episode = item.episode + placement.offset;
      return { ...item, seriesId: placement.show, season: placement.season, episode, subtitleLabel: `S${placement.season} E${episode}` };
    });
  }

  // Per-show audio and subtitle choices: the show keeps its own where it
  // has them.
  try {
    const prefs = JSON.parse(localStorage.getItem(SHOW_PREFS_KEY) || '{}') as Record<string, object>;
    let changed = false;
    for (const key of Object.keys(prefs)) {
      const placement = await place(key);
      if (!placement) continue;
      prefs[placement.show] = { ...prefs[key], ...prefs[placement.show] };
      delete prefs[key];
      changed = true;
    }
    if (changed) localStorage.setItem(SHOW_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Unreadable choices: they are simply asked again.
  }
}
