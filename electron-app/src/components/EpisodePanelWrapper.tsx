// Electron-compatible EpisodePanel that uses services directly
// This wraps the original but handles API calls through services
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '../lib/router-adapter';
import { Loader2, Play, MonitorPlay } from 'lucide-react';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { getTvSeason } from '../lib/services/tmdb-service';
import { searchTvTorrents, searchAnimeTorrents } from '../lib/services/prowlarr-service';
import { resolveTorrentFile } from '../lib/services/resolve-service';
import type { TorrentRow } from '../lib/types';
import type { EpisodeSummary, SeasonSummary } from '../lib/title-types';

type Props = {
  kind: 'tv' | 'anime';
  title: string;
  titleAliases?: string[] | null;
  imdbId?: string;
  year?: number;
  originalLanguage?: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  seasons: SeasonSummary[];
  initialSeason: number;
  initialEpisodes: EpisodeSummary[];
  seasonApiBase?: string | null;
  tmdbId?: number;
  malId?: number;
};

type SeasonFetchResponse = {
  episodes?: EpisodeSummary[];
  error?: string;
};

type TorrentApiItem = {
  title: string;
  size?: number;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  magnet?: string;
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
};

const formatAirDate = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

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

const VOD_BASE = 'http://localhost:4001';
const isElectron = typeof window !== 'undefined' && Boolean(window.electronAPI);

function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  const KEY = 'mw_device_id';
  const existing = localStorage.getItem(KEY);
  if (existing && existing !== 'null' && existing !== 'undefined') return existing;
  const canUseUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  const newId = canUseUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem(KEY, newId);
  return newId;
}

export default function EpisodePanel({
  kind,
  title,
  titleAliases,
  imdbId,
  year,
  originalLanguage,
  posterUrl,
  backdropUrl,
  seasons,
  initialSeason,
  initialEpisodes,
  seasonApiBase,
  tmdbId,
  malId,
}: Props) {
  const router = useRouter();
  const [selectedSeason, setSelectedSeason] = useState(initialSeason);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>(initialEpisodes);
  const [seasonLoading, setSeasonLoading] = useState(false);
  const [seasonError, setSeasonError] = useState<string | null>(null);

  const [torrentRows, setTorrentRows] = useState<TorrentRow[] | null>(null);
  const [torrentLoading, setTorrentLoading] = useState(false);
  const [torrentError, setTorrentError] = useState<string | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<EpisodeSummary | null>(null);
  const [playBusyId, setPlayBusyId] = useState<string | null>(null);

  const seasonCache = useRef<Map<number, EpisodeSummary[]>>(new Map());
  const rowKey = (t: TorrentRow) => t.infoHash || t.magnetUri || t.torrentUrl || t.title;
  const normalizedSeasons = seasons.length ? seasons : [{ seasonNumber: initialSeason, name: `Season ${initialSeason}` }];

  useEffect(() => {
    seasonCache.current.set(initialSeason, initialEpisodes);
    setEpisodes(initialEpisodes);
    setSelectedSeason(initialSeason);
  }, [initialSeason, initialEpisodes]);

  const onSeasonChange = async (value: string) => {
    const seasonNum = Number(value);
    setSelectedSeason(seasonNum);
    setSeasonError(null);

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
      const eps: EpisodeSummary[] = Array.isArray(seasonData.episodes)
        ? seasonData.episodes.map((ep: any) => ({
            id: ep.id,
            name: ep.name || `Episode ${ep.episode_number ?? ''}`,
            overview: ep.overview || '',
            stillUrl: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : undefined,
            episodeNumber: ep.episode_number,
            seasonNumber: ep.season_number ?? seasonNum,
            airDate: ep.air_date,
            runtime: typeof ep.runtime === 'number' ? ep.runtime : null,
          }))
        : [];
      seasonCache.current.set(seasonNum, eps);
      setEpisodes(eps);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load season';
      setSeasonError(message);
      setEpisodes([]);
    } finally {
      setSeasonLoading(false);
    }
  };

  const fetchTorrentsForEpisode = async (episode: EpisodeSummary) => {
    setActiveEpisode(episode);
    setTorrentLoading(true);
    setTorrentError(null);
    setTorrentRows(null);
    try {
      console.log('[EpisodePanel] Fetching torrents for episode', episode.episodeNumber);
      let result: { results: TorrentApiItem[]; error?: string };
      
      if (kind === 'anime') {
        result = await searchAnimeTorrents({
          title,
          year,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
          absolute: episode.absoluteNumber ?? episode.episodeNumber,
          aliases: titleAliases || [],
          tvdbId: undefined,
        });
      } else {
        result = await searchTvTorrents({
          imdbId,
          title,
          season: episode.seasonNumber,
          episode: episode.episodeNumber,
          year,
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
            torrentUrl: it.torrentUrl || it.downloadUrl,
            downloadUrl: it.downloadUrl,
            infoHash: it.infoHash,
            indexer: it.indexer || '-',
            publishDate: it.publishDate,
            episodeMatch: it.episodeMatch,
            seasonPack: it.seasonPack,
          }))
        : [];
      setTorrentRows(rows);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to fetch torrents';
      setTorrentError(message);
      setTorrentRows([]);
    } finally {
      setTorrentLoading(false);
    }
  };

  const resetSelection = () => {
    setActiveEpisode(null);
    setTorrentRows(null);
    setTorrentError(null);
    setTorrentLoading(false);
  };

  const playTorrent = async (t: TorrentRow) => {
    const magnet = t.magnetUri || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : '') || t.torrentUrl || '';
    if (!magnet) {
      setTorrentError('Unable to start playback: missing magnet.');
      return;
    }
    const key = rowKey(t);
    setPlayBusyId(key);
    try {
      let fileIndex: number | undefined;
      if (activeEpisode && t.seasonPack) {
        // Resolve file index for season packs
        try {
          const resolved = await resolveTorrentFile({
            magnetUri: t.magnetUri,
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
        } catch (err) {
          console.warn('[EpisodePanel] Failed to resolve file index:', err);
          // Continue without file index
        }
      }

      const params: Record<string, string> = {
        cat: kind,
        magnet,
        title: `${title} - S${String(activeEpisode?.seasonNumber || selectedSeason).padStart(2, '0')}E${String(activeEpisode?.episodeNumber || 0).padStart(2, '0')}`,
      };
      if (activeEpisode) {
        params.season = String(activeEpisode.seasonNumber || selectedSeason);
        params.episode = String(activeEpisode.episodeNumber);
      }
      if (fileIndex != null) params.fileIndex = String(fileIndex);
      if (kind === 'anime' && malId) {
        params.seriesId = `mal:${malId}`;
      } else if (tmdbId) {
        params.seriesId = `tmdb:tv:${tmdbId}`;
      }

      if (isElectron) {
        if (!window.electronAPI) {
          setTorrentError('Electron API is not available');
          return;
        }
        console.log('[EpisodePanel] Checking MPV readiness...');
        const readyCheck = await window.electronAPI.isMpvReady();
        if (!readyCheck?.ready) {
          console.log('[EpisodePanel] Waiting for MPV to be ready...');
          await window.electronAPI.waitForMpvReady();
        }
        console.log('[EpisodePanel] Calling playInMpv with:', { url: magnet, title: params.title, cat: kind });
        const result = await window.electronAPI.playInMpv({ 
          url: magnet, 
          title: params.title,
          cat: kind,
          fileIndex: 0,
        });
        console.log('[EpisodePanel] playInMpv result:', result);
        if (result?.ok) {
          router.push('watch', params);
        } else {
          setTorrentError(`Playback failed: ${result?.error || 'Unknown error'}`);
        }
      } else {
        // Web fallback - download M3U
        const streamUrl = `${VOD_BASE}/stream?cat=${kind}&magnet=${encodeURIComponent(magnet)}&subjectId=${getDeviceId()}&trackProgress=1`;
        const blob = new Blob([`#EXTM3U\n#EXTINF:-1,${params.title}\n${streamUrl}\n`], { type: 'audio/x-mpegurl' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${params.title}.m3u`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setTorrentError(err instanceof Error ? err.message : 'Playback failed');
    } finally {
      setPlayBusyId(null);
    }
  };

  // Render the UI - this is a simplified version
  // You'd copy the full UI from the original EpisodePanel
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <Select value={String(selectedSeason)} onValueChange={onSeasonChange}>
          <SelectTrigger className="mt-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {normalizedSeasons.map((s) => (
              <SelectItem key={s.seasonNumber} value={String(s.seasonNumber)}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {seasonLoading && <div className="text-slate-400">Loading season...</div>}
      {seasonError && <div className="text-red-400">{seasonError}</div>}

      <div className="space-y-2">
        {episodes.map((ep) => (
          <div
            key={ep.id}
            className="rounded-lg border border-white/10 bg-white/5 p-3 hover:bg-white/10 cursor-pointer"
            onClick={() => void fetchTorrentsForEpisode(ep)}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-white">
                  {ep.episodeNumber}. {ep.name}
                </div>
                {ep.airDate && <div className="text-xs text-slate-400">{formatAirDate(ep.airDate)}</div>}
              </div>
              {activeEpisode?.id === ep.id && torrentLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
          </div>
        ))}
      </div>

      {activeEpisode && torrentRows && (
        <div className="mt-4 space-y-2">
          {torrentRows.map((t) => (
            <div key={rowKey(t)} className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-white text-sm">{t.title}</div>
                  <div className="text-xs text-slate-400">
                    {t.seeders ? `↑ ${t.seeders}` : ''} {t.size ? formatBytes(t.size) : ''}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => void playTorrent(t)}
                  disabled={playBusyId === rowKey(t)}
                  className="bg-cyan-500 text-black hover:bg-cyan-400"
                >
                  <Play className="mr-1 h-3 w-3" />
                  Play
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}



