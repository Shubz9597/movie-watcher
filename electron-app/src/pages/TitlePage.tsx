import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { userMessage } from '../lib/user-error';
import { nextUpEpisode } from '../lib/next-up';
import { movieRelease, formatReleaseDate } from '../lib/movie-release';
import { CheckCircle2, Download, ExternalLink, Play, RotateCcw, ListVideo, Youtube } from 'lucide-react';
import { fetchWatched, setWatched, watchedKey } from '../lib/services/watched-service';
import { PageBackButton } from '../components/shared/PageBackButton';
import { Button } from '../components/ui/button';
import EpisodePanel, { type NextUp } from '../components/EpisodePanelWrapper';
import TorrentPanel from '../components/TorrentPanel';
import { useConnectionStatus, usePlatform } from '../platform/PlatformProvider';
import { getAnimeEpisodeMetadata } from '../lib/services/catalog-gateway';
import { bffEpisodes, bffTitleDetail } from '../lib/services/catalog-bff';
import { getVodBase } from '../lib/api-client';
import { getDeviceId } from '../lib/device-id';
import { getIMDbRating } from '../lib/services/imdb-service';
import { detailFromBackendTitle, type Detail } from '../lib/adapters/media';
import { getSavedResumeSource } from '../lib/services/continue-service';
import { useLibrary, useLibrarySelector } from '../lib/library-react';
import { LibraryToggle } from '../components/shared/LibraryToggle';
import { usePullToRefresh } from '../lib/pull-to-refresh';
import type { ResumeSourceContext, SavedResumeSource } from '../lib/types';
import { nativeDownloadsSupported } from '../mobile/download-queue';
import type { NavigateOptions } from '../lib/router-adapter';

// rerender-memo-with-default-value: stable fallback so EpisodePanel's props
// keep their identity while seasons load or a season list is unavailable.
const DEFAULT_SINGLE_SEASON = [{ seasonNumber: 1, name: 'Season 1' }];

function IMDbMark({ className = '' }: { className?: string }) {
  return (
    <span
      aria-label="IMDb"
      className={`inline-flex h-[1.15rem] min-w-[2rem] items-center justify-center rounded-[3px] border border-white/35 px-1 font-sans text-[0.62rem] font-black leading-none tracking-[-0.035em] text-white/85 ${className}`}
    >
      IMDb
    </span>
  );
}
// Module scope (perf): Intl.DisplayNames resolves locale data; constructing
// it on every render is wasted work. Constructed once per JS context.
const languageFormatter =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'language' })
    : null;

/** The synopsis: four lines on phones with "More"; whole on wide screens. */
function TitleOverview({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return (
    <div>
      <p ref={ref} className={`measure-prose type-body text-white/75 ${open ? '' : 'max-sm:line-clamp-4'}`}>{text}</p>
      {overflows || open ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="title-more mt-1 min-h-10 rounded-lg text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
          {open ? 'Less' : 'More'}
        </button>
      ) : null}
    </div>
  );
}

// Title tools: icon over a short label (Apple TV / Netflix style), one size.
const STACKED_ACTION_CLASS = 'title-action inline-flex min-h-14 min-w-[4.5rem] flex-col items-center justify-center gap-1 rounded-lg px-1 text-[12px] font-medium text-white/75 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70';

export default function TitlePage({
  navigate,
  kind,
  id,
  params,
}: {
  navigate: (path: string, params?: Record<string, string>, options?: NavigateOptions) => void;
  kind: string;
  id: string;
  params?: Record<string, string>;
}) {
  const platform = usePlatform();
  const library = useLibrary();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [seasons, setSeasons] = useState<any[]>([]);
  const [initialSeason, setInitialSeason] = useState(1);
  const [initialEpisodes, setInitialEpisodes] = useState<any[]>([]);
const [loading, setLoading] = useState(true);
const [loadError, setLoadError] = useState<string | null>(null);
const loadErrorRef = useRef<string | null>(null);
loadErrorRef.current = loadError;
// Application-wide pull-to-refresh: bumped to refetch the whole detail.
const [refreshKey, setRefreshKey] = useState(0);
// The server came back (a dropped connection, a restart): load again by
// itself instead of leaving the error up.
const connection = useConnectionStatus();
const wasReady = useRef(true);
useEffect(() => {
  const ready = connection.status === 'ready';
  if (ready && !wasReady.current && loadErrorRef.current) setRefreshKey((key) => key + 1);
  wasReady.current = ready;
}, [connection.status]);
const { indicator: pullIndicator } = usePullToRefresh(() => setRefreshKey((key) => key + 1));
  const [isAnimeMovie, setIsAnimeMovie] = useState(false);
  const [episodeArtworkHydrating, setEpisodeArtworkHydrating] = useState(false);
  const [readyHeroUrl, setReadyHeroUrl] = useState('');
  const requestedSeason = Number(params?.season ?? params?.resumeSeason);
  const requestedEpisode = Number(params?.episode ?? params?.resumeEpisode);
  const resumeSeason = Number(params?.resumeSeason);
  const resumeEpisode = Number(params?.resumeEpisode);
  const isTmdbBackedAnime = kind === 'anime' && params?.provider === 'tmdb';
  const tmdbAnimeMediaKind = params?.mediaKind === 'movie' ? 'movie' : 'tv';
  // Library membership (M3.3): the canonical id comes from the route's
  // explicit media namespace — the same qualified identity rule as detail
  // requests. It is never the ambiguous tmdb:N form and the qualifier is
  // never stripped.
  const libraryCanonicalId = !id
    ? null
    : kind === 'movie'
      ? `tmdb:movie:${id}`
      : kind === 'tv'
        ? `tmdb:tv:${id}`
        : isTmdbBackedAnime
          ? `tmdb:${tmdbAnimeMediaKind}:${id}`
          : kind === 'anime'
            ? `anilist:${id}`
            : null;
  // Sliced subscription (perf): TitlePage is the heaviest tree in the app
  // (hero, cast, up to 1000 episode rows) — it must NOT re-render on every
  // library publish (toggle taps, 15s sync polls) just to read availability.
  const libraryAvailability = useLibrarySelector(library, (snapshot) => snapshot?.availability);
  const libraryAvailable = Boolean(libraryAvailability === 'available' && libraryCanonicalId);
  const resumeContext = useMemo<ResumeSourceContext | null>(() => {
    const subjectId = params?.resumeSubjectId?.trim();
    const seriesId = params?.resumeSeriesId?.trim();
    if (!subjectId || !seriesId || !Number.isInteger(resumeSeason) || !Number.isInteger(resumeEpisode)) return null;
    if (resumeSeason < 0 || resumeEpisode < 0) return null;
    return { subjectId, seriesId, season: resumeSeason, episode: resumeEpisode };
  }, [params?.resumeSubjectId, params?.resumeSeriesId, resumeSeason, resumeEpisode]);
  const [resumeSource, setResumeSource] = useState<SavedResumeSource | null>(null);
  // Scroll target for the compact "Find sources" action; the ref must be
  // created unconditionally (before any early return) to keep hook order.
  const sourcesSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!resumeContext) {
      setResumeSource(null);
      return;
    }
    let cancelled = false;
    setResumeSource(null);
    void getSavedResumeSource(resumeContext)
      .then((result) => {
        if (cancelled) return;
        if (result.found) {
          setResumeSource(result.source);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('[TitlePage] Failed to restore the previous source:', error);
        setResumeSource(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resumeContext]);

  useEffect(() => {
    let cancelled = false;

    const enrichIMDb = (imdbId?: string) => {
      if (!imdbId) return;
      void getIMDbRating(imdbId)
        .then((imdb) => {
          if (cancelled || !imdb) return;
          setDetail((current) => current?.imdbId === imdb.imdbId
            ? { ...current, imdbRating: imdb.rating, imdbVotes: imdb.votes }
            : current);
        })
        .catch((error: unknown) => {
          if (!cancelled) console.warn('[TitlePage] IMDb rating is unavailable:', error);
        });
    };

    const publishDetail = (next: Detail) => {
      setDetail(next);
      enrichIMDb(next.imdbId);
    };

    const enrichAnimeEpisodeArtwork = (anilistId: number) => {
      setEpisodeArtworkHydrating(true);
      console.info('[TitlePage] Episode artwork hydration starting for anilist id:', anilistId);
      void getAnimeEpisodeMetadata(anilistId)
        .then((metadata) => {
          console.info('[TitlePage] Episode artwork hydration finished:', metadata.size, 'stills for anilist', anilistId);
          if (cancelled || metadata.size === 0) return;
          setInitialEpisodes((current) => current.map((episode) => ({
            ...episode,
            stillUrl: episode.stillUrl || metadata.get(episode.episodeNumber)?.stillUrl,
          })));
        })
        .finally(() => {
          if (!cancelled) setEpisodeArtworkHydrating(false);
        });
    };

    // Catalog helpers (T042.3): map contract responses onto the episode
    // shapes the panel consumes. Absolute server stills stay untouched.
    type BffEpisodeRow = {
      id: number;
      episodeNumber: number;
      absoluteNumber: number;
      seasonNumber: number;
      name: string;
      overview?: string;
      airDate?: string;
      stillUrl?: string;
      runtime?: number;
      continuationAvailable?: boolean;
    };

    const stillUrlFrom = (still: string | null | undefined) =>
      still ? (still.startsWith('http') ? still : `https://image.tmdb.org/t/p/w780${still}`) : undefined;

    const bffEpisodeRows = async (catalogId: string, season: number): Promise<BffEpisodeRow[]> => {
      const rows = await bffEpisodes(catalogId, season);
      return rows.map((episode) => ({
        id: episode.episode,
        episodeNumber: episode.episode,
        absoluteNumber: episode.absolute || episode.episode,
        seasonNumber: episode.season || season,
        name: episode.title || `Episode ${episode.episode}`,
        overview: episode.overview,
        airDate: episode.airDate,
        stillUrl: stillUrlFrom(episode.still),
        runtime: episode.duration_s ? Math.round(episode.duration_s / 60) : undefined,
        continuationAvailable: true,
      }));
    };

    const loadBffTitle = async () => {
      // M3.1.1: detail requests use the media-qualified canonical id built
      // from the route's explicit media namespace (kind / mediaKind) — the
      // unqualified `tmdb:N` form is a read-only legacy alias, never a
      // detail lookup.
      if (kind === 'movie' || (isTmdbBackedAnime && tmdbAnimeMediaKind === 'movie')) {
        const row = await bffTitleDetail(`tmdb:movie:${id}`);
        publishDetail(detailFromBackendTitle(row));
        setIsAnimeMovie(isTmdbBackedAnime || row.anime === true);
        setSeasons([]);
        setInitialEpisodes([]);
        return;
      }

      if (kind === 'tv' || (isTmdbBackedAnime && tmdbAnimeMediaKind === 'tv')) {
        // No season asked for: open on the one you're up to (Kai after
        // Season 1's last episode opens on Season 2), read alongside detail.
        const watchedRequest = Number.isInteger(requestedSeason)
          ? Promise.resolve(null)
          : fetchWatched(`tmdb:tv:${id}`).catch(() => null);
        const row = await bffTitleDetail(`tmdb:tv:${id}`);
        publishDetail(detailFromBackendTitle(row));
        setIsAnimeMovie(false); // a show, anime or not
        const seasonsData = (row.seasons ?? [])
          .filter((season) => season.number >= 0 && (season.episodeCount ?? 0) > 0)
          .map((season) => ({
            seasonNumber: season.number,
            name: season.name || `Season ${season.number}`,
            episodeCount: season.episodeCount,
            airDate: season.airDate,
            posterUrl: season.poster,
          }))
          // Specials go last, so a show opens on season 1, not its extras.
          .sort((left, right) => (left.seasonNumber === 0 ? 1 : 0) - (right.seasonNumber === 0 ? 1 : 0) || left.seasonNumber - right.seasonNumber);
        setSeasons(seasonsData);
        const marks = await watchedRequest;
        const upTo = marks ? nextUpEpisode(
          marks.values(),
          seasonsData.map((season: any) => season.seasonNumber),
          (number) => seasonsData.find((season: any) => season.seasonNumber === number)?.episodeCount ?? 0,
          isTmdbBackedAnime,
        ) : null;
        const firstSeason = Number.isInteger(requestedSeason) && seasonsData.some((s: any) => s.seasonNumber === requestedSeason)
          ? requestedSeason
          : upTo && seasonsData.some((s: any) => s.seasonNumber === upTo.season)
            ? upTo.season
            : seasonsData[0]?.seasonNumber ?? 1;
        setInitialSeason(firstSeason);
        // Episodes resolve SERVER-SIDE (BFF → TMDb): a direct client
        // api.themoviedb.org call from the phone WebView is the flaky link
        // (ISP peering) and broke anime episodes + stills on device.
        setInitialEpisodes(await bffEpisodeRows(`tmdb:tv:${id}`, firstSeason));
        return;
      }

      // Anime (AniList-id route): the server detail already merges
      // AniList/Jikan/Cinemeta enrichment, so no client-side Jikan fallback.
      // Detail and episodes are independent — fetch in parallel (one RTT
      // saved on every anime title page); `row` is only needed for the
      // skeleton fallback count when the episode list comes back empty.
      const catalogId = `anilist:${id}`;
      const seasonNumber = Number.isInteger(requestedSeason) && requestedSeason > 0 ? requestedSeason : 1;
      const [row, episodeRows] = await Promise.all([
        bffTitleDetail(catalogId),
        bffEpisodeRows(catalogId, seasonNumber).catch((error) => {
          // Episode artwork/titles may be unavailable while the catalog still
          // knows the episode count. Keep those numbered episodes usable.
          console.warn('[TitlePage] Episode metadata unavailable; using the catalog count.', error);
          return [] as BffEpisodeRow[];
        }),
      ]);
      // An AniList entry (one season or arc) opens as its season of the
      // show, the one page with every season as Stremio lists them; the
      // show also holds its watch progress, so resume links follow.
      const series = row.series;
      if (series?.id.startsWith('tmdb:tv:') && series.season > 0) {
        const offset = series.episodeOffset ?? 0;
        const next: Record<string, string> = {
          kind: 'anime', provider: 'tmdb', mediaKind: 'tv',
          id: series.id.slice('tmdb:tv:'.length), season: String(series.season),
        };
        if (!series.absolute && Number.isInteger(requestedEpisode) && requestedEpisode > 0) {
          next.episode = String(requestedEpisode + offset);
        }
        if (params?.resumeSubjectId && !series.absolute && Number.isInteger(resumeEpisode) && resumeEpisode > 0) {
          next.resumeSubjectId = params.resumeSubjectId;
          next.resumeSeriesId = series.id;
          next.resumeSeason = String(series.season);
          next.resumeEpisode = String(resumeEpisode + offset);
        }
        navigate('title', next, { replace: true });
        return;
      }
      publishDetail(detailFromBackendTitle(row));
      let episodes: BffEpisodeRow[] = episodeRows;
      if (episodes.length === 0) {
        const knownCount = row.seasons?.find((season) => season.number === seasonNumber)?.episodeCount ?? 0;
        episodes = Array.from({ length: Math.min(1000, Math.max(
          knownCount,
          Number.isInteger(requestedEpisode) && requestedEpisode > 0 ? requestedEpisode : 0,
        )) }, (_, index) => {
          const episodeNumber = index + 1;
          return {
            id: episodeNumber,
            episodeNumber,
            absoluteNumber: episodeNumber,
            seasonNumber,
            name: `Episode ${episodeNumber}`,
            airDate: undefined,
            continuationAvailable: undefined,
          } as BffEpisodeRow;
        });
      }
      if (Number.isInteger(requestedEpisode) && requestedEpisode > 0 &&
          !episodes.some((episode) => episode.episodeNumber === requestedEpisode)) {
        episodes.push({
          id: requestedEpisode,
          episodeNumber: requestedEpisode,
          absoluteNumber: requestedEpisode,
          seasonNumber,
          name: `Episode ${requestedEpisode}`,
          airDate: undefined,
          continuationAvailable: false,
        });
        episodes.sort((left, right) => left.episodeNumber - right.episodeNumber);
      }
      setIsAnimeMovie(false);
      setSeasons([{ seasonNumber, name: `Season ${seasonNumber}` }]);
      setInitialSeason(seasonNumber);
      setInitialEpisodes(episodes);
      // Stills hydration: `id` IS the AniList id for this route, and the metadata service falls back to AniList streaming
      // thumbnails when ani.zip is unavailable.
      if (episodes.some((episode) => !episode.stillUrl)) {
        enrichAnimeEpisodeArtwork(Number(id));
      }
    };

    async function load() {
      try {
        setLoading(true);
        setLoadError(null);
        setDetail(null);
        setEpisodeArtworkHydrating(false);
        console.log('[TitlePage] Loading', kind, id);

        // Detail, seasons and episodes resolve through the /v2/catalog/*
        // contract (T042.3).
        await loadBffTitle();
      } catch (err) {
        console.error('[TitlePage] Failed to load title:', err);
        setLoadError(err instanceof Error ? err.message : 'Couldn’t load this title.');
      } finally {
        setLoading(false);
      }
    }
    if (!id) {
      setDetail(null);
      setLoadError('This title link is incomplete.');
      setLoading(false);
      return;
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [kind, id, params?.malId, requestedSeason, requestedEpisode, isTmdbBackedAnime, tmdbAnimeMediaKind, refreshKey]);

  // Taste signal (v2 recommendation engine): a bounded fire-and-forget
  // "opened title" ping. The server deduplicates per device+title; failures
  // are invisible by contract.
  const visitedCanonicalId = !id
    ? null
    : kind === 'movie'
      ? `tmdb:movie:${id}`
      : kind === 'tv'
        ? `tmdb:tv:${id}`
        : isTmdbBackedAnime
          ? `tmdb:${tmdbAnimeMediaKind}:${id}`
          : `anilist:${id}`;
  useEffect(() => {
    if (!visitedCanonicalId) return;
    const visitedKind = kind === 'anime' && !isTmdbBackedAnime ? 'anime' : kind;
    fetch(`${getVodBase()}/v1/taste/visited`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId: getDeviceId(),
        canonicalId: visitedCanonicalId,
        kind: visitedKind,
      }),
      signal: AbortSignal.timeout(8000),
      keepalive: true,
    }).catch(() => {});
  }, [visitedCanonicalId, kind, isTmdbBackedAnime, tmdbAnimeMediaKind]);

  // Movies: one watched toggle (season 0 / episode 0 on the progress record).
  const movieWatchId = (kind === 'movie' || isAnimeMovie) ? libraryCanonicalId : null;
  const [movieWatched, setMovieWatched] = useState(false);
  useEffect(() => {
    if (!movieWatchId) return;
    let cancelled = false;
    void fetchWatched(movieWatchId)
      .then((map) => { if (!cancelled) setMovieWatched(map.get(watchedKey(0, 0))?.watched === true); })
      .catch(() => { /* offline or older server: no watched mark */ });
    return () => { cancelled = true; };
  }, [movieWatchId]);
  const toggleMovieWatched = async () => {
    if (!movieWatchId) return;
    const next = !movieWatched;
    setMovieWatched(next);
    try {
      await setWatched(movieWatchId, [{ season: 0, episode: 0 }], next);
    } catch {
      setMovieWatched(!next);
    }
  };

  // Series Play: next episode from the watched marks (set by the episode
  // list) and the request that opens it there. Hooks stay above the early
  // returns below.
  const [nextUp, setNextUp] = useState<NextUp | null>(null);
  const [openRequest, setOpenRequest] = useState<{ season: number; episode: number; nonce: number } | null>(null);

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-[1600px] items-center px-5 md:px-8 lg:px-12">
        <div className="w-full max-w-2xl animate-pulse">
          <div className="h-3 w-24 rounded bg-white/10" />
          <div className="mt-6 h-16 w-3/4 rounded bg-white/10" />
          <div className="mt-8 h-4 w-full rounded bg-white/[0.06]" />
          <div className="mt-3 h-4 w-2/3 rounded bg-white/[0.06]" />
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="measure-compact type-body text-white/75">{userMessage(loadError, 'Couldn’t load this title.')}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Try again
          </button>
          <PageBackButton />
        </div>
      </div>
    );
  }

  const languageName = detail.originalLanguage && languageFormatter ? languageFormatter.of(detail.originalLanguage) : null;

  const formatRuntime = (minutes?: number | null) => {
    if (!minutes) return null;
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (!hrs) return `${mins}m`;
    if (!mins) return `${hrs}h`;
    return `${hrs}h ${mins}m`;
  };

  const formatNumber = (n?: number | null) => {
    if (typeof n !== 'number') return null;
    return n.toLocaleString();
  };

  const runtimeLabel = formatRuntime(detail.runtime);
  const metaBadges = [
    runtimeLabel,
    detail.year ? `${detail.year}` : null,
    detail.tmdbRatingPct
      ? `${detail.tmdbRatingPct}% ${kind === 'anime' && !isTmdbBackedAnime ? 'AniList' : 'TMDB'}`
      : null,
  ].filter(Boolean);
  // Genres join the details line on wide screens; on phones they get their
  // own line (one line wrapping left a stray separator at a line start).
  const genreLabel = (detail.genres ?? []).slice(0, 3).join(' · ');

  const heroBackground = detail.backdropUrl || detail.posterUrl || null;
  const isMovie = kind === 'movie' || isAnimeMovie;
  // Films not out yet (like an episode's "Coming soon"): no Play, no source
  // search; in cinemas only, a note that copies are usually camera ones.
  const release = isMovie ? movieRelease(detail) : { state: 'released' as const };
  const releaseNote = release.state === 'upcoming'
    ? [`In cinemas ${formatReleaseDate(release.releaseDate)}`, release.digitalRelease ? `to stream from ${formatReleaseDate(release.digitalRelease)}` : null].filter(Boolean).join(' · ')
    : release.state === 'theatres'
      ? `In cinemas now · to stream from ${formatReleaseDate(release.digitalRelease)}. Until then, copies are usually filmed in the cinema.`
      : null;

  // WF03 compact toolbar (M2.3): bare Back / save / source tools. Save
  // actions are DISABLED and truthful — library persistence lands with M3,
  // so nothing here implies a saved change. Play appears only when a
  // previously-used source can actually be resumed; otherwise the primary
  // path is choosing a source in the panel below.
  const canDirectResume = Boolean(resumeSource?.sourceUri && resumeSource.sourceUri.startsWith('magnet:'));
  const scrollToSources = () => {
    sourcesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // Series: Play opens the next episode from this device's watched marks in
  // the episode list below (its sources load there; the source is still
  // chosen by hand). Without watch history it shows the sources as before.
  const playNextUp = () => {
    if (!nextUp) {
      scrollToSources();
      return;
    }
    setOpenRequest({ season: nextUp.season, episode: nextUp.episode, nonce: Date.now() });
    scrollToSources();
  };
  const playLabel = canDirectResume
    ? 'Resume'
    : nextUp && !isMovie
      ? `${nextUp.started ? 'Resume' : 'Play'} S${nextUp.season} E${nextUp.episode}`
      : 'Play';

  const playResume = () => {
    if (!canDirectResume || !resumeSource) return;
    const params: Record<string, string> = {
      magnet: resumeSource.sourceUri,
      title: detail.title,
      cat: isAnimeMovie || kind === 'anime' || detail.anime ? 'anime' : kind === 'movie' ? 'movie' : 'tv',
      sourceName: resumeSource.sourceName || 'Previously used source',
    };
    if (resumeContext) {
      params.seriesId = resumeContext.seriesId;
      params.season = String(resumeContext.season);
      params.episode = String(resumeContext.episode);
    }
    if (kind === 'movie' || isTmdbBackedAnime || kind === 'tv') params.tmdbId = String(id);
    if (detail.malId) params.malId = String(detail.malId);
    if (resumeSource.fileIndex != null) params.fileIndex = String(resumeSource.fileIndex);
    if (detail.year) params.year = String(detail.year);
    navigate('player', params);
  };

  return (
    <div className="title-page relative isolate min-h-screen px-5 pb-14 pt-6 md:px-8 lg:px-12">
      {pullIndicator}
      <div className="title-backdrop pointer-events-none fixed inset-0 -z-10 bg-[#0a0a0a]">
        {heroBackground ? (
          <img
            key={heroBackground}
            src={heroBackground}
            alt=""
            fetchPriority="high"
            decoding="async"
            onLoad={() => setReadyHeroUrl(heroBackground)}
            className={`h-full w-full object-cover brightness-[0.4] transition-opacity duration-200 ease-out motion-reduce:transition-none ${
              readyHeroUrl === heroBackground ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ) : null}
      </div>
      <div className="title-scrim pointer-events-none fixed inset-0 -z-10 bg-gradient-to-r from-[#0a0a0a] via-[#0a0a0a]/85 to-[#0a0a0a]/20" />
      <div className="title-scrim title-scrim--bottom pointer-events-none fixed inset-0 -z-10 bg-gradient-to-t from-[#0a0a0a] via-transparent to-black/15" />

      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="title-topline flex flex-wrap items-center justify-between gap-3 text-sm text-white">
          <div className="hidden lg:block"><PageBackButton /></div>
          <div className="type-caption text-numeric flex flex-wrap items-center gap-2 font-medium text-white/70">
            {release.state !== 'released' ? (
              <span className="rounded-full border border-[#ffc285]/40 bg-black/20 px-3 py-1.5 text-[#ffc285] backdrop-blur">
                {release.state === 'upcoming' ? 'Coming soon' : 'In cinemas'}
              </span>
            ) : null}
            <span className="rounded-full border border-white/15 bg-black/20 px-3 py-1.5 backdrop-blur">
              {isAnimeMovie ? 'Anime Movie' : kind === 'anime' || detail.anime ? (isMovie ? 'Anime Movie' : 'Anime Series') : kind === 'tv' ? 'Series' : 'Movie'}
            </span>
            {languageName ? (
              <span className="rounded-full border border-white/15 bg-black/20 px-3 py-1.5 backdrop-blur">{languageName}</span>
            ) : null}
            {detail.imdbId && !detail.imdbRating ? (
              <a
                href={`https://www.imdb.com/title/${detail.imdbId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/20 px-3 py-1.5 text-white/65 backdrop-blur transition hover:border-white/35 hover:text-white"
              >
                <IMDbMark /> <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
          </div>
        </div>

        <div className={`mt-8 grid min-w-0 grid-cols-1 gap-12 ${platform.desktop ? 'lg:grid-cols-[minmax(0,1fr)_440px] xl:gap-16' : ''}`}>
          <div className="relative min-w-0 max-w-4xl space-y-7 [overflow-wrap:anywhere]">

            <div className="space-y-3">
              <h1 className="type-feature-title !text-[2rem] !leading-[2.375rem] text-white md:!text-[4.5rem] md:!leading-[1.02]">{detail.title}</h1>
              {detail.tagline ? <p className="measure-compact type-body text-white/70">{detail.tagline}</p> : null}
              <div className="type-secondary text-numeric flex flex-wrap items-center gap-2 text-white/70">
                {metaBadges.map((item, index) => (
                  <span key={item} className="inline-flex items-center gap-2">
                    {index > 0 ? <span className="text-white/25">·</span> : null}
                    {item}
                  </span>
                ))}
                {genreLabel ? (
                  <span className="hidden items-center gap-2 sm:inline-flex">
                    {metaBadges.length > 0 ? <span className="text-white/25">·</span> : null}
                    {genreLabel}
                  </span>
                ) : null}
                {detail.imdbRating ? (
                  <span className="inline-flex items-center gap-2">
                    {metaBadges.length > 0 ? <span className="text-white/25">·</span> : null}
                    <a
                      href={`https://www.imdb.com/title/${detail.imdbId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 transition hover:text-white"
                    >
                      <IMDbMark />
                      <span>{detail.imdbRating.toFixed(1)}</span>
                      {detail.imdbVotes ? <span className="text-white/45">({formatNumber(detail.imdbVotes)} votes)</span> : null}
                    </a>
                  </span>
                ) : null}
              </div>
              {genreLabel ? <p className="title-genres type-secondary text-white/60 sm:hidden">{genreLabel}</p> : null}
              {releaseNote ? <p className="type-secondary text-[#ffc285]">{releaseNote}</p> : null}

            </div>

            {/* Title actions sit under the title and metadata on every screen
                (Play first, then bare save/download/source tools). */}
            <div aria-label="Title actions" className="title-actions flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
              {/* design-system.md: Play/Resume is the primary action. Without a
                  resumable source, Play opens source selection below. */}
              {release.state === 'upcoming' ? null : <button
                type="button"
                onClick={canDirectResume ? playResume : playNextUp}
                className="cinema-primary relative inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-white px-5 text-[15px] font-semibold text-black sm:mr-2 sm:w-auto transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                {playLabel}
                {/* Resuming an episode: how far in, on the button (Netflix/Disney+ style). */}
                {!isMovie && nextUp?.started && nextUp.remainingMinutes ? (
                  <span className="title-resume-left font-medium opacity-70">· {nextUp.remainingMinutes}m left</span>
                ) : null}
                {!isMovie && nextUp?.started && nextUp.percent ? (
                  <span className="title-resume-bar pointer-events-none absolute inset-x-3 bottom-1.5 h-[3px] overflow-hidden rounded-full bg-black/15" aria-hidden="true">
                    <span className="block h-full rounded-full bg-black/70" style={{ width: `${nextUp.percent}%` }} />
                  </span>
                ) : null}
              </button>}
              {/* Save toggles appear only when the server library can persist
                  them — never as unexplained disabled controls. */}
              <div className="title-action-tools flex flex-wrap items-start gap-1">
              {libraryAvailable && libraryCanonicalId ? (
                <>
                  <LibraryToggle canonicalId={libraryCanonicalId} field="watch-later" variant="stacked" />
                  <LibraryToggle canonicalId={libraryCanonicalId} field="favourites" variant="stacked" />
                </>
              ) : null}
              {movieWatchId ? (
                <button
                  type="button"
                  onClick={() => void toggleMovieWatched()}
                  aria-pressed={movieWatched}
                  aria-label={movieWatched ? 'Mark unwatched' : 'Mark watched'}
                  title={movieWatched ? 'Watched' : 'Mark watched'}
                  className={STACKED_ACTION_CLASS}
                >
                  {movieWatched
                    ? <CheckCircle2 className="h-5 w-5 fill-white text-black" aria-hidden="true" />
                    : <CheckCircle2 className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />}
                  <span aria-hidden="true">Watched</span>
                </button>
              ) : null}
              {nativeDownloadsSupported() ? (
                <button
                  type="button"
                  onClick={scrollToSources}
                  aria-label="Download"
                  title="Download"
                  className={STACKED_ACTION_CLASS}
                >
                  <Download className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
                  <span aria-hidden="true">Download</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={scrollToSources}
                aria-label="Sources"
                title="Sources"
                className={STACKED_ACTION_CLASS}
              >
                <ListVideo className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
                <span aria-hidden="true">Sources</span>
              </button>
              </div>
            </div>

            {detail.overview ? <TitleOverview text={detail.overview} /> : null}



            {detail.trailerKey ? (
              <div className="flex flex-wrap gap-3">
                <Button asChild className="min-h-12 rounded-lg border border-white/20 bg-transparent px-5 text-white hover:bg-white/[0.06]">
                  <a
                    href={`https://www.youtube.com/watch?v=${detail.trailerKey}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Youtube className="mr-2 h-5 w-5" />
                    Watch trailer
                  </a>
                </Button>
              </div>
            ) : null}

            {detail.directors?.length || detail.writers?.length || detail.networks?.length || (detail.imdbVotes && !detail.imdbRating) ? (
            <dl className="grid gap-x-10 gap-y-5 border-t border-white/[0.08] pt-6 md:grid-cols-2">
              {detail.directors?.length ? (
                <div>
                  <dt className="type-secondary font-medium text-white/60">Directors</dt>
                  <dd className="type-body mt-1.5 text-white/85">{detail.directors.join(', ')}</dd>
                </div>
              ) : null}
              {detail.writers?.length ? (
                <div>
                  <dt className="type-secondary font-medium text-white/60">Writers</dt>
                  <dd className="type-body mt-1.5 text-white/85">{detail.writers.join(', ')}</dd>
                </div>
              ) : null}
              {detail.networks?.length ? (
                <div>
                  <dt className="type-secondary font-medium text-white/60">Networks</dt>
                  <dd className="type-body mt-1.5 text-white/85">{detail.networks.join(', ')}</dd>
                </div>
              ) : null}
              {/* The episode count lives in the Episodes panel header. */}
              {/* With a rating, the vote count already sits beside it. */}
              {detail.imdbVotes && !detail.imdbRating ? (
                <div>
                  <dt className="type-secondary font-medium text-white/60">IMDb votes</dt>
                  <dd className="type-body text-numeric mt-1.5 text-white/85">{formatNumber(detail.imdbVotes)}</dd>
                </div>
              ) : null}
            </dl>
            ) : null}

            {detail.cast?.length ? (
              <div>
                <p className="type-secondary mb-3 font-medium text-white/65">Top cast</p>
                <div className="grid border-t border-white/[0.08] sm:grid-cols-2 lg:grid-cols-3">
                  {detail.cast.slice(0, 12).map((member) => (
                    <div
                      key={`${member.name}-${member.character ?? ''}`}
                      className="type-body border-b border-white/[0.08] py-3 pr-4 text-white sm:odd:mr-4 lg:mr-4"
                    >
                      <div>{member.name}</div>
                      {member.character ? <div className="type-secondary mt-0.5 truncate text-white/60">as {member.character}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {/* Legal credit for the ratings: footer weight, at the end. */}
            {detail.imdbRating ? (
              <p className="title-attribution text-[11px] leading-4 text-white/40">
                Ratings courtesy of{' '}
                <a className="underline decoration-white/20 underline-offset-2 hover:text-white/70" href="https://www.imdb.com" target="_blank" rel="noreferrer">
                  IMDb
                </a>
                . Used with permission.
              </p>
            ) : null}
          </div>

          <div ref={sourcesSectionRef} className={`min-w-0 space-y-4 scroll-mt-[calc(var(--app-safe-top)+5rem)] ${platform.desktop ? 'lg:sticky lg:top-24 lg:self-start' : ''}`}>
            {isMovie && release.state === 'upcoming' ? (
              <section className="rounded-lg border border-white/10 bg-black/40 p-5 backdrop-blur" aria-label="Coming soon">
                <h2 className="type-panel-title text-white">Coming soon</h2>
                <p className="type-secondary mt-2 text-white/70">
                  {detail.title} isn’t out yet. Sources appear once it is{release.digitalRelease ? `: it’s out to stream from ${formatReleaseDate(release.digitalRelease)}` : ''}.
                </p>
                {libraryAvailable && libraryCanonicalId ? (
                  <p className="type-secondary mt-2 text-white/55">Add it to Watch later to find it again.</p>
                ) : null}
              </section>
            ) : isMovie ? (
              <TorrentPanel
                title={detail.title}
                posterUrl={detail.posterUrl}
                year={detail.year}
                imdbId={detail.imdbId}
                originalLanguage={detail.originalLanguage}
                kind={isAnimeMovie ? 'anime' : 'movie'}
                anilistId={isAnimeMovie && !isTmdbBackedAnime ? Number(id) : undefined}
                tmdbId={kind === 'movie' || isTmdbBackedAnime ? Number(id) : undefined}
                titleAliases={detail.altTitles}
                resumeContext={resumeContext}
                resumeSource={resumeSource}
              />
            ) : (
              <EpisodePanel
                openRequest={openRequest}
                onNextUpChange={setNextUp}
                kind={kind === 'anime' || detail.anime ? 'anime' : 'tv'}
                title={detail.title}
                posterUrl={detail.posterUrl}
                titleAliases={detail.altTitles}
                imdbId={detail.imdbId}
                year={detail.year}
                originalLanguage={detail.originalLanguage}
                seasons={seasons.length > 0 ? seasons : DEFAULT_SINGLE_SEASON}
                initialSeason={initialSeason}
                initialEpisodes={initialEpisodes}
                initialArtworkHydrating={episodeArtworkHydrating}
                initialEpisode={Number.isInteger(requestedEpisode) ? requestedEpisode : undefined}
                seasonApiBase={null}
                tmdbId={kind === 'tv' || isTmdbBackedAnime ? Number(id) : undefined}
                anilistId={kind === 'anime' && !isTmdbBackedAnime ? Number(id) : undefined}
                malId={kind === 'anime' ? detail.malId ?? undefined : undefined}
                resumeContext={resumeContext}
                resumeSource={resumeSource}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
