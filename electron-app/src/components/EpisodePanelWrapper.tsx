// Electron-compatible EpisodePanel that uses services directly
// This wraps the original but handles API calls through services
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '../lib/router-adapter';
import { ArrowLeft, CheckCircle2, ChevronRight, Circle, Clock3, Loader2, Play } from 'lucide-react';
import PlaybackSplitButton from './PlaybackSplitButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { getTvSeason } from '../lib/services/catalog-gateway';
import { getCinemetaSeasonMetadata } from '../lib/services/catalog-gateway';
import { resolveTorrentSource, searchTvTorrents, searchAnimeTorrents } from '../lib/services/torrent-search-service';
import { listTorrentFiles, pickEpisodeFile, resolveTorrentFile, type ResolvedEpisodeFile } from '../lib/services/resolve-service';
import { getSavedResumeSource } from '../lib/services/continue-service';
import { getVodBase } from '../lib/api-client';
import { usePlatform } from '../platform/PlatformProvider';
import type { ResumeSourceContext, SavedResumeSource, TorrentRow } from '../lib/types';
import { prioritizePreviouslyUsedTorrent, torrentInfoHash } from '../lib/torrent-identity';
import {
  clearSeasonPack,
  loadSeasonPack,
  saveSeasonPack,
  seasonPackSeriesKey,
} from '../lib/season-pack-cache';
import type { EpisodeSummary, SeasonSummary } from '../lib/title-types';
import { getDeviceId } from '../lib/device-id';
import { NativeDownloadButton } from './NativeDownloadButton';
import { fetchWatched, setWatched, watchedKey, type WatchedItem } from '../lib/services/watched-service';
import type { DownloadSelection } from '../mobile/download-queue';
import type { BatchRange } from './NativeDownloadButton';

type Props = {
  kind: 'tv' | 'anime';
  title: string;
  posterUrl?: string | null;
  titleAliases?: string[] | null;
  imdbId?: string;
  year?: number;
  originalLanguage?: string;
  seasons: SeasonSummary[];
  initialSeason: number;
  initialEpisodes: EpisodeSummary[];
  initialArtworkHydrating?: boolean;
  initialEpisode?: number;
  seasonApiBase?: string | null;
  tmdbId?: number;
  anilistId?: number;
  malId?: number;
  resumeContext?: ResumeSourceContext | null;
  resumeSource?: SavedResumeSource | null;
};

type TorrentApiItem = {
  title: string;
  size?: number;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  magnet?: string;
  sourceId?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  indexer?: string;
  publishDate?: string;
  episodeMatch?: boolean;
  seasonPack?: {
    season?: number | null;
    reason?: string | null;
    keywords?: string[];
  } | null;
  quality?: string;
  source?: string;
  audio?: string;
  pack?: TorrentRow['pack'];
};

const PACK_LABELS: Record<NonNullable<TorrentRow['pack']>, string> = {
  episode: 'Exact episode',
  range: 'Episode batch',
  season: 'Season pack',
  series: 'Complete series',
};

const formatAirDate = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const releaseTime = (value?: string | null): number | null => {
  if (!value) return null;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const episodeReleaseTime = (episode: EpisodeSummary): number | null =>
  releaseTime(episode.availableAt || episode.airDate);

const episodeFromTmdb = (episode: any, fallbackSeason: number): EpisodeSummary => ({
  id: episode.id,
  name: episode.name || `Episode ${episode.episode_number ?? ''}`,
  overview: episode.overview || '',
  stillUrl: episode.still_path ? `https://image.tmdb.org/t/p/w780${episode.still_path}` : undefined,
  episodeNumber: episode.episode_number,
  seasonNumber: episode.season_number ?? fallbackSeason,
  airDate: episode.air_date,
  runtime: typeof episode.runtime === 'number' ? episode.runtime : null,
});

const formatBytes = (value?: number) => {
  if (!value || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(2)} ${units[idx]}`;
};

// The backend origin is read per call so runtime origin switches apply.
const getStreamBase = () => getVodBase();

function ArtworkLoadingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      <span className="artwork-loading-dot h-1 w-1 rounded-full bg-current" />
      <span className="artwork-loading-dot h-1 w-1 rounded-full bg-current" />
      <span className="artwork-loading-dot h-1 w-1 rounded-full bg-current" />
    </span>
  );
}
function EpisodeArtworkMedia({
  src,
  hydrating,
  lazy = false,
  interactive = false,
}: {
  src: string | null;
  hydrating: boolean;
  lazy?: boolean;
  interactive?: boolean;
}) {
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    src ? 'loading' : 'idle',
  );
  // rerender-derived-state-no-effect: no reset effect here — both call sites
  // key this component on the artwork URL, so a src change REMOUNTS it and
  // the initializer already yields 'loading'. The effect would only add an
  // extra render pass and a window where the new src renders with the old
  // load state.

  const showLoading = hydrating || loadState === 'loading';

  return (
    <>
      <div className="type-caption absolute inset-0 grid place-items-center bg-[#141414] text-white/40" aria-hidden="true">
        {showLoading ? <ArtworkLoadingDots /> : 'No still'}
      </div>
      {src && loadState !== 'error' ? (
        <img
          src={src}
          alt=""
          loading={lazy ? 'lazy' : 'eager'}
          decoding="async"
          className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform,filter] duration-200 ${
            loadState === 'ready' ? 'opacity-100' : 'opacity-0'
          } ${
            interactive
              ? 'group-hover:scale-105 group-disabled:scale-100 group-disabled:saturate-50'
              : ''
          }`}
          onLoad={() => setLoadState('ready')}
          onError={() => setLoadState('error')}
        />
      ) : null}
    </>
  );
}

export default function EpisodePanel({
  kind,
  title,
  posterUrl,
  titleAliases,
  imdbId,
  year,
  originalLanguage,
  seasons,
  initialSeason,
  initialEpisodes,
  initialArtworkHydrating = false,
  initialEpisode,
  tmdbId,
  anilistId,
  malId,
  resumeContext,
  resumeSource,
}: Props) {
  const router = useRouter();
  const platform = usePlatform();
  const [selectedSeason, setSelectedSeason] = useState(initialSeason);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>(initialEpisodes);
  const [seasonLoading, setSeasonLoading] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);
  const [manualEpisode, setManualEpisode] = useState('1');
  const [seasonArtworkHydrating, setSeasonArtworkHydrating] = useState(false);
  const [availabilityNow, setAvailabilityNow] = useState(() => Date.now());

  const [torrentRows, setTorrentRows] = useState<TorrentRow[] | null>(null);
  const [torrentLoading, setTorrentLoading] = useState(false);
  const [torrentError, setTorrentError] = useState<string | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<EpisodeSummary | null>(null);
  const [playBusyId, setPlayBusyId] = useState<string | null>(null);
  const [externalBusyId, setExternalBusyId] = useState<string | null>(null);
  const [historySource, setHistorySource] = useState<SavedResumeSource | null>(null);
  const didOpenInitialEpisode = useRef(false);
  const torrentRequestId = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const sourceHeadingRef = useRef<HTMLHeadingElement>(null);
  const episodeButtons = useRef(new Map<number, HTMLButtonElement>());
  const returnToEpisode = useRef<number | null>(null);
  const seasonRequestId = useRef(0);
  const playInFlight = useRef(false);
  const seriesPackKey = seasonPackSeriesKey(kind, tmdbId, anilistId, title);
  const seasonCache = useRef<Map<number, EpisodeSummary[]>>(new Map());
  const rowKey = (t: TorrentRow) =>
    torrentInfoHash(t.infoHash) || torrentInfoHash(t.magnetUri) || t.sourceId || t.torrentUrl || t.downloadUrl || t.title;
  const normalizedSeasons = seasons.length ? seasons : [{ seasonNumber: initialSeason, name: `Season ${initialSeason}` }];
  const artworkHydrating = initialArtworkHydrating || seasonArtworkHydrating;

  // Mobile has one page scroller. Replacing a long episode list with a
  // shorter source list must land at its heading, not at a clamped old offset.
  // Going back restores the chosen episode and keyboard/screen-reader focus.
  useLayoutEffect(() => {
    if (platform.desktop) return;
    if (activeEpisode) {
      panelRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      sourceHeadingRef.current?.focus({ preventScroll: true });
    } else if (returnToEpisode.current != null) {
      const button = episodeButtons.current.get(returnToEpisode.current);
      button?.scrollIntoView({ block: 'center', behavior: 'instant' });
      button?.focus({ preventScroll: true });
      returnToEpisode.current = null;
    }
  }, [activeEpisode, platform.desktop]);
  const firstUpcomingIndex = episodes.findIndex((episode) => {
    const releaseTime = episodeReleaseTime(episode);
    return releaseTime !== null && releaseTime > availabilityNow;
  });
  // O(1) id→index lookup (perf): the previous per-episode findIndex made the
  // episode list render O(n²) — up to ~1M steps per render pass for a
  // 1000-episode anime back-catalogue.
  // Watched state for this show on this device (/v1/watched). Re-read when
  // the panel mounts, i.e. also after returning from the player.
  const watchedSeriesId = kind === 'anime' && anilistId ? `anilist:${anilistId}` : tmdbId ? `tmdb:tv:${tmdbId}` : null;
  const [watchedMap, setWatchedMap] = useState<Map<string, WatchedItem>>(() => new Map());
  const [watchedError, setWatchedError] = useState<string | null>(null);
  useEffect(() => {
    if (!watchedSeriesId) return;
    let cancelled = false;
    void fetchWatched(watchedSeriesId)
      .then((map) => { if (!cancelled) setWatchedMap(map); })
      .catch(() => { /* offline or older server: no watched marks */ });
    return () => { cancelled = true; };
  }, [watchedSeriesId]);

  const toggleWatched = async (episode: EpisodeSummary) => {
    if (!watchedSeriesId) return;
    const season = episode.seasonNumber || selectedSeason;
    const key = watchedKey(season, episode.episodeNumber);
    const wasWatched = watchedMap.get(key)?.watched === true;
    const optimistic = new Map(watchedMap);
    if (wasWatched) optimistic.delete(key);
    else optimistic.set(key, { season, episode: episode.episodeNumber, percent: 100, watched: true });
    setWatchedMap(optimistic);
    setWatchedError(null);
    // Marking watched moves Continue watching on to the following episode.
    const index = episodes.findIndex((candidate) => candidate.id === episode.id);
    const following = index >= 0 ? episodes[index + 1] : undefined;
    const next = !wasWatched && following && isEpisodeAvailableForContinuation(following)
      ? { season: following.seasonNumber || selectedSeason, episode: following.episodeNumber }
      : null;
    try {
      await setWatched(watchedSeriesId, [{ season, episode: episode.episodeNumber }], !wasWatched, next);
    } catch {
      setWatchedMap(watchedMap);
      setWatchedError('Couldn’t update watched. Check the connection.');
    }
  };

  const episodeIndexById = useMemo(() => new Map(episodes.map((episode, index) => [episode.id, index])), [episodes]);
  const isEpisodeUpcoming = (episode: EpisodeSummary) => {
    const releaseTime = episodeReleaseTime(episode);
    if (releaseTime !== null && releaseTime > availabilityNow) return true;
    const episodeIndex = episodeIndexById.get(episode.id) ?? -1;
    return firstUpcomingIndex >= 0 && episodeIndex >= firstUpcomingIndex;
  };
  const isEpisodeAvailableForContinuation = (episode: EpisodeSummary) => {
    if (episode.continuationAvailable !== undefined) return episode.continuationAvailable;
    const timestamp = episodeReleaseTime(episode);
    if (timestamp !== null) return timestamp <= availabilityNow;

    // TMDB leaves the air date empty for unconfirmed or unreleased episodes.
    // Historical anime catalogues can omit dates, so their schedule boundary
    // remains the fallback instead of hiding every completed back-catalogue.
    if (tmdbId) return false;
    return !isEpisodeUpcoming(episode);
  };

  const resolveNextAvailableEpisode = async (current: EpisodeSummary): Promise<EpisodeSummary | null> => {
    const activeIndex = episodes.findIndex((episode) => episode.id === current.id);
    if (activeIndex < 0) return null;

    const nextEpisode = episodes[activeIndex + 1];
    if (nextEpisode) {
      return isEpisodeAvailableForContinuation(nextEpisode) ? nextEpisode : null;
    }
    if (activeIndex !== episodes.length - 1 || !tmdbId) return null;

    const currentSeasonNumber = current.seasonNumber || selectedSeason;
    const nextSeason = normalizedSeasons
      .filter((season) => season.seasonNumber > currentSeasonNumber)
      .sort((left, right) => left.seasonNumber - right.seasonNumber)[0];
    if (!nextSeason) return null;

    const seasonReleaseTime = releaseTime(nextSeason.airDate);
    if (seasonReleaseTime !== null && seasonReleaseTime > availabilityNow) return null;

    let nextSeasonEpisodes = seasonCache.current.get(nextSeason.seasonNumber);
    if (!nextSeasonEpisodes) {
      // Starting mobile playback must not wait on optional next-season metadata.
      if (!platform.desktop) return null;
      try {
        const seasonData = await getTvSeason(tmdbId, nextSeason.seasonNumber);
        const loadedEpisodes: EpisodeSummary[] = Array.isArray(seasonData.episodes)
          ? seasonData.episodes.map((episode: any) => episodeFromTmdb(episode, nextSeason.seasonNumber))
          : [];
        seasonCache.current.set(nextSeason.seasonNumber, loadedEpisodes);
        nextSeasonEpisodes = loadedEpisodes;
      } catch (error) {
        console.warn('[EpisodePanel] Could not verify the next season episode:', error);
        return null;
      }
    }
    if (!nextSeasonEpisodes) return null;

    const firstEpisode = nextSeasonEpisodes.find((episode) => episode.episodeNumber === 1);
    return firstEpisode && isEpisodeAvailableForContinuation(firstEpisode) ? firstEpisode : null;
  };

  useEffect(() => {
    let cancelled = false;
    setHistorySource(null);
    if (!activeEpisode) return;
    const activeSeason = activeEpisode.seasonNumber || selectedSeason;
    const resumeMatches = Boolean(
      resumeContext &&
      resumeContext.season === activeSeason &&
      resumeContext.episode === activeEpisode.episodeNumber,
    );
    if (resumeMatches && resumeSource) {
      setHistorySource(resumeSource);
      return;
    }
    const seriesId = kind === 'anime' && anilistId
      ? `anilist:${anilistId}`
      : tmdbId
        ? `tmdb:tv:${tmdbId}`
        : '';
    if (!seriesId) return;
    const context = {
      subjectId: getDeviceId(),
      seriesId,
      season: activeSeason,
      episode: activeEpisode.episodeNumber,
    };
    void getSavedResumeSource(context).then((result) => {
      if (!cancelled && result.found) setHistorySource(result.source);
    });
    return () => {
      cancelled = true;
    };
  }, [activeEpisode, anilistId, kind, resumeContext, resumeSource, selectedSeason, tmdbId]);

  useEffect(() => {
    let cancelled = false;
    const requestId = seasonRequestId.current;

    seasonCache.current.set(initialSeason, initialEpisodes);
    setEpisodes(initialEpisodes);
    setSelectedSeason(initialSeason);
    setActiveEpisode((current) => current
      ? initialEpisodes.find((episode) => episode.id === current.id) || current
      : current);

    const shouldHydrate = kind === 'tv' && Boolean(imdbId);
    setSeasonArtworkHydrating(shouldHydrate);

    if (shouldHydrate) {
      void getCinemetaSeasonMetadata(imdbId, initialSeason)
        .then((metadata) => {
          if (cancelled || requestId !== seasonRequestId.current || metadata.size === 0) return;

          const enrichedEpisodes = initialEpisodes.map((episode) => {
            const enriched = metadata.get(episode.episodeNumber);
            if (!enriched) return episode;

            return {
              ...episode,
              stillUrl: episode.stillUrl || enriched.thumbnailUrl,
              availableAt: enriched.releasedAt || episode.availableAt,
            };
          });

          seasonCache.current.set(initialSeason, enrichedEpisodes);
          setEpisodes(enrichedEpisodes);
          setActiveEpisode((current) => current
            ? enrichedEpisodes.find((episode) => episode.id === current.id) || current
            : current);
        })
        .finally(() => {
          if (!cancelled && requestId === seasonRequestId.current) setSeasonArtworkHydrating(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [imdbId, initialSeason, initialEpisodes]);

  useEffect(() => {
    const nextRelease = episodes
      .map(episodeReleaseTime)
      .filter((timestamp): timestamp is number => timestamp !== null && timestamp > availabilityNow)
      .sort((left, right) => left - right)[0];
    if (!nextRelease) return;

    const timeout = window.setTimeout(
      () => setAvailabilityNow(Date.now()),
      Math.min(Math.max(nextRelease - availabilityNow + 1_000, 1_000), 60 * 60 * 1_000),
    );
    return () => window.clearTimeout(timeout);
  }, [availabilityNow, episodes]);

  const onSeasonChange = async (value: string) => {
    const seasonNum = Number(value);
    const requestId = seasonRequestId.current + 1;
    seasonRequestId.current = requestId;
    torrentRequestId.current += 1;
    setSelectedSeason(seasonNum);
    setSeasonError(null);
    setSeasonLoading(false);
    setSeasonArtworkHydrating(false);
    setActiveEpisode(null);
    setTorrentRows(null);
    setTorrentError(null);
    setTorrentLoading(false);

    const cached = seasonCache.current.get(seasonNum);
    if (cached) {
      setEpisodes(cached);
      return;
    }
    if (!tmdbId || kind !== 'tv') {
      setEpisodes([]);
      return;
    }
    setSeasonLoading(true);
    try {
      console.log('[EpisodePanel] Loading season', seasonNum, 'for TV', tmdbId);
      const seasonData = await getTvSeason(tmdbId, seasonNum);
      if (seasonRequestId.current !== requestId) return;
      const eps: EpisodeSummary[] = Array.isArray(seasonData.episodes)
        ? seasonData.episodes.map((episode: any) => episodeFromTmdb(episode, seasonNum))
        : [];
      seasonCache.current.set(seasonNum, eps);
      setEpisodes(eps);

      if (imdbId) {
        setSeasonArtworkHydrating(true);
        void getCinemetaSeasonMetadata(imdbId, seasonNum)
          .then((metadata) => {
            if (seasonRequestId.current !== requestId || metadata.size === 0) return;

            const enrichedEpisodes = eps.map((episode) => {
              const enriched = metadata.get(episode.episodeNumber);
              if (!enriched) return episode;

              return {
                ...episode,
                stillUrl: episode.stillUrl || enriched.thumbnailUrl,
                availableAt: enriched.releasedAt || episode.availableAt,
              };
            });

            seasonCache.current.set(seasonNum, enrichedEpisodes);
            setEpisodes(enrichedEpisodes);
            setActiveEpisode((current) => current
              ? enrichedEpisodes.find((episode) => episode.id === current.id) || current
              : current);
          })
          .finally(() => {
            if (seasonRequestId.current === requestId) setSeasonArtworkHydrating(false);
          });
      }
    } catch (e) {
      if (seasonRequestId.current !== requestId) return;
      const message = e instanceof Error ? e.message : 'Failed to load season';
      setSeasonError(message);
      setEpisodes([]);
    } finally {
      if (seasonRequestId.current === requestId) setSeasonLoading(false);
    }
  };

  const fetchTorrentsForEpisode = async (episode: EpisodeSummary) => {
    if (isEpisodeUpcoming(episode)) return;
    const requestId = torrentRequestId.current + 1;
    torrentRequestId.current = requestId;
    setActiveEpisode(episode);
    setTorrentLoading(true);
    setTorrentError(null);
    setTorrentRows(null);
    let reusedPack: TorrentRow | null = null;
    try {
      console.log('[EpisodePanel] Fetching torrents for episode', episode.episodeNumber);
      const episodeSeason = episode.seasonNumber ?? selectedSeason;
      const savedPack = loadSeasonPack(seriesPackKey, episodeSeason);
      if (savedPack) {
        try {
          const resolved = await resolveTorrentFile({
            magnetUri: savedPack.magnetUri,
            infoHash: savedPack.infoHash,
            cat: kind,
            season: episodeSeason,
            episode: episode.episodeNumber,
            absolute: episode.absoluteNumber ?? episode.episodeNumber,
          });
          reusedPack = {
            title: savedPack.title,
            size: savedPack.size,
            seeders: savedPack.seeders,
            leechers: savedPack.leechers,
            magnetUri: savedPack.magnetUri,
            infoHash: savedPack.infoHash,
            indexer: savedPack.indexer,
            fileIndex: resolved.fileIndex,
            episodeMatch: true,
            reusedSeasonPack: true,
            seasonPack: { season: episodeSeason, reason: 'same-pack', keywords: ['same-pack'] },
          };
        } catch (error) {
          console.warn('[EpisodePanel] Saved season pack does not contain this episode:', error);
          clearSeasonPack(seriesPackKey, episodeSeason);
        }
      }

      // A previously selected batch is the only source we carry forward. Its
      // file was verified above, so do not run a new search or auto-rank a
      // different torrent for this episode.
      if (reusedPack) {
        if (torrentRequestId.current === requestId) setTorrentRows([reusedPack]);
        return;
      }

      let result: { results: TorrentApiItem[]; error?: string };
      
      if (kind === 'anime') {
        result = await searchAnimeTorrents({
          title,
          anilistId,
          imdbId,
          year,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
          absolute: episode.absoluteNumber ?? episode.episodeNumber,
          aliases: titleAliases || [],
          tvdbId: undefined,
          originalLanguage,
        });
      } else {
        result = await searchTvTorrents({
          imdbId,
          title,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
          year,
          originalLanguage,
          tvdbId: undefined,
          aliases: titleAliases || [],
        });
      }

      if (result.error) throw new Error(result.error);
      const rows: TorrentRow[] = Array.isArray(result.results)
        ? result.results.map((it) => ({
            title: it.title,
            size: typeof it.size === 'number' ? it.size : it.sizeBytes,
            seeders: it.seeders,
            leechers: it.leechers,
            magnetUri: it.magnetUri || it.magnet,
            sourceId: it.sourceId,
            torrentUrl: it.torrentUrl || it.downloadUrl,
            downloadUrl: it.downloadUrl,
            infoHash: it.infoHash,
            indexer: it.indexer || '-',
            publishDate: it.publishDate,
            episodeMatch: it.episodeMatch,
            seasonPack: it.seasonPack,
            quality: it.quality,
            source: it.source,
            audio: it.audio,
            pack: it.pack,
          }))
        : [];
      if (torrentRequestId.current === requestId) setTorrentRows(rows);
    } catch (e) {
      if (torrentRequestId.current !== requestId) return;
      if (reusedPack) {
        setTorrentRows([reusedPack]);
        setTorrentError(null);
        return;
      }
      const message = e instanceof Error ? e.message : 'Failed to fetch torrents';
      setTorrentError(message);
      setTorrentRows([]);
    } finally {
      if (torrentRequestId.current === requestId) setTorrentLoading(false);
    }
  };

  useEffect(() => {
    if (didOpenInitialEpisode.current || !initialEpisode || seasonLoading) return;
    const episode = episodes.find((item) => item.episodeNumber === initialEpisode);
    if (!episode) return;
    didOpenInitialEpisode.current = true;
    void fetchTorrentsForEpisode(episode);
  }, [episodes, initialEpisode, seasonLoading]);

  const playTorrent = async (t: TorrentRow) => {
    if (playInFlight.current) return;
    playInFlight.current = true;
    const key = rowKey(t);
    setPlayBusyId(key);
    try {
      const magnet = await resolveTorrentSource(t);
      let fileIndex: number | undefined = t.fileIndex;
      if (platform.desktop && fileIndex == null && activeEpisode && t.seasonPack) {
        // Resolve file index for season packs
        const resolved = await resolveTorrentFile({
          magnetUri: magnet,
          torrentUrl: t.torrentUrl,
          downloadUrl: t.downloadUrl,
          infoHash: t.infoHash,
          cat: kind,
          season: activeEpisode.seasonNumber ?? selectedSeason,
          episode: activeEpisode.episodeNumber,
          absolute: activeEpisode.absoluteNumber ?? activeEpisode.episodeNumber,
        });
        fileIndex = resolved.fileIndex;
        console.log('[EpisodePanel] Resolved file index:', fileIndex, 'for', resolved.fileName);
      }

      if (activeEpisode && t.seasonPack) {
        saveSeasonPack(
          seriesPackKey,
          activeEpisode.seasonNumber ?? selectedSeason,
          t,
          magnet,
        );
      }

      const params: Record<string, string> = {
        cat: kind,
        magnet,
        title,
        sourceName: t.title,
      };
      if (!platform.desktop && fileIndex == null && activeEpisode && t.seasonPack) {
        params.resolveEpisodeFile = '1';
      }
      if (activeEpisode) {
        params.season = String(activeEpisode.seasonNumber || selectedSeason);
        params.episode = String(activeEpisode.episodeNumber);
        params.absoluteEpisode = String(activeEpisode.absoluteNumber ?? activeEpisode.episodeNumber);

        const nextEpisode = await resolveNextAvailableEpisode(activeEpisode);
        if (nextEpisode) {
          const nextSeasonNumber = nextEpisode.seasonNumber;
          const nextEpisodeNumber = nextEpisode.episodeNumber;
          params.nextSeason = String(nextSeasonNumber);
          params.nextEpisode = String(nextEpisodeNumber);
          const [currentPath, currentQuery = ''] = window.location.hash.slice(1).split('?');
          if (currentPath === 'title') {
            const nextRouteParams = new URLSearchParams(currentQuery);
            nextRouteParams.set('season', String(nextSeasonNumber));
            nextRouteParams.set('episode', String(nextEpisodeNumber));
            params.nextEpisodeRoute = `#title?${nextRouteParams.toString()}`;
          }
        }
      }
      // Batch torrents hold the following episodes too: hand the player the
      // rest of this season so it can continue from the same pack when an
      // episode ends ("season:episode:absolute", released episodes only).
      if (activeEpisode && (t.seasonPack || t.reusedSeasonPack)) {
        const activeIndex = episodes.findIndex((episode) => episode.id === activeEpisode.id);
        const queue = activeIndex < 0 ? [] : episodes
          .slice(activeIndex + 1)
          .filter(isEpisodeAvailableForContinuation)
          .slice(0, 40)
          .map((episode) => `${episode.seasonNumber || selectedSeason}:${episode.episodeNumber}:${episode.absoluteNumber ?? episode.episodeNumber}`);
        if (queue.length) params.packQueue = queue.join(',');
      }
      if (fileIndex != null) params.fileIndex = String(fileIndex);
      const isResumeEpisode = Boolean(
        resumeContext && activeEpisode &&
        resumeContext.season === (activeEpisode.seasonNumber || selectedSeason) &&
        resumeContext.episode === activeEpisode.episodeNumber
      );
      if (isResumeEpisode && resumeContext) {
        params.seriesId = resumeContext.seriesId;
      } else if (kind === 'anime' && anilistId) {
        params.seriesId = `anilist:${anilistId}`;
      } else if (tmdbId) {
        params.seriesId = `tmdb:tv:${tmdbId}`;
      }

      if (platform.player) {
        if (platform.kind === 'electron' && !platform.desktop) {
          setTorrentError('Playback isn’t available. Restart TorWatch.');
          return;
        }
        if (fileIndex != null) params.fileIndex = String(fileIndex);
        if (tmdbId) params.tmdbId = String(tmdbId);
        if (imdbId) params.imdbId = imdbId;
        if (anilistId) params.anilistId = String(anilistId);
        if (malId) params.malId = String(malId);
        if (activeEpisode) {
          const [currentPath, currentQuery = ''] = window.location.hash.slice(1).split('?');
          if (currentPath === 'title') {
            const returnParams = new URLSearchParams(currentQuery);
            returnParams.set('season', String(activeEpisode.seasonNumber || selectedSeason));
            returnParams.set('episode', String(activeEpisode.episodeNumber));
            window.history.replaceState(window.history.state, '', `#title?${returnParams.toString()}`);
          }
        }
        router.push('player', params);
      } else {
        setTorrentError('Playback isn’t available on this device.');
        return;
      }
    } catch (err) {
      setTorrentError(err instanceof Error ? err.message : 'Playback failed');
    } finally {
      playInFlight.current = false;
      setPlayBusyId(null);
    }
  };

  const downloadTorrentM3U = async (t: TorrentRow) => {
    if (playInFlight.current) return;
    playInFlight.current = true;
    const key = rowKey(t);
    setExternalBusyId(key);
    setTorrentError(null);
    try {
      const magnet = await resolveTorrentSource(t);
      let fileIndex: number | undefined = t.fileIndex;
      if (fileIndex == null && activeEpisode && t.seasonPack) {
        const resolved = await resolveTorrentFile({
          magnetUri: magnet,
          torrentUrl: t.torrentUrl,
          downloadUrl: t.downloadUrl,
          infoHash: t.infoHash,
          cat: kind,
          season: activeEpisode.seasonNumber ?? selectedSeason,
          episode: activeEpisode.episodeNumber,
          absolute: activeEpisode.absoluteNumber ?? activeEpisode.episodeNumber,
        });
        fileIndex = resolved.fileIndex;
      }

      if (activeEpisode && t.seasonPack) {
        saveSeasonPack(
          seriesPackKey,
          activeEpisode.seasonNumber ?? selectedSeason,
          t,
          magnet,
        );
      }

      const streamParams = new URLSearchParams({
        cat: kind,
        magnet,
        subjectId: getDeviceId(),
        trackProgress: '1',
      });
      if (fileIndex != null) streamParams.set('fileIndex', String(fileIndex));
      if (activeEpisode) {
        streamParams.set('season', String(activeEpisode.seasonNumber || selectedSeason));
        streamParams.set('episode', String(activeEpisode.episodeNumber));
      }

      const isResumeEpisode = Boolean(
        resumeContext && activeEpisode &&
        resumeContext.season === (activeEpisode.seasonNumber || selectedSeason) &&
        resumeContext.episode === activeEpisode.episodeNumber
      );
      if (isResumeEpisode && resumeContext) {
        streamParams.set('seriesId', resumeContext.seriesId);
      } else if (kind === 'anime' && anilistId) {
        streamParams.set('seriesId', `anilist:${anilistId}`);
      } else if (tmdbId) {
        streamParams.set('seriesId', `tmdb:tv:${tmdbId}`);
      }

      const episodeCode = activeEpisode
        ? `S${String(activeEpisode.seasonNumber || selectedSeason).padStart(2, '0')}E${String(activeEpisode.episodeNumber).padStart(2, '0')}`
        : '';
      const displayTitle = episodeCode ? `${title} — ${episodeCode}` : title;
      const streamUrl = `${getStreamBase()}/stream?${streamParams.toString()}`;
      const m3u = `#EXTM3U\n#EXTINF:-1,${displayTitle}\n#EXTVLCOPT:http-reconnect=true\n${streamUrl}\n`;
      const blob = new Blob([m3u], { type: 'audio/x-mpegurl' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${displayTitle.replace(/[<>:"/\\|?*]/g, '_')}.m3u`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err) {
      setTorrentError(err instanceof Error ? err.message : 'Couldn’t create the playlist.');
    } finally {
      playInFlight.current = false;
      setExternalBusyId(null);
    }
  };

  // Sheet copy before the (possibly season-pack) selection resolves. A pack's
  // size is the whole pack, so only single-episode sizes are disclosed.
  const downloadDetailsFor = (torrent: TorrentRow) => ({
    title,
    label: activeEpisode ? `S${activeEpisode.seasonNumber || selectedSeason} E${activeEpisode.episodeNumber}` : undefined,
    sizeBytes: torrent.seasonPack ? undefined : torrent.size,
  });

  const downloadSelectionFor = (torrent: TorrentRow): Promise<DownloadSelection> => {
    if (!activeEpisode) return Promise.reject(new Error('Choose an episode first.'));
    return downloadSelectionForEpisode(torrent, activeEpisode);
  };

  // Batch torrents carry other episodes too: any released episode of the
  // season can be queued as a range ("from E3 to E12").
  const batchEpisodes = (): EpisodeSummary[] => episodes.filter(isEpisodeAvailableForContinuation);

  const batchRangeFor = (torrent: TorrentRow): BatchRange | null => {
    if (!torrent.seasonPack || !activeEpisode) return null;
    const numbers = batchEpisodes().map((episode) => episode.episodeNumber);
    if (numbers.length < 2) return null;
    return {
      first: Math.min(...numbers),
      last: Math.max(...numbers),
      current: activeEpisode.episodeNumber,
      selections: (from, to) => batchSelectionsFor(torrent, from, to),
    };
  };

  // Lists the pack's files once and picks each episode from that list.
  // Episodes the pack does not carry are reported, not fatal.
  const batchSelectionsFor = async (torrent: TorrentRow, from: number, to: number) => {
    const targets = batchEpisodes().filter((episode) => episode.episodeNumber >= from && episode.episodeNumber <= to);
    const files = await listTorrentFiles({
      magnetUri: await resolveTorrentSource(torrent),
      torrentUrl: torrent.torrentUrl,
      downloadUrl: torrent.downloadUrl,
      infoHash: torrent.infoHash,
      cat: kind,
    });
    const selections: DownloadSelection[] = [];
    const missing: number[] = [];
    for (const episode of targets) {
      const file = pickEpisodeFile(files, episodeTarget(episode));
      if (file) selections.push(selectionForEpisode(torrent, episode, file));
      else missing.push(episode.episodeNumber);
    }
    return { selections, missing };
  };

  const episodeTarget = (episode: EpisodeSummary) => ({
    season: episode.seasonNumber ?? selectedSeason,
    episode: episode.episodeNumber,
    absolute: episode.absoluteNumber ?? episode.episodeNumber,
  });

  const downloadSelectionForEpisode = async (torrent: TorrentRow, activeEpisode: EpisodeSummary): Promise<DownloadSelection> => {
    // Torrentio names the searched episode's file inside a pack.
    if (!torrent.seasonPack || torrent.fileIndex != null) return selectionForEpisode(torrent, activeEpisode, null);
    const magnet = await resolveTorrentSource(torrent);
    const resolved = await resolveTorrentFile({
      magnetUri: magnet,
      torrentUrl: torrent.torrentUrl,
      downloadUrl: torrent.downloadUrl,
      infoHash: torrent.infoHash,
      cat: kind,
      ...episodeTarget(activeEpisode),
    });
    return selectionForEpisode(torrent, activeEpisode, resolved);
  };

  // packFile is the episode's file inside a season pack (null otherwise).
  const selectionForEpisode = (torrent: TorrentRow, activeEpisode: EpisodeSummary, packFile: ResolvedEpisodeFile | null): DownloadSelection => {
    const fileIndex = packFile ? packFile.fileIndex : torrent.fileIndex;
    const selectedSize = packFile ? packFile.fileLength ?? torrent.size : torrent.size;
    const season = activeEpisode.seasonNumber || selectedSeason;
    const episode = activeEpisode.episodeNumber;
    const seriesId = kind === 'anime' && anilistId
      ? `anilist:${anilistId}`
      : tmdbId
        ? `tmdb:tv:${tmdbId}`
        : '';
    return {
      seriesId,
      sourceId: torrent.sourceId || '',
      sourceKind: kind,
      fileIndex,
      season,
      episode,
      title,
      posterUrl,
      subtitleLabel: `S${season} E${episode}`,
      subtitleHints: { title, year, imdbId },
      ...(activeEpisode.name ? { episodeTitle: activeEpisode.name } : {}),
      ...(activeEpisode.stillUrl ? { stillUrl: activeEpisode.stillUrl } : {}),
      skipQuery: kind === 'anime'
        ? { kind: 'anime', ...(malId ? { malId: String(malId) } : {}), episode: String(activeEpisode.absoluteNumber ?? activeEpisode.episodeNumber) }
        : { kind: 'tv', ...(tmdbId ? { tmdbId: String(tmdbId) } : {}), ...(imdbId ? { imdbId } : {}), season: String(season), episode: String(episode) },
      // A season pack can be tens of gigabytes, but offline download stores
      // only the resolved episode. Use that file for storage checks and copy.
      sizeBytes: selectedSize,
    };
  };

  const resumeAppliesToActiveEpisode = Boolean(
    resumeContext && activeEpisode &&
    resumeContext.season === (activeEpisode.seasonNumber || selectedSeason) &&
    resumeContext.episode === activeEpisode.episodeNumber
  );
  // Memoized re-rank (rerender-memo): mirrors TorrentPanel — busy-flag flips
  // and artwork hydration must not re-rank the whole torrent list.
  const displayedTorrentRows = useMemo(() => {
    const preferredSource = resumeAppliesToActiveEpisode && resumeSource ? resumeSource : historySource;
    return prioritizePreviouslyUsedTorrent(torrentRows || [], preferredSource);
  }, [resumeAppliesToActiveEpisode, resumeSource, historySource, torrentRows]);
  const activeEpisodeIndex = activeEpisode
    ? episodes.findIndex((episode) => episode.id === activeEpisode.id)
    : -1;
  const nextEpisodeCandidate = activeEpisodeIndex >= 0 ? episodes[activeEpisodeIndex + 1] : undefined;
  const nextEpisode = nextEpisodeCandidate && !isEpisodeUpcoming(nextEpisodeCandidate)
    ? nextEpisodeCandidate
    : undefined;
  const closeSourceChooser = () => {
    torrentRequestId.current += 1;
    returnToEpisode.current = activeEpisode?.episodeNumber ?? null;
    setActiveEpisode(null);
    setTorrentRows(null);
    setTorrentError(null);
    setTorrentLoading(false);
  };
  const episodeArtwork = (episode: EpisodeSummary) => episode.stillUrl || null;

  return (
    <aside ref={panelRef} data-source-panel data-source-layout={platform.desktop ? 'desktop' : 'page'} className={`min-w-0 max-w-full scroll-mt-[calc(var(--app-safe-top)+5rem)] [overflow-wrap:anywhere] rounded-xl border border-white/[0.12] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.85)] ${platform.desktop ? 'overflow-hidden bg-[#0a0a0a] lg:bg-[#0a0a0a]/75 lg:backdrop-blur-2xl' : 'bg-[#0a0a0a] min-h-[calc(100dvh-var(--app-safe-top)-8rem)]'}`}>
      {artworkHydrating ? (
        <span className="sr-only" role="status" aria-live="polite">Loading episode artwork.</span>
      ) : null}
      {!activeEpisode ? (
        <>
          <div className="border-b border-white/[0.08] px-5 py-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="type-panel-title text-white">Episodes</h3>
              <span className="text-sm text-white/60">{episodes.length} episodes</span>
            </div>
            <p className="mt-2 text-sm text-white/65">Choose an episode.</p>
            <Select value={String(selectedSeason)} onValueChange={onSeasonChange}>
              <SelectTrigger className="mt-4 min-h-12 w-full rounded-lg border-white/15 bg-transparent text-white/85">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {normalizedSeasons.map((season) => (
                  <SelectItem key={season.seasonNumber} value={String(season.seasonNumber)}>
                    {season.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {seasonLoading ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-white/65" role="status" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading season…
            </div>
          ) : null}
          {seasonError ? <div className="px-5 py-4 text-sm text-red-100" role="alert">{seasonError}</div> : null}

          {/* Mobile: the list is PART OF THE PAGE — it flows in full and the
              page scrolls through it (scrolling episodes hides the header
              info naturally). Desktop keeps the bounded, internally-scrolling
              card. */}
          <div className={`app-scrollbar ${platform.desktop ? 'sm:max-h-[580px] sm:overflow-y-auto sm:overscroll-contain' : ''}`}>
            {watchedError ? <p className="type-secondary px-4 py-2 text-red-300" role="alert">{watchedError}</p> : null}
            {episodes.map((episode) => {
              const artwork = episodeArtwork(episode);
              const isUpcoming = isEpisodeUpcoming(episode);
              const releaseLabel = formatAirDate(episode.availableAt || episode.airDate);
              const watchState = watchedMap.get(watchedKey(episode.seasonNumber || selectedSeason, episode.episodeNumber));
              const watched = watchState?.watched === true;
              const partial = !watched && watchState && watchState.percent > 0 ? Math.min(100, watchState.percent) : 0;
              return (
                <div key={episode.id} className="content-auto-row flex items-center border-b border-white/[0.08] last:border-b-0">
                <button
                  type="button"
                  ref={(element) => {
                    if (element) episodeButtons.current.set(episode.episodeNumber, element);
                    else episodeButtons.current.delete(episode.episodeNumber);
                  }}
                  disabled={isUpcoming}
                  aria-label={isUpcoming
                    ? `${episode.name}, coming soon${releaseLabel ? ` on ${releaseLabel}` : ''}`
                    : episode.name}
                  className="group flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 pr-2 text-left transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:bg-transparent disabled:opacity-70"
                  onClick={() => void fetchTorrentsForEpisode(episode)}
                >
                  <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-white/[0.04] sm:w-32">
                    <EpisodeArtworkMedia
                      key={artwork || `missing-${episode.id}`}
                      src={artwork}
                      hydrating={artworkHydrating}
                      lazy
                      interactive
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    <span className="type-caption text-numeric absolute bottom-1.5 left-2 font-medium text-white/90">
                      EP {String(episode.episodeNumber).padStart(2, '0')}
                    </span>
                    {partial ? (
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20" aria-hidden="true">
                        <div className="h-full bg-white" style={{ width: `${partial}%` }} />
                      </div>
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="line-clamp-2 text-sm font-medium leading-5 text-white/90">{episode.name}</div>
                      {isUpcoming ? (
                        <span className="type-caption shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-white/70">
                          Coming soon
                        </span>
                      ) : null}
                    </div>
                    {episode.overview ? (
                      <p className="type-secondary mt-1 line-clamp-2 text-white/65">{episode.overview}</p>
                    ) : null}
                    <div className="type-caption text-numeric mt-1.5 flex flex-wrap gap-x-2 text-white/65">
                      {watched ? <span className="text-white/85">Watched</span> : null}
                      {releaseLabel ? <span>{releaseLabel}</span> : null}
                      {episode.runtime ? <span>{episode.runtime} min</span> : null}
                    </div>
                  </div>
                  {isUpcoming ? (
                    <Clock3 className="h-4 w-4 shrink-0 text-white/35" aria-hidden="true" />
                  ) : watchedSeriesId ? null : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-white/20 transition group-hover:translate-x-0.5 group-hover:text-white/55" aria-hidden="true" />
                  )}
                </button>
                {!isUpcoming && watchedSeriesId ? (
                  <button
                    type="button"
                    onClick={() => void toggleWatched(episode)}
                    aria-pressed={watched}
                    aria-label={`${watched ? 'Mark unwatched' : 'Mark watched'}: episode ${episode.episodeNumber}`}
                    title={watched ? 'Mark unwatched' : 'Mark watched'}
                    className="mr-2 inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  >
                    {watched
                      ? <CheckCircle2 className="h-6 w-6 fill-white text-black" aria-hidden="true" />
                      : <Circle className="h-6 w-6 text-white/35" aria-hidden="true" />}
                  </button>
                ) : null}
              </div>
              );
            })}
            {!seasonLoading && episodes.length === 0 ? (
              <div className="space-y-4 px-5 py-6 text-sm text-white/70">
                <p>Episode details are unavailable. Enter an episode number.</p>
                <form className="flex items-end gap-3" onSubmit={(event) => {
                  event.preventDefault();
                  const number = Number(manualEpisode);
                  if (!Number.isInteger(number) || number < 1 || number > 10000) return;
                  void fetchTorrentsForEpisode({ id: number, episodeNumber: number, absoluteNumber: kind === 'anime' ? number : undefined, seasonNumber: selectedSeason, name: `Episode ${number}`, continuationAvailable: false });
                }}>
                  <label className="min-w-0 flex-1">Episode number
                    <input aria-label="Episode number" type="number" inputMode="numeric" min="1" max="10000" required value={manualEpisode} onChange={(event) => setManualEpisode(event.target.value)} className="mt-2 min-h-12 w-full rounded-lg border border-white/20 bg-black px-3 text-base text-white" />
                  </label>
                  <button type="submit" className="min-h-12 rounded-lg bg-white px-4 text-black">Find sources</button>
                </form>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="source-episode-header border-b border-white/[0.08] px-5 py-4">
            <button
              type="button"
              onClick={closeSourceChooser}
              data-back-to-episodes
              className="type-secondary inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 font-medium text-white/70 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to episodes
            </button>
            <div className="source-episode-summary mt-4 flex items-center gap-3">
              <div className="source-episode-artwork relative aspect-video w-[112px] shrink-0 overflow-hidden rounded-md border border-white/[0.1] bg-white/[0.04]">
                <EpisodeArtworkMedia
                  key={episodeArtwork(activeEpisode) || `missing-active-${activeEpisode.id}`}
                  src={episodeArtwork(activeEpisode)}
                  hydrating={artworkHydrating}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
                <span className="type-caption text-numeric absolute bottom-1.5 left-2 font-medium text-white/90">
                  EP {String(activeEpisode.episodeNumber).padStart(2, '0')}
                </span>
              </div>
              <div className="min-w-0">
                <h3 ref={sourceHeadingRef} data-source-heading tabIndex={-1} className="line-clamp-2 text-base text-white/85 outline-none">{activeEpisode.name}</h3>
                <p className="type-secondary mt-1 text-white/65">Season {activeEpisode.seasonNumber ?? selectedSeason} · Episode {activeEpisode.episodeNumber}</p>
                {activeEpisode.availableAt || activeEpisode.airDate ? (
                  <p className="source-episode-date type-secondary text-numeric mt-1 text-white/65">{formatAirDate(activeEpisode.availableAt || activeEpisode.airDate)}</p>
                ) : null}
              </div>
            </div>
          </div>

          {torrentLoading ? (
            <div className="flex items-center gap-2 px-5 py-8 text-sm text-white/65" role="status" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              Finding sources for episode {activeEpisode.episodeNumber}…
            </div>
          ) : null}

          {torrentError ? (
            <div className="border-b border-white/[0.08] px-5 py-4 text-sm text-red-100" role="alert">
              <p>{torrentError}</p>
              {platform.desktop ? (
                <button
                  type="button"
                  onClick={() => platform.desktop?.openSetup()}
                  className="mt-3 min-h-12 rounded-lg border border-white/20 px-4 text-sm text-white/85 transition hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Open settings
                </button>
              ) : null}
            </div>
          ) : null}

          {!torrentLoading && !torrentError && torrentRows && displayedTorrentRows.length === 0 ? (
            <div className="type-body px-5 py-8 text-center text-white/70">No sources found for this episode.</div>
          ) : null}

          {torrentRows && displayedTorrentRows.length > 0 ? (
          <div className={`app-scrollbar ${platform.desktop ? 'sm:max-h-[580px] sm:overflow-y-auto sm:overscroll-contain' : ''}`}>
              <div className="flex items-center justify-between gap-3 px-5 py-3">
                <p className="type-secondary font-medium text-white/65">Available sources</p>
                {nextEpisode ? (
                  <button
                    type="button"
                    onClick={() => void fetchTorrentsForEpisode(nextEpisode)}
                    className="type-caption inline-flex min-h-11 items-center gap-1 rounded-md px-2 font-medium text-white/70 transition hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  >
                    Next episode {nextEpisode.episodeNumber}
                    <ChevronRight className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
              {displayedTorrentRows.map((torrent) => {
                const torrentRowKey = rowKey(torrent);
                return (
                  <div key={torrentRowKey} className={`content-auto-row border-t border-white/[0.08] px-5 py-4 ${torrent.previouslyUsed ? 'bg-white/[0.035]' : ''}`}>
                    <div className="flex items-center justify-between gap-3">
                      <button type="button" aria-label={`Play source ${torrent.title}`} onClick={() => void playTorrent(torrent)} disabled={Boolean(playBusyId || externalBusyId)} className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white text-black disabled:opacity-50 sm:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                        {playBusyId === torrentRowKey ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Play className="h-5 w-5 fill-current" aria-hidden="true" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="line-clamp-2 text-sm leading-5 text-white/80" title={torrent.title}>{torrent.title}</div>
                          {torrent.previouslyUsed ? (
                            <span className="type-caption shrink-0 rounded border border-white/40 px-1.5 py-0.5 font-medium text-white">Previously used</span>
                          ) : null}
                          {torrent.reusedSeasonPack ? (
                            <span className="type-caption shrink-0 rounded border border-white/25 px-1.5 py-0.5 font-medium text-white/85">Same batch</span>
                          ) : null}
                        </div>
                        <div className="type-caption text-numeric mt-1 text-white/70">
                          <span>{torrent.indexer || 'Unknown indexer'}</span>
                          {torrent.pack ? (
                            <span> · {PACK_LABELS[torrent.pack]}</span>
                          ) : torrent.episodeMatch && !torrent.seasonPack ? (
                            <span> · Exact episode</span>
                          ) : torrent.seasonPack ? (
                            <span> · Batch</span>
                          ) : null}
                          {torrent.quality ? <span> · {torrent.quality}</span> : null}
                          {torrent.audio ? <span> · {torrent.audio}</span> : null}
                          {torrent.seeders ? <span> · {torrent.seeders} seeders</span> : null}
                          {torrent.size ? <span> · {formatBytes(torrent.size)}</span> : null}
                        </div>
                      </div>
                      <div className="hidden shrink-0 gap-2 sm:flex">
                        <PlaybackSplitButton
                          onPlay={() => void playTorrent(torrent)}
                          onOpenExternal={() => void downloadTorrentM3U(torrent)}
                          disabled={Boolean(playBusyId || externalBusyId)}
                          playBusy={playBusyId === torrentRowKey}
                          externalBusy={externalBusyId === torrentRowKey}
                        />
                        <NativeDownloadButton
                          selection={() => downloadSelectionFor(torrent)}
                          details={downloadDetailsFor(torrent)}
                          batch={batchRangeFor(torrent)}
                          onError={setTorrentError}
                        />
                      </div>
                    </div>
                    <NativeDownloadButton
                      className="mt-3 w-full sm:hidden"
                      selection={() => downloadSelectionFor(torrent)}
                      details={downloadDetailsFor(torrent)}
                      batch={batchRangeFor(torrent)}
                      onError={setTorrentError}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
