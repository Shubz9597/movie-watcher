import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, ExternalLink, Heart, Play, SlidersHorizontal, Youtube } from 'lucide-react';
import { Button } from '../components/ui/button';
import EpisodePanel from '../components/EpisodePanelWrapper';
import TorrentPanel from '../components/TorrentPanel';
import { findAnimeIMDbId, getMovie as getTmdbMovie, getTv as getTmdbTv } from '../lib/services/tmdb-service';
import { getTvSeason, getAnimeEpisodeMetadata } from '../lib/services/catalog-gateway';
import { bffEpisodes, bffTitleDetail } from '../lib/services/catalog-bff';
import { getCatalogSource } from '../lib/catalog-source';
import { getAnime as getAniListAnime } from '../lib/services/anilist-service';
import { getAnime as getJikanAnime } from '../lib/services/jikan-service';
import { getIMDbRating } from '../lib/services/imdb-service';
import {
  detailFromTmdbMovie,
  detailFromTmdbTv,
  detailFromAniList,
  detailFromJikan,
  detailFromBackendTitle,
  type Detail,
} from '../lib/adapters/media';
import { getSavedResumeSource } from '../lib/services/continue-service';
import type { ResumeSourceContext, SavedResumeSource } from '../lib/types';

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
  const [detail, setDetail] = useState<Detail | null>(null);
  const [seasons, setSeasons] = useState<any[]>([]);
  const [initialSeason, setInitialSeason] = useState(1);
  const [initialEpisodes, setInitialEpisodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAnimeMovie, setIsAnimeMovie] = useState(false);
  const [episodeArtworkHydrating, setEpisodeArtworkHydrating] = useState(false);
  const [readyHeroUrl, setReadyHeroUrl] = useState('');
  const requestedSeason = Number(params?.season ?? params?.resumeSeason);
  const requestedEpisode = Number(params?.episode ?? params?.resumeEpisode);
  const resumeSeason = Number(params?.resumeSeason);
  const resumeEpisode = Number(params?.resumeEpisode);
  const isTmdbBackedAnime = kind === 'anime' && params?.provider === 'tmdb';
  const tmdbAnimeMediaKind = params?.mediaKind === 'movie' ? 'movie' : 'tv';
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

    const enrichAnimeIMDb = (next: Detail, isMovieFormat: boolean) => {
      if (next.imdbId) return;
      void findAnimeIMDbId({
        title: next.title,
        aliases: next.altTitles,
        year: next.year,
        isMovie: isMovieFormat,
      }).then((imdbId) => {
        if (cancelled || !imdbId) return;
        setDetail((current) => current && !current.imdbId ? { ...current, imdbId } : current);
        enrichIMDb(imdbId);
      }).catch((error: unknown) => {
        if (!cancelled) console.warn('[TitlePage] Anime IMDb mapping is unavailable:', error);
      });
    };

    const enrichAnimeEpisodeArtwork = (anilistId: number) => {
      setEpisodeArtworkHydrating(true);
      void getAnimeEpisodeMetadata(anilistId)
        .then((metadata) => {
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

    // BFF-mode helpers (T042.3): map contract responses onto the episode
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

    const loadBffTmdbEpisodes = async (tmdbId: number, season: number): Promise<BffEpisodeRow[]> => {
      const seasonData = await getTvSeason(tmdbId, season);
      return Array.isArray(seasonData.episodes)
        ? seasonData.episodes.map((ep: any) => ({
            id: ep.id,
            episodeNumber: ep.episode_number,
            seasonNumber: ep.season_number,
            name: ep.name,
            overview: ep.overview,
            airDate: ep.air_date,
            stillUrl: stillUrlFrom(ep.still_path),
            runtime: ep.runtime,
          }))
        : [];
    };

    const loadBffTitle = async () => {
      if (kind === 'movie' || (isTmdbBackedAnime && tmdbAnimeMediaKind === 'movie')) {
        const row = await bffTitleDetail(`tmdb:${id}`);
        publishDetail(detailFromBackendTitle(row));
        setIsAnimeMovie(isTmdbBackedAnime);
        setSeasons([]);
        setInitialEpisodes([]);
        return;
      }

      if (kind === 'tv' || (isTmdbBackedAnime && tmdbAnimeMediaKind === 'tv')) {
        const row = await bffTitleDetail(`tmdb:${id}`);
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
        setInitialEpisodes(await loadBffTmdbEpisodes(Number(id), firstSeason));
        return;
      }

      // Anime (AniList-id route): the server detail already merges
      // AniList/Jikan/Cinemeta enrichment, so no client-side Jikan fallback.
      const catalogId = `anilist:${id}`;
      const row = await bffTitleDetail(catalogId);
      publishDetail(detailFromBackendTitle(row));
      const seasonNumber = Number.isInteger(requestedSeason) && requestedSeason > 0 ? requestedSeason : 1;
      let episodes: BffEpisodeRow[] = await bffEpisodeRows(catalogId, seasonNumber);
      if (episodes.length === 0) {
        const knownCount = row.seasons?.[0]?.episodeCount ?? 0;
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
    };

    async function load() {
      try {
        setLoading(true);
        setLoadError(null);
        setDetail(null);
        setEpisodeArtworkHydrating(false);
        console.log('[TitlePage] Loading', kind, id);

        // BFF mode (T042.3): detail/seasons/episodes resolve through the
        // /v2/catalog/* contract; renderer provider services are not called.
        if (await getCatalogSource() === 'bff') {
          await loadBffTitle();
          return;
        }

        if (kind === 'movie') {
          const raw = await getTmdbMovie(Number(id));
          const d = detailFromTmdbMovie(raw);
          publishDetail(d);
          setIsAnimeMovie(false);
        } else if (kind === 'tv') {
          const raw = await getTmdbTv(Number(id));
          const d = detailFromTmdbTv(raw);
          publishDetail(d);

          // Load seasons
          const seasonsData = Array.isArray(raw.seasons)
            ? raw.seasons
                .filter((s: any) => s.season_number >= 0 && (s.episode_count ?? 0) > 0)
                .sort((a: any, b: any) => a.season_number - b.season_number)
                .map((s: any) => ({
                  seasonNumber: s.season_number,
                  name: s.name || `Season ${s.season_number}`,
                  episodeCount: s.episode_count ?? undefined,
                  airDate: s.air_date,
                  posterUrl: s.poster_path ? `https://image.tmdb.org/t/p/w342${s.poster_path}` : undefined,
                }))
            : [];
          setSeasons(seasonsData);
          const firstSeason = Number.isInteger(requestedSeason) && seasonsData.some((s: any) => s.seasonNumber === requestedSeason)
            ? requestedSeason
            : seasonsData[0]?.seasonNumber ?? 1;
          setInitialSeason(firstSeason);

          // Load first season episodes
          const seasonData = await getTvSeason(Number(id), firstSeason);
          const episodes = Array.isArray(seasonData.episodes)
            ? seasonData.episodes.map((ep: any) => ({
                id: ep.id,
                episodeNumber: ep.episode_number,
                seasonNumber: ep.season_number,
                name: ep.name,
                overview: ep.overview,
                airDate: ep.air_date,
                stillUrl: ep.still_path ? `https://image.tmdb.org/t/p/w780${ep.still_path}` : undefined,
                runtime: ep.runtime,
              }))
            : [];
          setInitialEpisodes(episodes);
        } else if (isTmdbBackedAnime) {
          if (tmdbAnimeMediaKind === 'movie') {
            const raw = await getTmdbMovie(Number(id));
            publishDetail(detailFromTmdbMovie(raw));
            setIsAnimeMovie(true);
            setSeasons([]);
            setInitialEpisodes([]);
          } else {
            const raw = await getTmdbTv(Number(id));
            publishDetail(detailFromTmdbTv(raw));
            setIsAnimeMovie(false);

            const seasonsData = Array.isArray(raw.seasons)
              ? raw.seasons
                  .filter((season: any) => season.season_number >= 0 && (season.episode_count ?? 0) > 0)
                  .sort((left: any, right: any) => left.season_number - right.season_number)
                  .map((season: any) => ({
                    seasonNumber: season.season_number,
                    name: season.name || `Season ${season.season_number}`,
                    episodeCount: season.episode_count ?? undefined,
                    airDate: season.air_date,
                    posterUrl: season.poster_path ? `https://image.tmdb.org/t/p/w342${season.poster_path}` : undefined,
                  }))
              : [];
            setSeasons(seasonsData);
            const firstSeason = Number.isInteger(requestedSeason) && seasonsData.some((season: any) => season.seasonNumber === requestedSeason)
              ? requestedSeason
              : seasonsData[0]?.seasonNumber ?? 1;
            setInitialSeason(firstSeason);
            const seasonData = await getTvSeason(Number(id), firstSeason);
            setInitialEpisodes(Array.isArray(seasonData.episodes)
              ? seasonData.episodes.map((episode: any) => ({
                  id: episode.id,
                  episodeNumber: episode.episode_number,
                  seasonNumber: episode.season_number,
                  name: episode.name,
                  overview: episode.overview,
                  airDate: episode.air_date,
                  stillUrl: episode.still_path ? `https://image.tmdb.org/t/p/w780${episode.still_path}` : undefined,
                  runtime: episode.runtime,
                }))
              : []);
          }
        } else {
          // Anime
          const routeMalId = Number(params?.malId);
          const validRouteMalId = Number.isInteger(routeMalId) && routeMalId > 0 ? routeMalId : undefined;
          const configureEpisodes = (
            isMovieFormat: boolean,
            episodeCount?: number | null,
            nextAiringEpisode?: { episode?: number | null; airingAt?: number | null } | null,
            scheduleNodes: Array<{ episode?: number | null; airingAt?: number | null }> = [],
            status?: string | null,
          ) => {
            setIsAnimeMovie(isMovieFormat);
            if (isMovieFormat) {
              setSeasons([]);
              setInitialEpisodes([]);
              return;
            }

            const resumeAnimeSeason = Number.isInteger(requestedSeason) && requestedSeason > 0 ? requestedSeason : 1;
            const schedule = new Map<number, number>();
            for (const item of scheduleNodes) {
              if (Number.isInteger(item.episode) && Number(item.episode) > 0 && Number(item.airingAt) > 0) {
                schedule.set(Number(item.episode), Number(item.airingAt));
              }
            }
            const nextAiringEpisodeNumber = Number(nextAiringEpisode?.episode);
            const nextAiringAt = Number(nextAiringEpisode?.airingAt);
            const hasNextAiringEpisode = Number.isInteger(nextAiringEpisodeNumber) && nextAiringEpisodeNumber > 0;
            if (hasNextAiringEpisode && nextAiringAt > 0 && !schedule.has(nextAiringEpisodeNumber)) {
              schedule.set(nextAiringEpisodeNumber, nextAiringAt);
            }
            const airedEpisodeCount = hasNextAiringEpisode
              ? Math.max(0, nextAiringEpisodeNumber - 1)
              : 0;
            const scheduledEpisodeCount = Math.max(0, ...schedule.keys());
            const knownEpisodeCount = Math.min(1000, Math.max(
              Number(episodeCount) || 0,
              airedEpisodeCount,
              scheduledEpisodeCount,
              Number.isInteger(requestedEpisode) && requestedEpisode > 0 ? requestedEpisode : 0,
            ));
            const normalizedStatus = String(status || '').trim().toLocaleLowerCase();
            const catalogueFinished = normalizedStatus.includes('finished');
            const catalogueContinuationUnknown = normalizedStatus !== '' && !catalogueFinished;
            const animeEpisodes = Array.from({ length: knownEpisodeCount }, (_, index) => {
              const episodeNumber = index + 1;
              const airingAt = schedule.get(episodeNumber);
              const continuationAvailable = hasNextAiringEpisode
                ? episodeNumber < nextAiringEpisodeNumber
                : catalogueFinished
                  ? true
                  : catalogueContinuationUnknown
                    ? false
                    : undefined;
              return {
                id: episodeNumber,
                episodeNumber,
                absoluteNumber: episodeNumber,
                seasonNumber: resumeAnimeSeason,
                name: `Episode ${episodeNumber}`,
                airDate: airingAt ? new Date(airingAt * 1000).toISOString() : undefined,
                continuationAvailable,
              };
            });

            if (Number.isInteger(requestedEpisode) && requestedEpisode > 0 &&
                !animeEpisodes.some((episode) => episode.episodeNumber === requestedEpisode)) {
              animeEpisodes.push({
                id: requestedEpisode,
                episodeNumber: requestedEpisode,
                absoluteNumber: requestedEpisode,
                seasonNumber: resumeAnimeSeason,
                name: `Episode ${requestedEpisode}`,
                airDate: undefined,
                continuationAvailable: false,
              });
              animeEpisodes.sort((left, right) => left.episodeNumber - right.episodeNumber);
            }

            setSeasons([{ seasonNumber: resumeAnimeSeason, name: `Season ${resumeAnimeSeason}` }]);
            setInitialSeason(resumeAnimeSeason);
            setInitialEpisodes(animeEpisodes);
          };

          let raw;
          try {
            raw = await getAniListAnime(Number(id));
          } catch (aniListError) {
            if (!validRouteMalId) throw aniListError;
            console.warn('[TitlePage] AniList detail failed; using Jikan fallback.', aniListError);
            const jikanRaw = await getJikanAnime(validRouteMalId);
            const jikanDetail = detailFromJikan(jikanRaw);
            publishDetail({ ...jikanDetail, id: Number(id), malId: validRouteMalId });
            enrichAnimeIMDb(jikanDetail, jikanRaw?.type === 'Movie');
            configureEpisodes(jikanRaw?.type === 'Movie', jikanRaw?.episodes, undefined, [], jikanRaw?.status);
            if (jikanRaw?.type !== 'Movie') enrichAnimeEpisodeArtwork(Number(id));
            return;
          }

          const aniListDetail = detailFromAniList(raw);
          publishDetail(aniListDetail);
          enrichAnimeIMDb(aniListDetail, raw.format === 'MOVIE');
          configureEpisodes(
            raw.format === 'MOVIE',
            raw.episodes,
            raw.nextAiringEpisode,
            raw.airingSchedule?.nodes || [],
            raw.status,
          );
          if (raw.format !== 'MOVIE') enrichAnimeEpisodeArtwork(raw.id);

          // Render the AniList shell immediately. Jikan is a single cached
          // enrichment request and must never make the page unavailable.
          setLoading(false);
          const malId = validRouteMalId || raw.idMal || undefined;
          if (malId) {
            try {
              const jikanDetail = detailFromJikan(await getJikanAnime(malId));
              setDetail((current) => current ? {
                ...current,
                title: jikanDetail.title || current.title,
                year: jikanDetail.year ?? current.year,
                overview: jikanDetail.overview || current.overview,
                genres: Array.from(new Set([...(current.genres || []), ...(jikanDetail.genres || [])])),
                runtime: jikanDetail.runtime ?? current.runtime,
                trailerKey: jikanDetail.trailerKey || current.trailerKey,
                imdbId: jikanDetail.imdbId || current.imdbId,
                tmdbRatingPct: jikanDetail.tmdbRatingPct ?? current.tmdbRatingPct,
                rating: jikanDetail.rating ?? current.rating,
                altTitles: Array.from(new Set([...(current.altTitles || []), ...(jikanDetail.altTitles || [])])),
                status: jikanDetail.status || current.status,
                networks: jikanDetail.networks?.length ? jikanDetail.networks : current.networks,
                totalEpisodes: jikanDetail.totalEpisodes ?? current.totalEpisodes,
                malId,
              } : current);
              enrichIMDb(jikanDetail.imdbId);
            } catch (jikanError) {
              console.warn('[TitlePage] Jikan enrichment failed; keeping AniList detail.', jikanError);
            }
          }
        }
      } catch (err) {
        console.error('[TitlePage] Failed to load title:', err);
        setLoadError(err instanceof Error ? err.message : 'The title details could not be loaded.');
      } finally {
        setLoading(false);
      }
    }
    if (!id) {
      setDetail(null);
      setLoadError('This title link is incomplete. Return to the catalog and choose the title again.');
      setLoading(false);
      return;
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [kind, id, params?.malId, requestedSeason, requestedEpisode, isTmdbBackedAnime, tmdbAnimeMediaKind]);

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
        <p className="type-body text-white/70">Could not load this title.</p>
        {loadError ? <p className="measure-compact type-body text-white/65">{loadError}</p> : null}
        <button type="button" onClick={() => navigate('home')} className="text-sm text-[#ff9a4a] hover:text-white">
          Back to browse
        </button>
      </div>
    );
  }

  const languageFormatter =
    typeof Intl !== 'undefined' && 'DisplayNames' in Intl
      ? new Intl.DisplayNames(['en'], { type: 'language' })
      : null;
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
  const saveUnavailableCopy = 'Library saving arrives with library sync (M3) — nothing is saved yet.';

  return (
    <div className="relative isolate min-h-screen px-5 pb-14 pt-6 md:px-8 lg:px-12">
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
        {/* Compact action toolbar (lg:hidden): desktop keeps the familiar
            two-column layout unchanged (WF09). */}
        <div className="flex items-center justify-between gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => navigate('home')}
            aria-label="Back"
            className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-black/30 text-white/80 backdrop-blur transition hover:border-white/30 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="flex items-center gap-1">
            {canDirectResume ? (
              <button
                type="button"
                onClick={playResume}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                <Play className="h-4 w-4 fill-current" aria-hidden="true" />
                Resume
              </button>
            ) : null}
            <button
              type="button"
              disabled
              aria-label="Save to Watch Later (unavailable: library sync not implemented)"
              title={saveUnavailableCopy}
              className="inline-flex h-12 w-12 items-center justify-center rounded-full text-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <Bookmark className="h-5 w-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled
              aria-label="Mark as Favourite (unavailable: library sync not implemented)"
              title={saveUnavailableCopy}
              className="inline-flex h-12 w-12 items-center justify-center rounded-full text-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <Heart className="h-5 w-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={scrollToSources}
              aria-label="Find sources"
              className="inline-flex h-12 w-12 items-center justify-center rounded-full text-white/80 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <SlidersHorizontal className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-white">
          <button
            onClick={() => navigate('home')}
            className="hidden lg:inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-4 py-2 text-white/75 backdrop-blur transition hover:border-white/30 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to browse
          </button>
          <div className="type-caption text-numeric flex flex-wrap items-center gap-2 font-medium text-white/70">
            <span className="rounded-full border border-white/15 bg-black/20 px-3 py-1.5 backdrop-blur">
              {kind === 'tv' ? 'Series' : kind === 'anime' ? (isAnimeMovie ? 'Anime Movie' : 'Anime Series') : 'Movie'}
            </span>
            {detail.year ? (
              <span className="rounded-full border border-white/15 bg-black/20 px-3 py-1.5 backdrop-blur">{detail.year}</span>
            ) : null}
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

        <div className="mt-8 grid gap-12 lg:grid-cols-[minmax(0,1fr)_440px] xl:gap-16">
          <div className="relative max-w-4xl space-y-7">

            <div className="space-y-3">
              <p className="type-secondary font-medium text-white/65">{kind === 'tv' ? 'Series' : kind === 'anime' ? 'Anime' : 'Film'}</p>
              <h1 className="type-feature-title text-white">{detail.title}</h1>
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
                <Button asChild className="rounded-full bg-white px-5 text-black hover:bg-white/85">
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

          <div ref={sourcesSectionRef} className="space-y-4 scroll-mt-20 lg:sticky lg:top-24 lg:self-start">
            {isMovie ? (
              <TorrentPanel
                title={detail.title}
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
                titleAliases={detail.altTitles}
                imdbId={detail.imdbId}
                year={detail.year}
                originalLanguage={detail.originalLanguage}
                seasons={seasons.length > 0 ? seasons : [{ seasonNumber: 1, name: 'Season 1' }]}
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



