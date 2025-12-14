"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Play, RotateCcw, MonitorPlay } from "lucide-react";
import type { TorrentRow } from "@/components/torrentListModal/torrentListDialog";

type Props = {
  title: string;
  year?: number;
  imdbId?: string;
  originalLanguage?: string;
  /** "movie" (default) or "anime" for anime movies */
  kind?: "movie" | "anime";
  /** MAL ID for anime movies */
  malId?: number;
  /** TMDB ID for movies */
  tmdbId?: number;
  /** Alternative titles for better anime search */
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

type TorrentApiResponse = {
  results?: TorrentApiItem[];
  error?: string;
};

const formatBytes = (value?: number) => {
  if (!value || value <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
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
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

function qualityFromTitle(title: string) {
  const lower = title.toLowerCase();
  if (lower.includes("2160p") || /\b4k\b/i.test(title)) return "2160p";
  if (lower.includes("1080p")) return "1080p";
  if (lower.includes("720p")) return "720p";
  return null;
}

const VOD_BASE = "http://localhost:4001";
const isElectron = typeof window !== "undefined" && Boolean((window as any).electronAPI);

function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  const KEY = "mw_device_id";
  const existing = localStorage.getItem(KEY);
  if (existing && existing !== "null" && existing !== "undefined") return existing;
  const canUseUUID = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function";
  const newId = canUseUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem(KEY, newId);
  return newId;
}

async function downloadM3U(magnet: string, displayTitle: string, cat: string, seriesId?: string, imdbId?: string) {
  const params = new URLSearchParams();
  params.set("cat", cat);
  params.set("magnet", magnet);
  // Include tracking info so server can auto-save progress
  if (seriesId) params.set("seriesId", seriesId);
  params.set("subjectId", getDeviceId());
  params.set("trackProgress", "1");
  
  const streamUrl = `${VOD_BASE}/stream?${params.toString()}`;
  const safeFilename = displayTitle.replace(/[<>:"/\\|?*]/g, "_");
  
  // Try to fetch subtitles from Go backend
  let subtitleUrl: string | undefined;
  try {
    const subParams = new URLSearchParams({ cat, magnet });
    if (imdbId) subParams.set("imdbId", imdbId);
    subParams.set("langs", "en,hi");
    const res = await fetch(`${VOD_BASE}/subtitles/list?${subParams.toString()}`);
    if (res.ok) {
      const data = await res.json();
      // Prefer torrent subtitles, then external
      const torrentSub = data.torrent?.[0];
      const externalSub = data.external?.[0];
      if (torrentSub) {
        subtitleUrl = `${VOD_BASE}/subtitles/torrent?magnet=${encodeURIComponent(magnet)}&cat=${cat}&fileIndex=${torrentSub.index}`;
      } else if (externalSub) {
        subtitleUrl = `${VOD_BASE}${externalSub.url}`;
      }
    }
  } catch {}
  
  // Build M3U content with optional subtitle for VLC
  // Use input-slave for network URLs (sub-file only works for local paths)
  let m3uContent = `#EXTM3U\n#EXTINF:-1,${displayTitle}\n`;
  if (subtitleUrl) {
    m3uContent += `#EXTVLCOPT:input-slave=${subtitleUrl}\n`;
    m3uContent += `#EXTVLCOPT:sub-track=0\n`;
  }
  m3uContent += `${streamUrl}\n`;

  const blob = new Blob([m3uContent], { type: "audio/x-mpegurl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFilename}.m3u`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function TorrentPanel({ title, year, imdbId, originalLanguage, kind = "movie", malId, tmdbId, titleAliases }: Props) {
  const router = useRouter();
  const [torrents, setTorrents] = useState<TorrentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const canSearch = title.length > 0;
  const isAnime = kind === "anime";

  const refresh = async () => {
    if (!canSearch) return;
    setLoading(true);
    setError(null);
    try {
      let url: string;
      
      if (isAnime) {
        // Use anime torrents API for anime movies
        const params = new URLSearchParams();
        params.set("title", title);
        // Add aliases for better search
        if (titleAliases?.length) {
          for (const alias of titleAliases.slice(0, 5)) {
            params.append("alias", alias);
          }
        }
        if (year) params.set("year", String(year));
        // For movies, we don't specify season/episode - search for the movie title
        url = `/api/torrents/anime?${params.toString()}`;
      } else {
        // Regular movie torrents API
        const params = new URLSearchParams();
        if (imdbId) {
          params.set("imdbId", imdbId);
        } else {
          params.set("title", title);
          if (year) params.set("year", String(year));
        }
        if (originalLanguage) params.set("origLang", originalLanguage);
        url = `/api/torrents/movie?${params.toString()}`;
      }

      const res = await fetch(url, { cache: "no-store" });
      const json: TorrentApiResponse = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to load torrents");
      const items = Array.isArray(json?.results) ? json.results : [];
      const rows: TorrentRow[] = items.map((it) => ({
        title: it.title,
        size: typeof it.size === "number" ? it.size : it.sizeBytes,
        seeders: it.seeders,
        leechers: it.leechers,
        magnetUri: it.magnetUri || it.magnet,
        torrentUrl: it.torrentUrl || it.downloadUrl,
        infoHash: it.infoHash,
        indexer: it.indexer || "-",
        publishDate: it.publishDate,
      }));
      setTorrents(rows);
      setLastFetched(Date.now());
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load torrents";
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
    return new Date(lastFetched).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }, [lastFetched]);

  const primaryTorrent = torrents?.[0];

  const playInMpv = async (t: TorrentRow) => {
    if (!isElectron) return;
    const magnet = t.magnetUri || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : "") || t.torrentUrl || "";
    if (!magnet) return;
    const params = new URLSearchParams();
    params.set("cat", isAnime ? "anime" : "movie");
    params.set("magnet", magnet);
    const streamUrl = `${VOD_BASE}/stream?${params.toString()}`;
    try {
      await (window as any).electronAPI.playInMpv(streamUrl);
    } catch (err) {
      console.error("mpv play failed", err);
    }
  };

  const playTorrent = (t: TorrentRow) => {
    // Prefer magnet links over HTTP torrent URLs (which can fail if indexer returns HTML)
    const magnet = t.magnetUri || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : "") || t.torrentUrl || "";
    if (!magnet) return;
    const qs = new URLSearchParams();
    qs.set("src", magnet);
    qs.set("title", title);
    qs.set("cat", isAnime ? "anime" : "movie");
    if (year) qs.set("year", String(year));
    if (imdbId) qs.set("imdbId", imdbId);
    if (malId) qs.set("malId", String(malId));
    // Build seriesId for watch progress tracking
    if (isAnime && malId) {
      qs.set("seriesId", `mal:${malId}`);
    } else if (tmdbId) {
      qs.set("seriesId", `tmdb:movie:${tmdbId}`);
    }
    router.push(`/watch?${qs.toString()}`);
  };

  return (
    <aside className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-white shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-400">{isAnime ? "Anime" : "Movie"} Streams</p>
          <h2 className="text-lg font-semibold text-white">Available torrents</h2>
          <p className="text-xs text-slate-400">Pick the best source and start watching instantly.</p>
        </div>
        <div className="flex flex-col items-end gap-2 text-xs text-slate-400">
          {primaryTorrent ? (
            <Button
              size="sm"
              className="rounded-full bg-cyan-500 px-4 py-2 text-black shadow-lg shadow-cyan-500/30 hover:bg-cyan-400"
              onClick={() => playTorrent(primaryTorrent)}
              aria-label="Play top stream"
            >
              <Play className="mr-2 h-4 w-4" />
              Play top
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="rounded-full border-white/20 text-white hover:bg-white/10"
            onClick={() => void refresh()}
            disabled={loading || !canSearch}
          >
            <RotateCcw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {meta ? <p className="text-xs text-slate-500">Updated {meta}</p> : null}

      <div className="space-y-3">
        {loading && (
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-6 text-sm text-slate-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            Fetching torrents…
          </div>
        )}

        {!loading && error && (
          <div className="rounded-2xl border border-red-900/40 bg-red-500/10 px-4 py-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {!loading && !error && (!torrents || torrents.length === 0) && (
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-slate-200">
            No torrents found yet. Try refreshing in a bit.
          </div>
        )}

        {!loading && !error && torrents && torrents.length > 0 && (
          <div
            className="space-y-2 overflow-y-auto pr-1"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#475569 transparent", maxHeight: "70vh" }}
          >
            {torrents.slice(0, 12).map((t, idx) => {
              const quality = qualityFromTitle(t.title);
              const aired = formatDate(t.publishDate);
              const magnet = t.magnetUri || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : "") || t.torrentUrl || "";
              const displayTitle = year ? `${title} (${year})` : title;
              return (
                <div
                  key={`${t.infoHash || t.title}-${idx}`}
                  className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-left transition hover:border-cyan-400/50"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 text-xs font-semibold text-cyan-200">
                    {quality ?? "—"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-white">{t.title}</div>
                    <div className="text-xs text-slate-400">
                      {formatBytes(t.size)} • {t.seeders ?? 0} seed{t.seeders === 1 ? "" : "s"} • {t.indexer}
                      {aired ? ` • ${aired}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {magnet && (
                      <button
                        className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-500/20 text-orange-300 transition hover:bg-orange-500/40"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Build seriesId for progress tracking
                          let sId: string | undefined;
                          if (isAnime && malId) sId = `mal:${malId}`;
                          else if (tmdbId) sId = `tmdb:movie:${tmdbId}`;
                          void downloadM3U(magnet, displayTitle, isAnime ? "anime" : "movie", sId, imdbId);
                        }}
                        title="Download .m3u for VLC"
                      >
                        <MonitorPlay className="h-4 w-4" />
                      </button>
                    )}
                    {isElectron && magnet && (
                      <button
                        className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300 transition hover:bg-emerald-500/40"
                        onClick={(e) => {
                          e.stopPropagation();
                          void playInMpv(t);
                        }}
                        title="Play in mpv (Electron)"
                      >
                        <MonitorPlay className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/20 text-cyan-300 transition hover:bg-cyan-500/40"
                      onClick={() => playTorrent(t)}
                      title="Play in browser"
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

