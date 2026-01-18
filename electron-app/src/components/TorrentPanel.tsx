// Electron-compatible wrapper for TorrentPanel that fixes API calls
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from '../lib/router-adapter';
import { Button } from './ui/button';
import { Loader2, Play, RotateCcw, MonitorPlay } from 'lucide-react';
import { getVodBase } from '../lib/api-client';
import { searchMovieTorrents, searchAnimeTorrents } from '../lib/services/prowlarr-service';
import type { TorrentRow } from '../lib/types';

type Props = {
  title: string;
  year?: number;
  imdbId?: string;
  originalLanguage?: string;
  kind?: 'movie' | 'anime';
  malId?: number;
  tmdbId?: number;
  titleAliases?: string[];
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
    subParams.set('langs', 'en,hi');
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
  malId,
  tmdbId,
  titleAliases,
}: Props) {
  const router = useRouter();
  const [torrents, setTorrents] = useState<TorrentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const canSearch = title.length > 0;
  const isAnime = kind === 'anime';

  const refresh = async () => {
    if (!canSearch) return;
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
        torrentUrl: it.torrentUrl || it.downloadUrl,
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
      setLoading(false);
    }
  };

  useEffect(() => {
    setTorrents(null);
    setLastFetched(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, imdbId, year, originalLanguage, kind, malId]);

  const meta = useMemo(() => {
    if (!lastFetched) return null;
    return new Date(lastFetched).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }, [lastFetched]);

  const playInMpv = async (t: TorrentRow) => {
    console.log('[TorrentPanel] playInMpv called with torrent:', t);
    window.electronAPI?.debugLog?.('[TorrentPanel] playInMpv click', {
      title: t.title,
      hasMagnetUri: Boolean(t.magnetUri),
      hasInfoHash: Boolean(t.infoHash),
    });
    
    if (!isElectron) {
      console.warn('[TorrentPanel] Not in Electron environment, cannot play');
      alert('MPV playback is only available in the Electron app');
      return;
    }

    if (!window.electronAPI) {
      console.error('[TorrentPanel] electronAPI is not available');
      alert('Electron API is not available. Please restart the application.');
      return;
    }

    // For now, only accept direct magnet URIs (or build from infoHash).
    // Some indexers provide HTTP "download" URLs that redirect to magnet:, which breaks the backend fetch path.
    const directMagnet = t.magnetUri?.startsWith('magnet:') ? t.magnetUri : '';
    const magnet = directMagnet || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : '');
    console.log('[TorrentPanel] Resolved magnet:', magnet);
    
    if (!magnet) {
      console.warn('[TorrentPanel] No direct magnet available for torrent:', t.title);
      alert('This torrent requires download URL resolution (not yet supported). Try a different torrent.');
      return;
    }

    // Navigate to player page with all necessary params
    const params: Record<string, string> = {
      magnet,
      title: title || 'Playing',
      cat: kind,
      fileIndex: '0',
    };
    if (tmdbId) params.tmdbId = String(tmdbId);
    if (malId) params.malId = String(malId);
    if (year) params.year = String(year);

    console.log('[TorrentPanel] Navigating to player page with params:', params);
    router.push('player', params);
  };

  if (!canSearch) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-slate-400">
        <p>Enter a title to search for torrents</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Torrents</h3>
          {meta && <p className="text-xs text-slate-400">Last updated: {meta}</p>}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          className="text-slate-300"
        >
          <RotateCcw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {loading && torrents === null && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-900/20 border border-red-500/30 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && torrents && torrents.length === 0 && (
        <div className="rounded-lg bg-slate-800/40 p-4 text-center text-slate-400">
          No torrents found
        </div>
      )}

      {!loading && torrents && torrents.length > 0 && (
        <div className="space-y-2">
          {torrents.slice(0, 10).map((t, idx) => {
            const quality = qualityFromTitle(t.title);
            const isPrimary = idx === 0;
            return (
              <div
                key={t.magnetUri || t.infoHash || idx}
                className={`rounded-lg border p-3 transition-colors ${
                  isPrimary
                    ? 'border-cyan-500/50 bg-cyan-500/10'
                    : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-medium text-white truncate">{t.title}</p>
                      {quality && (
                        <span className="shrink-0 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-200">
                          {quality}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
                      {t.size && <span>{formatBytes(t.size)}</span>}
                      {typeof t.seeders === 'number' && (
                        <span className="text-green-400">↑ {t.seeders}</span>
                      )}
                      {typeof t.leechers === 'number' && (
                        <span className="text-amber-400">↓ {t.leechers}</span>
                      )}
                      {t.indexer && <span>{t.indexer}</span>}
                      {t.publishDate && <span>{formatDate(t.publishDate)}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {isElectron && (
                      <Button
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log('[TorrentPanel] Play button clicked for torrent:', t);
                          void playInMpv(t);
                        }}
                        className="bg-cyan-500 text-black hover:bg-cyan-400"
                      >
                        <Play className="mr-1 h-3 w-3" />
                        Play
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const directMagnet = t.magnetUri?.startsWith('magnet:') ? t.magnetUri : '';
                        const magnet = directMagnet || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : '');
                        if (magnet) {
                          void downloadM3U(magnet, title, kind);
                        }
                      }}
                      className="border-white/20 text-slate-300"
                    >
                      <MonitorPlay className="mr-1 h-3 w-3" />
                      VLC
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}



