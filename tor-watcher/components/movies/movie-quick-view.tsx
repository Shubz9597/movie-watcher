"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/lib/hooks/use-is-mobile";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Play, PlayCircle, Loader2, ArrowRight, Star, Flame } from "lucide-react";
import TorrentListDialog, { type TorrentRow } from "../torrentListModal/torrentListDialog";

/* ---------- types ---------- */
type QuickData = {
  id?: number;
  tmdbId?: number;
  title: string;
  year?: number;
  // legacy TMDB average (0..10); kept for fallback
  rating?: number;
  overview?: string;
  backdropUrl?: string | null;
  posterUrl?: string | null;
  genres?: string[];
  runtime?: number | null;
  cast?: { name: string; character?: string }[];
  trailerKey?: string | null;

  // identifiers
  imdbId?: string;

  // NEW: enriched from /api/tmdb/movie/[id]
  originalLanguage?: string;
  tmdbPopularity?: number | null;
  tmdbRatingPct?: number | null; // prefer this if server provides it
  imdbRating?: number | null;    // 0..10
  imdbVotes?: number | null;
};

export default function MovieQuickView({
  open,
  onOpenChange,
  data,
  loading = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: QuickData | null;
  loading?: boolean;
}) {
  const isMobile = useIsMobile();
  const router = useRouter();

  const tmdb = data?.tmdbId ?? data?.id;

  const [showTorrents, setShowTorrents] = useState(false);
  const [torrents, setTorrents] = useState<TorrentRow[] | null>(null);
  const [tLoading, setTLoading] = useState(false);
  const [tError, setTError] = useState<string | null>(null);
  const [resolvedImdbId, setResolvedImdbId] = useState<string | undefined>();
  const [resolvingImdb, setResolvingImdb] = useState(false);
  const [origLangState, setOrigLangState] = useState<string | undefined>();

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onOpenChange]);

  // Reset torrent state when the quick view closes
  useEffect(() => {
    if (!open) {
      setShowTorrents(false);
      setTorrents(null);
      setTError(null);
      setTLoading(false);
    }
  }, [open]);

  async function ensureImdbId() {
    if (data?.imdbId) return data.imdbId;
    if (!tmdb) return undefined;
    if (resolvedImdbId) return resolvedImdbId;

    setResolvingImdb(true);
    try {
      // Our detail route returns imdbId + originalLanguage + popularity + imdbRating if available
      const res = await fetch(`/api/tmdb/movie/${tmdb}`, { cache: "force-cache" });
      const detail = await res.json();
      if (detail?.imdbId) {
        setResolvedImdbId(detail.imdbId);
      }
      if (detail?.originalLanguage && !origLangState) {
        setOrigLangState(detail.originalLanguage);
      }
      return detail?.imdbId as string | undefined;
    } catch {
      // ignore; we can still try by title/year
      return undefined;
    } finally {
      setResolvingImdb(false);
    }
  }

  async function loadTorrents() {
    if (!data?.title) return;

    // open the dialog immediately
    setShowTorrents(true);
    setTLoading(true);
    setTError(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const imdbId = await ensureImdbId().catch(() => null);

      const params = new URLSearchParams();
      if (imdbId) {
        params.set("imdbId", imdbId);
      } else {
        params.set("title", data.title);
        if (data.year) params.set("year", String(data.year));
      }
      const langForSearch = data?.originalLanguage ?? origLangState;
      if (langForSearch) params.set("origLang", langForSearch);

      // queries TGxClone + RARBG only (our movies endpoint)
      const res = await fetch(`/api/torrents/movie?${params.toString()}`, {
        method: "GET",
        signal: controller.signal,
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Request failed with ${res.status}`);

      const items = (json?.results ?? []) as any[];

      // API → dialog rows
      const mapped: TorrentRow[] = items.map((it) => ({
        title: it.title,
        size: it.size ?? it.sizeBytes,
        seeders: it.seeders,
        leechers: it.leechers,
        magnetUri: it.magnetUri || it.magnet,
        torrentUrl: it.torrentUrl || it.downloadUrl,
        infoHash: it.infoHash,
        indexer: it.indexer || "-",
        publishDate: it.publishDate,
      }));

      setTorrents(mapped);
    } catch (e: any) {
      setTorrents([]);
      setTError(
        e?.name === "AbortError"
          ? "Torrent search timed out. Please try again."
          : e?.message || "Something went wrong"
      );
    } finally {
      clearTimeout(timeout);
      setTLoading(false);
    }
  }

  function ImdbBadge({ value, votes }: { value: number; votes?: number | null }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-black/70 px-2 py-[3px]
                 text-[12px] text-white border border-white/10"
    >
      {/* IMDb wordmark block */}
      <span
        className="inline-flex h-[14px] items-center justify-center
                   rounded-[3px] bg-[#F5C518] px-1.5 text-[10px] font-extrabold
                   leading-none text-black shadow-sm"
        style={{ letterSpacing: ".2px" }}
      >
        IMDb
      </span>

      {/* Rating + votes */}
      <span className="tabular-nums">{value.toFixed(1)}</span>
      {typeof votes === "number" && (
        <span className="ml-0.5 text-[11px] text-slate-300 tabular-nums">
          ({votes.toLocaleString()} votes)
        </span>
      )}
    </span>
  );
}

  function playTorrent(t: TorrentRow) {
     const src = t.magnetUri || t.torrentUrl || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : "");
  if (!src) return;
  router.push(`/watch?src=${encodeURIComponent(src)}&title=${encodeURIComponent(data?.title ?? "")}${data?.year ? `&year=${data.year}` : ""}${data?.imdbId ? `&imdbId=${data.imdbId}` : ""}`);
  }

  // derive TMDB percent cleanly on the client if not provided
  const tmdbPct =
    typeof data?.tmdbRatingPct === "number"
      ? data.tmdbRatingPct
      : typeof data?.rating === "number"
        ? Math.round(data.rating * 10)
        : undefined;

  /* ---------------- Header ---------------- */
  const Header = (
    <div className="relative h-72 md:h-80 lg:h-96 bg-[#0F141A]">
      {data?.backdropUrl && !loading ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.backdropUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-60"
        />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-slate-800/30" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-transparent" />

      <div className="absolute bottom-4 left-6 right-6">
        {/* Title */}
        <div className="text-2xl md:text-3xl font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
          {data?.title ?? (loading ? "Loading…" : "")}{" "}
          {data?.year ? (
            <span className="font-normal text-slate-300 [text-shadow:0_1px_1px_rgba(0,0,0,.5)]">
              ({data.year})
            </span>
          ) : null}
        </div>

        {/* Meta chips: IMDb first, then TMDB %, then 🔥 popularity, then runtime/genres */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm md:text-base text-slate-200 [text-shadow:0_1px_1px_rgba(0,0,0,.5)]">
          {typeof data?.imdbRating === "number" && (
            <ImdbBadge value={data.imdbRating} votes={data?.imdbVotes} />
          )}

          {typeof tmdbPct === "number" && (
            <span className="inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-[2px] text-[12px]">
              🔥 {tmdbPct}%
            </span>
          )}

          {typeof data?.tmdbPopularity === "number" && (
            <span className="inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-[2px] text-[12px]">
              <Flame className="h-4 w-4" />
              {Math.round(data.tmdbPopularity)}
            </span>
          )}

          {data?.runtime ? (
            <span className="ml-1 text-slate-300">{data.runtime}m</span>
          ) : null}

          {data?.genres?.length ? (
            <span className="ml-1 text-slate-300">{data.genres.join(", ")}</span>
          ) : null}
        </div>

        {/* Trailer CTA */}
        {data?.trailerKey ? (
          <div className="mt-3">
            <Button
              asChild
              size="sm"
              className="group inline-flex items-center gap-2 rounded-lg 
                         bg-gradient-to-r from-cyan-500 to-blue-500 
                         px-3 py-1.5 text-xs font-medium text-white shadow
                         hover:from-cyan-400 hover:to-blue-400 
                         focus:outline-none focus:ring-2 focus:ring-cyan-400/60 active:scale-[.98]"
            >
              <a
                href={`https://www.youtube.com/watch?v=${data.trailerKey}`}
                target="_blank"
                rel="noreferrer"
                aria-label="Watch trailer on YouTube"
              >
                <Play className="h-4 w-4 shrink-0 text-white" />
                Watch trailer
              </a>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );

  /* ---------------- Body (details only) ---------------- */
  const OverviewSection =
    !loading && data?.overview ? (
      <p className="text-sm md:text-base text-slate-300">{data.overview}</p>
    ) : loading ? (
      <div className="space-y-3 min-h-[5.5rem]">
        <div className="h-4 w-3/4 animate-pulse rounded bg-slate-800/40" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-slate-800/30" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800/20" />
      </div>
    ) : null;

  const InfoBody = (
    <div className="space-y-5 bg-[#0B0F14] p-5 md:p-6">
      {OverviewSection}

      {!loading && data?.cast?.length ? (
        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">Top cast</div>
          <ul
            className="grid gap-2 md:gap-3
                       [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]
                       md:[grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]
                       lg:[grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]"
          >
            {data.cast.slice(0, 12).map((c, i) => (
              <li
                key={`${c.name}-${i}`}
                className="rounded-xl border border-slate-800 bg-[#0F141A] p-3"
              >
                <div className="text-sm font-medium text-slate-200 break-words">
                  {c.name}
                </div>
                {c.character ? (
                  <div className="mt-0.5 text-xs text-slate-400 break-words">
                    as {c.character}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Watch Now — opens torrent dialog */}
      <div className="pt-1">
        <Button
          onClick={loadTorrents}
          disabled={loading || tLoading || resolvingImdb}
          aria-label="Watch movie"
          title="Watch movie"
          className="group w-full rounded-xl 
               bg-gradient-to-br from-cyan-500 to-blue-600 
               text-white shadow-lg shadow-cyan-500/20 
               ring-1 ring-cyan-400/40 hover:ring-cyan-300/60
               hover:from-cyan-400 hover:to-blue-500
               py-3.5 text-base font-semibold
               transition active:scale-[.99] drop-shadow-[0_0_24px_rgba(34,211,238,0.25)]"
        >
          <span className="inline-flex items-center justify-center gap-2">
            {tLoading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Fetching streams…
              </>
            ) : (
              <>
                <PlayCircle className="h-5 w-5" />
                Watch Movie
                <ArrowRight className="h-5 w-5 opacity-70 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </span>
        </Button>
      </div>
    </div>
  );

  const Body = (
    <div className="overflow-hidden rounded-2xl ring-1 ring-slate-800">
      {Header}
      {InfoBody}
    </div>
  );

  // ===== Render =====
  if (isMobile) {
    return (
      <>
        <Sheet open={open && !showTorrents} onOpenChange={onOpenChange}>
          <SheetContent
            side="bottom"
            className="h-[85vh] overflow-y-auto border-slate-800 bg-[#0B0F14] p-0 text-slate-200 sm:max-w-full"
          >
            {Body}
          </SheetContent>
        </Sheet>

        {/* Torrent dialog lives OUTSIDE the sheet/dialog */}
        <TorrentListDialog
          open={showTorrents}
          onOpenChange={(v) => {
            setShowTorrents(v);
            if (!v) {
              setTorrents(null);
              setTError(null);
              setTLoading(false);
            }
          }}
          loading={tLoading}
          error={tError}
          movie={{
            title: data?.title ?? "",
            year: data?.year ?? undefined,
            posterUrl: data?.posterUrl ?? null,
            backdropUrl: data?.backdropUrl ?? null,
          }}
          torrents={torrents}
          onPlay={playTorrent}
        />
      </>
    );
  }

  return (
    <>
      <Dialog open={open && !showTorrents} onOpenChange={onOpenChange}>
        <DialogContent
          className="w-[96vw] max-w-7xl max-h-[85vh] overflow-y-auto
                     border-slate-800 bg-[#0B0F14] p-0 text-slate-200"
        >
          <DialogTitle className="sr-only">{data?.title ?? "Movie detail"}</DialogTitle>
          {Body}
        </DialogContent>
      </Dialog>

      {/* Torrent dialog lives OUTSIDE the quick view dialog */}
      <TorrentListDialog
        open={showTorrents}
        onOpenChange={(v) => {
          setShowTorrents(v);
          if (!v) {
            setTorrents(null);
            setTError(null);
            setTLoading(false);
          }
        }}
        loading={tLoading}
        error={tError}
        movie={{
          title: data?.title ?? "",
          year: data?.year ?? undefined,
          posterUrl: data?.posterUrl ?? null,
          backdropUrl: data?.backdropUrl ?? null,
        }}
        torrents={torrents}
        onPlay={playTorrent}
      />
    </>
  );
}