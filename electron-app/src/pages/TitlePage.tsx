import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Circle, Download, ExternalLink, Play, SlidersHorizontal, Youtube } from 'lucide-react';
import { fetchWatched, setWatched, watchedKey } from '../lib/services/watched-service';
import { PageBackButton } from '../components/shared/PageBackButton';
import { Button } from '../components/ui/button';
import EpisodePanel from '../components/EpisodePanelWrapper';
import TorrentPanel from '../components/TorrentPanel';
import { usePlatform } from '../platform/PlatformProvider';
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

// rerender-memo-with-default-value: stable fallback so EpisodePanel's props
// keep their identity while seasons load or a season list is unavailable.
const DEFAULT_SINGLE_SEASON = [{ seasonNumber: 1, name: 'Season 1' }];

function IMDbMark({ className = '' }: { className?: string }) {
  return (
    <span
      aria-label="IMDb"
      className={`inline-flex h-[1.15rem] min-w-[2rem] items-center justify-center rounded-[3px] bg-[#f5c518] px-1 font-sans text-[0.62rem] font-black leading-none tracking-[-0.035em] text-black ${className}`}
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

export default function TitlePage({
  navigate,
  kind,
  id,
  params,
}: {
  navigate: (path: string, params?: Record<string, string>) => void;
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
// Application-wide pull-to-refresh: bumped to refetch the whole detail.
const [refreshKey, setRefreshKey] = useState(0);
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
        absoluteNumber: episode.episode,
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
        setIsAnimeMovie(isTmdbBackedAnime);
        setSeasons([]);
        setInitialEpisodes([]);
        return;
      }

      if (kind === 'tv' || (isTmdbBackedAnime && tmdbAnimeMediaKind === 'tv')) {
        const row = await bffTitleDetail(`tmdb:tv:${id}`);
        publishDetail(detailFromBackendTitle(row));
        setIsAnimeMovie(isTmdbBackedAnime);
        const seasonsData = (row.seasons ?? [])
          .filter((season) => season.number >= 0 && (season.episodeCount ?? 0) > 0)
          .map((season) => ({
            seasonNumber: season.number,
            name: season.name || `Season ${season.number}`,
            episodeCount: season.episodeCount,
            airDate: season.airDate,
            posterUrl: season.poster,
          }));
        setSeasons(seasonsData);
        const firstSeason = Number.isInteger(requestedSeason) && seasonsData.some((s: any) => s.seasonNumber === requestedSeason)
          ? requestedSeason
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
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="measure-compact type-body text-white/75">{loadError || 'Couldn’t load this title.'}</p>
        <PageBackButton />
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

  const heroBackground = detail.backdropUrl || detail.posterUrl || null;
  const isMovie = kind === 'movie' || isAnimeMovie;

  // WF03 compact toolbar (M2.3): bare Back / save / source tools. Save
  // actions are DISABLED and truthful — library persistence lands with M3,
  // so nothing here implies a saved change. Play appears only when a
  // previously-used source can actually be resumed; otherwise the primary
  // path is choosing a source in the panel below.
  const canDirectResume = Boolean(resumeSource?.sourceUri && resumeSource.sourceUri.startsWith('magnet:'));
  const scrollToSources = () => {
    sourcesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const playResume = () => {
    if (!canDirectResume || !resumeSource) return;
    const params: Record<string, string> = {
      magnet: resumeSource.sourceUri,
      title: detail.title,
      cat: isAnimeMovie ? 'anime' : kind === 'movie' ? 'movie' : 'tv',
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
    <div className="relative isolate min-h-screen px-5 pb-14 pt-6 md:px-8 lg:px-12">
      {pullIndicator}
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[#0a0a0a]">
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
      <div className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-r from-[#0a0a0a] via-[#0a0a0a]/85 to-[#0a0a0a]/20" />
      <div className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-t from-[#0a0a0a] via-transparent to-black/15" />

      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-white">
          <div className={platform.desktop ? 'hidden lg:block' : 'hidden'}><PageBackButton /></div>
          <div className="type-caption text-numeric flex flex-wrap items-center gap-2 font-medium text-white/70">
            <span className="rounded-full border border-white/15 bg-black/20 px-3 py-1.5 backdrop-blur">
              {kind === 'tv' ? 'Series' : kind === 'anime' ? (isAnimeMovie ? 'Anime Movie' : 'Anime Series') : 'Movie'}
            </span>
            {languageName ? (
              <span className="rounded-full border border-white/15 bg-black/20 px-3 py-1.5 backdrop-blur">{languageName}</span>
            ) : null}
            {detail.imdbId ? (
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
              <h1 className="type-feature-title !text-[1.75rem] !leading-[2.125rem] text-white md:!text-[4.5rem] md:!leading-[1.02]">{detail.title}</h1>
              {detail.tagline ? <p className="measure-compact type-body text-white/70">{detail.tagline}</p> : null}
              <div className="type-secondary text-numeric flex flex-wrap items-center gap-2 text-white/70">
                {metaBadges.map((item, index) => (
                  <span key={item} className="inline-flex items-center gap-2">
                    {index > 0 ? <span className="text-white/25">·</span> : null}
                    {item}
                  </span>
                ))}
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
                    </a>
                  </span>
                ) : null}
              </div>
              {detail.imdbRating ? (
                <p className="type-caption text-white/45">
                  Information courtesy of{' '}
                  <a className="underline decoration-white/25 underline-offset-2 hover:text-white/70" href="https://www.imdb.com" target="_blank" rel="noreferrer">
                    IMDb
                  </a>
                  . Used with permission.
                </p>
              ) : null}
            </div>

            {/* Compact title actions sit under the title and metadata (Play
                first, then bare save/download/source tools); desktop keeps its
                two-column layout. */}
            <div aria-label="Title actions" className={`flex flex-wrap items-center gap-1 ${platform.desktop ? 'lg:hidden' : ''}`}>
              {/* design-system.md: Play/Resume is the primary action. Without a
                  resumable source, Play opens source selection below. */}
              <button
                type="button"
                onClick={canDirectResume ? playResume : scrollToSources}
                className="mr-1 inline-flex min-h-12 items-center gap-2 rounded-lg bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                {canDirectResume ? 'Resume' : 'Play'}
              </button>
              {/* Save toggles appear only when the server library can persist
                  them — never as unexplained disabled controls. */}
              {libraryAvailable && libraryCanonicalId ? (
                <>
                  <LibraryToggle canonicalId={libraryCanonicalId} field="watch-later" />
                  <LibraryToggle canonicalId={libraryCanonicalId} field="favourites" />
                </>
              ) : null}
              {movieWatchId ? (
                <button
                  type="button"
                  onClick={() => void toggleMovieWatched()}
                  aria-pressed={movieWatched}
                  aria-label={movieWatched ? 'Mark unwatched' : 'Mark watched'}
                  title={movieWatched ? 'Watched' : 'Mark watched'}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-lg transition hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  {movieWatched
                    ? <CheckCircle2 className="h-6 w-6 fill-white text-black" aria-hidden="true" />
                    : <Circle className="h-6 w-6 text-white/70" aria-hidden="true" />}
                </button>
              ) : null}
              {nativeDownloadsSupported() ? (
                <button
                  type="button"
                  onClick={scrollToSources}
                  aria-label="Download"
                  title="Download"
                  className="inline-flex h-12 w-12 items-center justify-center rounded-lg text-white/80 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  <Download className="h-5 w-5" aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={scrollToSources}
                aria-label="Sources"
                title="Sources"
                className="inline-flex h-12 w-12 items-center justify-center rounded-lg text-white/80 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <SlidersHorizontal className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {detail.overview ? (
              <p className="measure-prose type-body text-white/75">{detail.overview}</p>
            ) : null}

            <div className="flex flex-wrap gap-2 text-sm text-white/65">
              {detail.genres?.map((genre) => (
                <span key={genre} className="rounded-full border border-white/12 bg-black/15 px-3 py-1.5 backdrop-blur">
                  {genre}
                </span>
              ))}
            </div>

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
              {detail.totalEpisodes ? (
                <div>
                  <dt className="type-secondary font-medium text-white/60">Episodes</dt>
                  <dd className="type-body text-numeric mt-1.5 text-white/85">{detail.totalEpisodes}</dd>
                </div>
              ) : null}
              {detail.imdbVotes ? (
                <div>
                  <dt className="type-secondary font-medium text-white/60">IMDb votes</dt>
                  <dd className="type-body text-numeric mt-1.5 text-white/85">{formatNumber(detail.imdbVotes)}</dd>
                </div>
              ) : null}
            </dl>

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
          </div>

          <div ref={sourcesSectionRef} className={`min-w-0 space-y-4 scroll-mt-[calc(var(--app-safe-top)+5rem)] ${platform.desktop ? 'lg:sticky lg:top-24 lg:self-start' : ''}`}>
            {isMovie ? (
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
                kind={kind === 'anime' ? 'anime' : 'tv'}
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
