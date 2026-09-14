import { useCallback, useEffect, useRef, useState } from 'react';
import { getCatalogSource } from '../lib/catalog-source';
import { bffTitleDetail } from '../lib/services/catalog-bff';
import { getDeviceId } from '../lib/device-id';
import { usePlatform } from '../platform/PlatformProvider';
import { ChevronLeft } from 'lucide-react';
import { resolveTorrentFile } from '../lib/services/resolve-service';
import NativePlayerControls from '../mobile/NativePlayerControls';

// Legacy provider metadata loads lazily: bff mode never imports them (T042.4).
async function legacyMetadataProviders() {
  const [tmdb, anilist] = await Promise.all([import('../lib/services/tmdb-service'), import('../lib/services/anilist-service')]);
  return { getTmdbMovie: tmdb.getMovie, getTmdbTv: tmdb.getTv, getAnime: anilist.getAnime };
}

type Props = {
  navigate: (path: string, params?: Record<string, string>) => void;
  params: Record<string, string>;
};

export default function PlayerPage({ navigate, params }: Props) {
  const {
    magnet,
    title: paramTitle,
    cat = 'movie',
    tmdbId,
    imdbId: paramImdbId,
    anilistId,
    malId,
    fileIndex,
    resolveEpisodeFile,
    seriesId,
    season = '0',
    episode = '0',
    absoluteEpisode,
    sourceName,
    nextSeason,
    nextEpisode,
    nextEpisodeRoute,
  } = params;
  const platform = usePlatform();

  const didStartPlaybackRef = useRef(false);
  const returningRef = useRef(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // M1.4.7: resolved display metadata drives the native player's loading
  // screen and control surface (poster, title, year, ids).
  const [playbackMeta, setPlaybackMeta] = useState<{
    title: string; year?: number; posterUrl: string | null; logoUrl: string | null; imdbId?: string; malId?: number; fileIndex?: number;
  }>({ title: paramTitle || 'Playing', posterUrl: null, logoUrl: null, fileIndex: fileIndex != null ? Number(fileIndex) : undefined });

  const returnToSource = useCallback((event?: { reason?: 'stopped' | 'ended' | 'error'; message?: string }) => {
    if (returningRef.current) return;
    // MPV has already been torn down when this is called from mpv:stopped, so
    // prevent the route-unmount cleanup from issuing a second stop request.
    didStartPlaybackRef.current = false;
    // M1.4.3: native players may report unrecoverable errors; surface the
    // actionable message on the transition state instead of a silent return.
    if (event?.reason === 'error') {
      setPlaybackError(event.message || 'Playback was interrupted by an error. Choose another source and retry.');
      return;
    }
    returningRef.current = true;

    if (event?.reason === 'ended' && nextEpisodeRoute?.startsWith('#title?')) {
      window.location.replace(nextEpisodeRoute);
      return;
    }

    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate('home');
    }
  }, [navigate, nextEpisodeRoute]);

  useEffect(() => {
    const unsubscribe = platform.player?.onStopped((event) => {
      returnToSource(event);
    });
    return () => {
      unsubscribe?.();
    };
  }, [returnToSource]);

  // Landscape from the FIRST frame of playback entry (device pass): the
  // native orientation lock fires BEFORE metadata/torrent preparation, so the
  // logo loader is already landscape and the user never rotates manually.
  // Restore on unmount (close/back) and on startup failure; re-lock on retry.
  // OS-denied requests resolve harmlessly — playback continues unrotated.
  const nativeSurface = !platform.desktop && !!platform.player && 'subscribeTime' in platform.player;
  useEffect(() => {
    if (!nativeSurface) return;
    const setLandscape = (landscape: boolean) => {
      (platform.player as unknown as { setPlaybackOrientation?: (landscape: boolean) => void }).setPlaybackOrientation?.(landscape);
    };
    setLandscape(!playbackError);
    return () => setLandscape(false);
  }, [nativeSurface, platform.player, playbackError, retryToken]);

  useEffect(() => {
    if (!magnet) {
      console.error('[PlayerPage] No magnet provided');
      setPlaybackError('The selected source does not include a playable torrent. Return to the title and choose another source.');
      return;
    }

    let cancelled = false;
    didStartPlaybackRef.current = false;
    // M1.4 repair: a retry (Try again button) re-runs this effect — the
    // terminal guard from the FAILED attempt must reset, or a later successful
    // playback could never report ended/stopped normally.
    returningRef.current = false;

    async function startPlayback() {
      setPlaybackError(null);
      try {
        let playbackTitle = paramTitle || 'Playing';
        let playbackYear: number | undefined;
        let playbackPosterUrl: string | null = null;
        let playbackLogoUrl: string | null = null;
        let playbackImdbId = paramImdbId || undefined;
        let playbackMalId = malId ? Number(malId) : undefined;

        // Resolve display metadata before starting playback. Keeping this
        // work in the playback effect prevents metadata state updates from
        // stopping and restarting an active playback session. M1.4.7: mobile
        // resolves metadata too — the native player's buffering screen needs
        // the poster + display title. BFF mode resolves through the catalog
        // contract (T042.4).
        if (tmdbId && cat !== 'anime') {
          try {
            if (await getCatalogSource() === 'bff') {
              // M3.1.1: request detail by the media-qualified canonical id
              // derived from the route's explicit `cat` namespace.
              const row = await bffTitleDetail(`tmdb:${cat === 'movie' ? 'movie' : 'tv'}:${tmdbId}`);
              playbackPosterUrl = row.artwork?.poster ?? null;
              playbackLogoUrl = row.artwork?.logo ?? null;
              playbackImdbId = row.imdbId || playbackImdbId;
              playbackYear = row.year;
              playbackTitle = row.title || playbackTitle;
            } else {
              const { getTmdbMovie, getTmdbTv } = await legacyMetadataProviders();
              const data = cat === 'movie'
                ? await getTmdbMovie(Number(tmdbId))
                : await getTmdbTv(Number(tmdbId));
              playbackPosterUrl = data.poster_path || null;
              playbackImdbId = data.imdb_id || data.external_ids?.imdb_id || playbackImdbId;
              const date = data.release_date || data.first_air_date;
              playbackYear = date ? Number(date.slice(0, 4)) : undefined;
              playbackTitle = data.title || data.name || playbackTitle;
            }
          } catch (err) {
            console.error('[PlayerPage] Failed to fetch TMDB metadata:', err);
          }
        } else if (anilistId && cat === 'anime') {
          try {
            if (await getCatalogSource() === 'bff') {
              const row = await bffTitleDetail(`anilist:${anilistId}`);
              playbackPosterUrl = row.artwork?.poster ?? null;
              playbackYear = row.year;
              playbackTitle = row.title || playbackTitle;
              playbackMalId = row.providerIds?.jikan ? Number(row.providerIds.jikan) : playbackMalId;
            } else {
              const { getAnime } = await legacyMetadataProviders();
              const data = await getAnime(Number(anilistId));
              playbackPosterUrl = data.coverImage?.extraLarge || data.coverImage?.large || null;
              playbackYear = data.startDate?.year || undefined;
              playbackTitle = data.title?.english || data.title?.userPreferred || data.title?.romaji || playbackTitle;
              playbackMalId = data.idMal || playbackMalId;
            }
          } catch (err) {
            console.error('[PlayerPage] Failed to fetch anime metadata:', err);
          }
        }
        if (cancelled) return;

        platform.desktop?.debugLog?.('[PlayerPage] startPlayback', {
          hasElectronAPI: Boolean(platform.desktop),
          hasMagnet: Boolean(magnet),
          cat,
          fileIndex,
        });

        platform.desktop?.debugLog?.('[PlayerPage] calling playInMpv', {
          title: playbackTitle,
          cat,
          fileIndex,
        });
        if (!platform.player) {
          throw new Error('Playback is unavailable on this device. Reconnect to the TorWatch server and try again.');
        }
        let resolvedFileIndex = fileIndex != null ? Number(fileIndex) : undefined;
        if (resolveEpisodeFile === '1' && resolvedFileIndex == null) {
          const resolved = await resolveTorrentFile({
            magnetUri: magnet, cat, season: Number(season), episode: Number(episode),
            absolute: absoluteEpisode ? Number(absoluteEpisode) : Number(episode),
          });
          resolvedFileIndex = resolved.fileIndex;
          if (cancelled) return;
        }
        setPlaybackMeta({
          title: playbackTitle,
          year: playbackYear,
          posterUrl: playbackPosterUrl,
          logoUrl: playbackLogoUrl,
          imdbId: playbackImdbId,
          malId: playbackMalId,
          fileIndex: resolvedFileIndex,
        });
        await platform.player.start({
          url: magnet,
          magnet,
          title: playbackTitle,
          cat,
          fileIndex: resolvedFileIndex,
          tmdbId: tmdbId ? Number(tmdbId) : undefined,
          imdbId: playbackImdbId,
          anilistId: anilistId ? Number(anilistId) : undefined,
          malId: playbackMalId,
          year: playbackYear,
          posterUrl: playbackPosterUrl,
          logoUrl: playbackLogoUrl,
          subjectId: seriesId ? getDeviceId() : undefined,
          seriesId: seriesId || undefined,
          season: Number(season),
          episode: Number(episode),
          absoluteEpisode: absoluteEpisode ? Number(absoluteEpisode) : undefined,
          sourceName: sourceName || undefined,
          nextSeason: nextSeason != null ? Number(nextSeason) : undefined,
          nextEpisode: nextEpisode != null ? Number(nextEpisode) : undefined,
        });
        if (cancelled) return;

        didStartPlaybackRef.current = true;
      } catch (err) {
        console.error('[PlayerPage] Playback initialization failed:', err);
        if (!cancelled) setPlaybackError(err instanceof Error ? err.message : 'Playback could not be started.');
      }
    }

    startPlayback();

    return () => {
      cancelled = true;
      // In dev (React strict mode / HMR), effects can mount/unmount rapidly.
      // Only stop MPV if this page actually started playback.
      if (!didStartPlaybackRef.current && platform.desktop) return;
      platform.player?.stop().catch((err) => {
        console.error('[PlayerPage] Error stopping MPV on unmount:', err);
      });
    };
  }, [magnet, paramTitle, cat, tmdbId, paramImdbId, anilistId, malId, fileIndex, resolveEpisodeFile, seriesId, season, episode, absoluteEpisode, sourceName, nextSeason, nextEpisode, nextEpisodeRoute, returnToSource, retryToken]);

  // M1.4.7: on native mobile the VLC surface sits BEHIND the WebView; this
  // page must stay transparent so the video shows through (LoadingScreen is
  // rendered by the controls until frames flow). Errors keep an opaque
  // backdrop for readability. (nativeSurface itself is computed above with
  // the orientation lock.)
  const opaque = !!playbackError || !nativeSurface;

  useEffect(() => {
    if (!nativeSurface) return;
    document.documentElement.classList.add('native-playback');
    return () => document.documentElement.classList.remove('native-playback');
  }, [nativeSurface]);

  const closePlayer = () => {
    // onStopped navigates after native teardown. Also cancel a pending start.
    if (nativeSurface) {
      void platform.player?.stop().finally(() => returnToSource());
    } else {
      returnToSource();
    }
  };

  return (
    <div className={`player-transition fixed inset-x-0 bottom-0 ${opaque ? 'bg-black' : 'bg-transparent'} ${platform.desktop ? 'top-10 z-40' : 'top-0 z-[60]'}`}>
      {!nativeSurface ? (
        <div>
          {!platform.desktop ? (
            <button type="button" aria-label="Close player" onClick={() => returnToSource()} className="absolute left-5 top-[calc(var(--app-safe-top)+0.5rem)] z-10 inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/20 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
              <ChevronLeft className="h-6 w-6" aria-hidden="true" />
            </button>
          ) : null}
          {/* The platform player renders above this transition state: embedded MPV
              on desktop, native HTML5 video in the mobile browser. */}
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="w-full max-w-lg text-center">
              <p className="font-label text-white/65">{playbackError ? 'Playback interrupted' : 'Preparing playback'}</p>
              <h1 className="type-page-title mt-5 line-clamp-2 break-words text-white">
                {paramTitle || 'Starting player'}
              </h1>
              {playbackError ? (
                <div className="type-body measure-compact mt-7 rounded-lg border border-red-300/20 bg-red-950/30 px-5 py-4 text-red-100" role="alert">
                  <p>{playbackError}</p>
                  <div className="mt-5 flex flex-wrap justify-center gap-3">
                    {magnet ? (
                      <button
                        type="button"
                        onClick={() => setRetryToken((token) => token + 1)}
                        className="min-h-11 rounded-full bg-white px-5 py-2 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                      >
                        Try again
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => returnToSource()}
                      className="min-h-11 rounded-full border border-white/20 px-5 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                    >
                      Choose another source
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mx-auto mt-7 h-px w-36 overflow-hidden bg-white/10">
                    <div className="animate-shimmer h-full w-1/2 bg-[#ff7a17]" />
                  </div>
                  <p className="type-body mt-4 text-white/70" role="status">Connecting to the video stream…</p>
                </>
              )}
            </div>
          </div>
        </div>
      ) : playbackError ? (
        <div>
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="w-full max-w-lg text-center">
              <p className="font-label text-white/65">Playback interrupted</p>
              <div className="type-body measure-compact mt-7 rounded-lg border border-red-300/20 bg-red-950/30 px-5 py-4 text-red-100" role="alert">
                <p>{playbackError}</p>
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  {magnet ? (
                    <button
                      type="button"
                      onClick={() => setRetryToken((token) => token + 1)}
                      className="min-h-11 rounded-full bg-white px-5 py-2 text-sm text-black transition hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      Try again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => returnToSource()}
                    className="min-h-11 rounded-full border border-white/20 px-5 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  >
                    Choose another source
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <NativePlayerControls
          key={`${magnet}:${fileIndex ?? ''}:${retryToken}`}
          player={platform.player as unknown as Parameters<typeof NativePlayerControls>[0]['player']}
          title={playbackMeta.title}
          year={playbackMeta.year}
          posterUrl={playbackMeta.posterUrl}
          logoUrl={playbackMeta.logoUrl}
          magnet={magnet}
          cat={cat}
          fileIndex={playbackMeta.fileIndex}
          tmdbId={tmdbId ? Number(tmdbId) : undefined}
          imdbId={playbackMeta.imdbId}
          malId={playbackMeta.malId}
          season={Number(season)}
          episode={Number(episode)}
          absoluteEpisode={absoluteEpisode ? Number(absoluteEpisode) : undefined}
          onClose={closePlayer}
        />
      )}
    </div>
  );
}
