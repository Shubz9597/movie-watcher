// Electron-compatible wrapper for TorrentPanel that fixes API calls
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '../lib/router-adapter';
import { Button } from './ui/button';
import { Loader2, RotateCcw } from 'lucide-react';
import PlaybackSplitButton from './PlaybackSplitButton';
import { getVodBase } from '../lib/api-client';
import { resolveTorrentSource, searchMovieTorrents, searchAnimeTorrents } from '../lib/services/torrent-search-service';
import { getSavedResumeSource } from '../lib/services/continue-service';
import type { ResumeSourceContext, SavedResumeSource, TorrentRow } from '../lib/types';
import { prioritizePreviouslyUsedTorrent, torrentInfoHash } from '../lib/torrent-identity';
import { getDeviceId } from '../lib/device-id';

type Props = {
  title: string;
  year?: number;
  imdbId?: string;
  originalLanguage?: string;
  kind?: 'movie' | 'anime';
  anilistId?: number;
  tmdbId?: number;
  titleAliases?: string[];
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
};

const formatBytes = (value?: number) => {
  if (!value || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(2)} ${units[idx]}`;
};

const formatDate = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function qualityFromTitle(title: string) {
  const lower = title.toLowerCase();
  if (lower.includes('2160p') || /\b4k\b/i.test(title)) return '2160p';
  if (lower.includes('1080p')) return '1080p';
  if (lower.includes('720p')) return '720p';
  return null;
}

const VOD_BASE = getVodBase();
const isElectron = typeof window !== 'undefined' && Boolean(window.electronAPI);

async function downloadM3U(magnet: string, displayTitle: string, cat: string, seriesId?: string, imdbId?: string) {
  const params = new URLSearchParams();
  params.set('cat', cat);
  params.set('magnet', magnet);
  if (seriesId) params.set('seriesId', seriesId);
  params.set('subjectId', getDeviceId());
  params.set('trackProgress', '1');

  const streamUrl = `${VOD_BASE}/stream?${params.toString()}`;
  const safeFilename = displayTitle.replace(/[<>:"/\\|?*]/g, '_');

  let subtitleUrl: string | undefined;
  try {
    const subParams = new URLSearchParams({ cat, magnet });
    if (imdbId) subParams.set('imdbId', imdbId);
    subParams.set('langs', 'en');
    const res = await fetch(`${VOD_BASE}/subtitles/list?${subParams.toString()}`);
    if (res.ok) {
      const data = await res.json();
      const torrentSub = data.torrent?.[0];
      const externalSub = data.external?.[0];
      if (torrentSub) {
        subtitleUrl = `${VOD_BASE}/subtitles/torrent?magnet=${encodeURIComponent(magnet)}&cat=${cat}&fileIndex=${torrentSub.index}`;
      } else if (externalSub) {
        subtitleUrl = `${VOD_BASE}${externalSub.url}`;
      }
    }
  } catch {}

  let m3uContent = `#EXTM3U\n#EXTINF:-1,${displayTitle}\n`;
  if (subtitleUrl) {
    m3uContent += `#EXTVLCOPT:input-slave=${subtitleUrl}\n`;
    m3uContent += `#EXTVLCOPT:sub-track=0\n`;
  }
  m3uContent += `${streamUrl}\n`;

  const blob = new Blob([m3uContent], { type: 'audio/x-mpegurl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename}.m3u`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function TorrentPanel({
  title,
  year,
  imdbId,
  originalLanguage,
  kind = 'movie',
  anilistId,
  tmdbId,
  titleAliases,
  resumeContext,
  resumeSource,
}: Props) {
  const router = useRouter();
  const [torrents, setTorrents] = useState<TorrentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [historySource, setHistorySource] = useState<SavedResumeSource | null>(null);
  const refreshInFlight = useRef(false);
  const actionInFlight = useRef(false);

  const canSearch = title.length > 0;
  const isAnime = kind === 'anime';
  const defaultSeriesId = anilistId
    ? `anilist:${anilistId}`
    : tmdbId
      ? `tmdb:movie:${tmdbId}`
      : '';
  const preferredSourceContext = resumeContext || (defaultSeriesId
    ? { subjectId: getDeviceId(), seriesId: defaultSeriesId, season: 0, episode: 0 }
    : null);

  useEffect(() => {
    let cancelled = false;
    setHistorySource(null);
    if (!preferredSourceContext) return;
    void getSavedResumeSource(preferredSourceContext).then((result) => {
      if (!cancelled && result.found) setHistorySource(result.source);
    });
    return () => {
      cancelled = true;
    };
  }, [preferredSourceContext?.subjectId, preferredSourceContext?.seriesId, preferredSourceContext?.season, preferredSourceContext?.episode]);

  const refresh = async () => {
    if (!canSearch || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      console.log('[TorrentPanel] Searching torrents for', title, kind);

      let result: { results: TorrentApiItem[]; error?: string };
      if (isAnime) {
        result = await searchAnimeTorrents({
          title,
          year,
          aliases: titleAliases,
          originalLanguage,
        });
      } else {
        result = await searchMovieTorrents({
          imdbId,
          title,
          year,
          originalLanguage,
        });
      }

      if (result.error) throw new Error(result.error);
      const items = Array.isArray(result.results) ? result.results : [];
      const rows: TorrentRow[] = items.map((it) => ({
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
      }));
      console.log('[TorrentPanel] Found', rows.length, 'torrents');
      setTorrents(rows);
      setLastFetched(Date.now());
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load torrents';
      console.error('[TorrentPanel] Error:', e);
      setError(message);
      setTorrents([]);
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    setTorrents(null);
    setLastFetched(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, imdbId, year, originalLanguage, kind, anilistId]);

  const meta = useMemo(() => {
    if (!lastFetched) return null;
    return new Date(lastFetched).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }, [lastFetched]);

  const displayedTorrents = useMemo(() => {
    return prioritizePreviouslyUsedTorrent(torrents || [], resumeSource || historySource);
  }, [historySource, resumeSource, torrents]);
  const actionKey = (torrent: TorrentRow) =>
    torrentInfoHash(torrent.infoHash) || torrentInfoHash(torrent.magnetUri) || torrent.sourceId || torrent.torrentUrl || torrent.title;

  const playInMpv = async (t: TorrentRow) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyActionId(`play:${actionKey(t)}`);
    setError(null);
    try {
    console.log('[TorrentPanel] playInMpv called with torrent:', t);
    window.electronAPI?.debugLog?.('[TorrentPanel] playInMpv click', {
      title: t.title,
      hasMagnetUri: Boolean(t.magnetUri),
      hasInfoHash: Boolean(t.infoHash),
    });
    
    if (!isElectron) {
      console.warn('[TorrentPanel] Not in Electron environment, cannot play');
      setError('MPV playback is only available in the Electron app.');
      return;
    }

    if (!window.electronAPI) {
      console.error('[TorrentPanel] electronAPI is not available');
      setError('The Electron playback bridge is unavailable. Restart TorWatch and try again.');
      return;
    }

    let magnet: string;
    try {
      magnet = await resolveTorrentSource(t);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to resolve the selected torrent.';
      setError(message);
      return;
    }

    // Navigate to player page with all necessary params
    const params: Record<string, string> = {
      magnet,
      title: title || 'Playing',
      cat: kind,
      sourceName: t.title,
    };
    if (resumeContext) {
      params.seriesId = resumeContext.seriesId;
      params.season = String(resumeContext.season);
      params.episode = String(resumeContext.episode);
    }
    if (tmdbId) params.tmdbId = String(tmdbId);
    if (imdbId) params.imdbId = imdbId;
    if (anilistId) params.anilistId = String(anilistId);
    if (!params.seriesId && defaultSeriesId) params.seriesId = defaultSeriesId;
    if (t.fileIndex != null) params.fileIndex = String(t.fileIndex);
    if (year) params.year = String(year);

    console.log('[TorrentPanel] Navigating to player page with params:', params);
    router.push('player', params);
    } finally {
      actionInFlight.current = false;
      setBusyActionId(null);
    }
  };

  const openInExternalPlayer = async (torrent: TorrentRow) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyActionId(`external:${actionKey(torrent)}`);
    setError(null);
    try {
      const magnet = await resolveTorrentSource(torrent);
      await downloadM3U(magnet, title, kind, defaultSeriesId || undefined, imdbId);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to resolve the selected torrent.');
    } finally {
      actionInFlight.current = false;
      setBusyActionId(null);
    }
  };

  if (!canSearch) {
    return (
      <div className="type-body rounded-xl border border-white/[0.1] bg-[#0a0a0a]/70 p-6 text-center text-white/70 backdrop-blur-xl">
        <p>Enter a title to find available sources.</p>
      </div>
    );
  }

  return (
    <aside className="overflow-hidden rounded-xl border border-white/[0.12] bg-[#0a0a0a]/75 backdrop-blur-2xl">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
        <div>
          <p className="type-secondary font-medium text-white/65">Playback</p>
          <h3 className="type-panel-title mt-1 text-white">Available sources</h3>
          {meta ? <p className="type-caption text-numeric mt-1 text-white/65">Updated {meta}</p> : null}
        </div>
        <Button
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          variant="outline"
          className="min-h-11 rounded-full border-white/20 bg-transparent px-4 text-white/75 hover:border-white/40 hover:bg-white/[0.05] hover:text-white"
        >
          <RotateCcw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {loading && torrents === null && (
        <div className="flex items-center justify-center gap-2 px-5 py-14 text-sm text-white/60" role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" />
          Finding sources…
        </div>
      )}

      {error && (
        <div className="m-4 rounded-lg border border-red-400/20 bg-red-950/20 p-4 text-sm text-red-100" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void window.electronAPI?.openSetup()}
            className="mt-3 min-h-10 rounded-full border border-white/20 px-4 text-sm text-white/85 transition hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            Open settings
          </button>
        </div>
      )}

      {!loading && torrents && displayedTorrents.length === 0 && (
        <div className="type-body m-4 rounded-lg border border-dashed border-white/15 p-8 text-center text-white/70">
          No sources found for this title.
        </div>
      )}

      {!loading && torrents && displayedTorrents.length > 0 && (
        <div>
          {displayedTorrents.slice(0, 10).map((t, idx) => {
            const quality = qualityFromTitle(t.title);
            const isPreviouslyUsed = t.previouslyUsed === true;
            const torrentActionKey = actionKey(t);
            const playActionId = `play:${torrentActionKey}`;
            const externalActionId = `external:${torrentActionKey}`;
            return (
              <div
                key={torrentInfoHash(t.infoHash) || torrentInfoHash(t.magnetUri) || t.magnetUri || t.infoHash || idx}
                className={`border-b border-white/[0.08] px-5 py-4 transition-colors last:border-b-0 ${
                  isPreviouslyUsed ? 'bg-[#ff7a17]/[0.09]' : 'hover:bg-white/[0.035]'
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex items-center gap-2">
                      <p className="truncate text-sm text-white/85" title={t.title}>{t.title}</p>
                      {quality && (
                        <span className="font-label shrink-0 rounded border border-white/20 px-1.5 py-0.5 text-white/70">
                          {quality}
                        </span>
                      )}
                      {isPreviouslyUsed ? (
                        <span className="font-label shrink-0 rounded bg-[#ff7a17] px-1.5 py-0.5 text-black">Previously used</span>
                      ) : null}
                    </div>
                    <div className="type-caption text-numeric flex flex-wrap items-center gap-x-3 gap-y-1 text-white/70">
                      {t.size && <span>{formatBytes(t.size)}</span>}
                      {typeof t.seeders === 'number' && (
                        <span className="text-emerald-300/70">↑ {t.seeders}</span>
                      )}
                      {typeof t.leechers === 'number' && (
                        <span className="text-[#ffc285]/70">↓ {t.leechers}</span>
                      )}
                      {t.indexer && <span>{t.indexer}</span>}
                      {t.publishDate && <span>{formatDate(t.publishDate)}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0">
                    {isElectron && (
                      <PlaybackSplitButton
                        onPlay={() => {
                          console.log('[TorrentPanel] Play button clicked for torrent:', t);
                          void playInMpv(t);
                        }}
                        onOpenExternal={() => void openInExternalPlayer(t)}
                        disabled={Boolean(busyActionId)}
                        playBusy={busyActionId === playActionId}
                        externalBusy={busyActionId === externalActionId}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}



