"use client";

import { useMemo, useState, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Loader2, FileDown } from "lucide-react";

export type TorrentRow = {
  title: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  torrentUrl?: string;
  infoHash?: string;
  indexer: string;
  publishDate?: string;
};

// ---- prefetch types & helpers ----
type PrefetchResult = {
  infoHash: string;
  name: string;
  fileIndex: number;
  fileName: string;
  length: number;
  contentType?: string;
  prewarmedBytes?: number;
  tookMs?: number;
};

const PREFETCH_DELAY_MS = 200;
const VOD_BASE = "http://localhost:4001";

function keyFor(t: TorrentRow) {
  // stable key for maps
  return (
    t.infoHash?.toLowerCase() ||
    t.magnetUri ||
    t.torrentUrl ||
    t.title
  );
}

function buildPrefetchUrl(t: TorrentRow, cat: string) {
  const u = new URL(`${VOD_BASE}/prefetch`);
  u.searchParams.set("cat", cat || "movie");

  if (t.magnetUri) {
    u.searchParams.set("magnet", t.magnetUri);
  } else if (t.infoHash) {
    u.searchParams.set("magnet", `magnet:?xt=urn:btih:${t.infoHash}`);
  } else if (t.torrentUrl) {
    // Go backend accepts ?src=<.torrent or indexer download URL>
    u.searchParams.set("src", t.torrentUrl);
  }
  return u.toString();
}

/* ---------- helpers ---------- */
function formatSize(n?: number) {
  if (!n || n <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let u = 0, x = n;
  while (x >= 1024 && u < units.length - 1) { x /= 1024; u++; }
  return `${x.toFixed(2)} ${units[u]}`;
}

type Quality = "2160p" | "1080p" | "720p" | "other";

function qualityFromTitle(title: string): Quality {
  const t = title.toLowerCase();
  if (t.includes("2160p") || /\b4k\b/i.test(t)) return "2160p";
  if (t.includes("1080p")) return "1080p";
  if (t.includes("720p")) return "720p";
  return "other";
}
function qualityRank(q: Quality): number {
  switch (q) {
    case "2160p": return 3;
    case "1080p": return 2;
    case "720p": return 1;
    default: return 0;
  }
}

function QualityBadge({ title }: { title: string }) {
  const q = qualityFromTitle(title);
  if (q === "other") return null;
  return <Badge variant="secondary" className="bg-black/60">{q}</Badge>;
}


function streamUrlFor(t: TorrentRow, cat: string, fileIndex?: number) {
  const u = new URL(`${VOD_BASE}/stream`);
  u.searchParams.set("cat", cat || "movie");

  if (t.magnetUri) {
    u.searchParams.set("magnet", t.magnetUri);
  } else if (t.infoHash) {
    u.searchParams.set("magnet", `magnet:?xt=urn:btih:${t.infoHash}`);
  } else if (t.torrentUrl) {
    u.searchParams.set("src", t.torrentUrl);
  }
  if (fileIndex != null) u.searchParams.set("fileIndex", String(fileIndex));
  return u.toString();
}

function downloadM3U(title: string, streamUrl: string) {
  const safe = (title || "stream").replace(/[^\w\- .]/g, "_").slice(0, 120);
  const body = `#EXTM3U\n#EXTINF:-1,${title}\n${streamUrl}\n`;
  const blob = new Blob([body], { type: "audio/x-mpegurl" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}.m3u`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

/* ---------- component ---------- */
export default function TorrentListDialog({
  open,
  onOpenChange,
  loading,
  error,
  movie,
  torrents,
  onPlay,
  cat = "movie",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  loading: boolean;
  error?: string | null;
  movie: { title: string; year?: number; posterUrl?: string | null; backdropUrl?: string | null };
  torrents: TorrentRow[] | null;
  onPlay: (t: TorrentRow, fileIndex?: number) => void;
  cat?: string; // NEW
}) {

  // Presence stats (which qualities exist in this result set?)
  const { present, counts } = useMemo(() => {
    const list = torrents ?? [];
    const c: Record<Quality, number> = { "2160p": 0, "1080p": 0, "720p": 0, other: 0 };
    for (const t of list) c[qualityFromTitle(t.title)]++;
    const p = (Object.keys(c) as Quality[]).filter(q => c[q] > 0);
    return { present: p, counts: c };
  }, [torrents]);

  // Quality filter state (only relevant for visible chips)
  const [q2160, setQ2160] = useState(true);
  const [q1080, setQ1080] = useState(true);
  const [q720, setQ720] = useState(true);
  const [qOther, setQOther] = useState(true);
  const [prefetchMap, setPrefetchMap] = useState<Record<string, PrefetchResult | "loading">>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const abortersRef = useRef<Record<string, AbortController>>({});



  const doPrefetch = useCallback(async (t: TorrentRow) => {
    const k = keyFor(t);
    if (!k || prefetchMap[k]) return; // already loading or done

    const ctrl = new AbortController();
    abortersRef.current[k] = ctrl;
    setPrefetchMap((m) => ({ ...m, [k]: "loading" }));

    try {
      const url = buildPrefetchUrl(t, cat);
      const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as PrefetchResult;
      setPrefetchMap((m) => ({ ...m, [k]: data }));
    } catch {
      // clear on failure
      setPrefetchMap((m) => {
        const { [k]: _, ...rest } = m;
        return rest;
      });
    } finally {
      delete abortersRef.current[k];
    }
  }, [prefetchMap, cat]);

  const handleEnterRow = (t: TorrentRow) => {
    const k = keyFor(t);
    if (!k || timersRef.current[k]) return;
    timersRef.current[k] = setTimeout(() => {
      delete timersRef.current[k];
      void doPrefetch(t);
    }, PREFETCH_DELAY_MS);
  };

  const handleLeaveRow = (t: TorrentRow) => {
    const k = keyFor(t);
    const timer = timersRef.current[k];
    if (timer) {
      clearTimeout(timer);
      delete timersRef.current[k];
    }
    const ac = abortersRef.current[k];
    if (ac) {
      ac.abort();
      delete abortersRef.current[k];
    }
  };

  const filtered = useMemo(() => {
    const list = torrents ?? [];
    const allowed = new Set<Quality>([
      ...(q2160 ? (present.includes("2160p") ? ["2160p"] as const : []) : []),
      ...(q1080 ? (present.includes("1080p") ? ["1080p"] as const : []) : []),
      ...(q720 ? (present.includes("720p") ? ["720p"] as const : []) : []),
      ...(qOther ? (present.includes("other") ? ["other"] as const : []) : []),
    ]);
    // If user unticked all visible, fall back to "all present" so we don't show empty accidentally
    const effectiveAllowed = allowed.size ? allowed : new Set<Quality>(present as Quality[]);

    return list
      .filter(t => effectiveAllowed.has(qualityFromTitle(t.title)))
      // sort by quality rank desc, then by seeders desc, then size desc as a tiebreaker
      .sort((a, b) => {
        const qa = qualityRank(qualityFromTitle(a.title));
        const qb = qualityRank(qualityFromTitle(b.title));
        if (qa !== qb) return qb - qa;
        const sa = a.seeders ?? 0, sb = b.seeders ?? 0;
        if (sa !== sb) return sb - sa;
        const za = a.size ?? 0, zb = b.size ?? 0;
        return zb - za;
      });
  }, [torrents, present, q2160, q1080, q720, qOther]);

  const showFilterRow = present.length > 1 && (torrents?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* wider + roomier */}
      <DialogContent className="min-w-7xl max-h-[88vh] overflow-hidden
                                border-slate-800 bg-[#0B0F14] p-0 text-slate-200">
        <DialogTitle className="sr-only">Choose a stream</DialogTitle>

        {/* Header */}
        <div className="relative h-44 bg-[#0F141A]">
          {movie.backdropUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={movie.backdropUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-transparent" />
          <div className="absolute inset-0 flex items-end gap-4 px-6 pb-4">
            {movie.posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={movie.posterUrl} alt="" className="h-24 w-16 rounded-lg border border-slate-800 object-cover shadow" />
            ) : null}
            <div className="min-w-0">
              <div className="truncate text-xl md:text-2xl font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
                {movie.title} {movie.year ? <span className="font-normal text-slate-300">({movie.year})</span> : null}
              </div>
              <div className="mt-1 text-xs text-slate-400">Pick a stream from TorrentGalaxy / RARBG (IMDb-matched)</div>
            </div>
          </div>
        </div>

        {/* Controls + Table */}
        <div className="p-5">
          {/* Quality filter chips (only show chips that exist; hide row if only one quality) */}
          {showFilterRow && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-400">Quality</span>

              {present.includes("2160p") && (
                <Button
                  size="sm"
                  variant={q2160 ? "default" : "outline"}
                  className="h-7 rounded-md"
                  onClick={() => setQ2160(v => !v)}
                  title={`${counts["2160p"]} results`}
                >
                  2160p
                </Button>
              )}

              {present.includes("1080p") && (
                <Button
                  size="sm"
                  variant={q1080 ? "default" : "outline"}
                  className="h-7 rounded-md"
                  onClick={() => setQ1080(v => !v)}
                  title={`${counts["1080p"]} results`}
                >
                  1080p
                </Button>
              )}

              {present.includes("720p") && (
                <Button
                  size="sm"
                  variant={q720 ? "default" : "outline"}
                  className="h-7 rounded-md"
                  onClick={() => setQ720(v => !v)}
                  title={`${counts["720p"]} results`}
                >
                  720p
                </Button>
              )}

              {present.includes("other") && (
                <Button
                  size="sm"
                  variant={qOther ? "default" : "outline"}
                  className="h-7 rounded-md"
                  onClick={() => setQOther(v => !v)}
                  title={`${counts["other"]} results`}
                >
                  Other
                </Button>
              )}
            </div>
          )}

          {loading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Fetching streams…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-slate-800 p-4 text-sm text-red-300">{error}</div>
          ) : !filtered.length ? (
            <div className="rounded-xl border border-slate-800 p-4 text-sm text-slate-400">No torrents found.</div>
          ) : (
            <div className="overflow-auto max-h-[56vh] rounded-xl border border-slate-800">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0B0F14] text-left">
                  <tr className="border-b border-slate-800">
                    <th className="py-2 pl-3 pr-2 w-[1%]"></th>
                    <th className="py-2 pr-2 w-[50%]">Title</th>
                    <th className="py-2 pr-2 w-[12%]">Size</th>
                    <th className="py-2 pr-2 w-[10%]">Seeds</th>
                    <th className="py-2 pr-2 w-[10%]">Leeches</th>
                    <th className="py-2 pr-3 w-[17%]">Indexer</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t, i) => {
                    const k = keyFor(t);
                    const pf = (k && prefetchMap[k]) || null;
                    const isLoading = pf === "loading";
                    const isReady = !!pf && pf !== "loading";

                    return (
                      <tr key={`${t.infoHash ?? t.title}-${i}`} className="border-b border-slate-800 hover:bg-slate-800/20"
                        onMouseEnter={() => handleEnterRow(t)}
                        onMouseLeave={() => handleLeaveRow(t)}>
                        <td className="py-2 pl-3 pr-2">
                          <div className="flex items-center gap-2">
                            {/* Play */}
                            <Button
                              size="sm"
                              className="h-8 w-8 p-0 rounded-lg bg-cyan-500 text-black hover:bg-cyan-400"
                              onClick={() => {
                                // opportunistic prefetch if not already done
                                const k = keyFor(t);
                                if (k && !prefetchMap[k]) void doPrefetch(t);

                                const pf = k ? prefetchMap[k] : undefined;
                                const idx = pf && pf !== "loading" ? pf.fileIndex : undefined;
                                onPlay(t, idx);
                              }}
                              aria-label={`Play ${t.title || ""}`}
                            >
                              <Play className="h-4 w-4" />
                            </Button>

                            {/* Download .m3u for VLC */}
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-8 w-8 p-0 rounded-lg"
                              title="Download .m3u for VLC"
                              aria-label="Download .m3u"
                              onClick={() => {
                                const k = keyFor(t);
                                const pf = k ? prefetchMap[k] : undefined;
                                const idx = pf && pf !== "loading" ? pf.fileIndex : undefined;
                                const url = streamUrlFor(t, cat, idx);
                                downloadM3U(t.title || "Stream", url);
                              }}
                            >
                              <FileDown className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                        <td className="py-2 pr-2">
                          <div className="flex items-start gap-2">
                            <QualityBadge title={t.title} />
                            <span className="text-slate-300 break-words">{t.title}</span>
                            {isLoading ? (
                              <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                                warming…
                              </span>
                            ) : isReady ? (
                              <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-300 border border-green-500/30">
                                prefetched
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-2 pr-2">{formatSize(t.size)}</td>
                        <td className="py-2 pr-2">{t.seeders ?? "-"}</td>
                        <td className="py-2 pr-2">{t.leechers ?? "-"}</td>
                        <td className="py-2 pr-3">{t.indexer}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}