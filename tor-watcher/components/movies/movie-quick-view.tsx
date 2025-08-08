"use client";

import { useEffect } from "react";
import { useIsMobile } from "@/lib/hooks/use-is-mobile";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play } from "lucide-react"; // ▶️ icon
import type { Torrent } from "@/lib/types";

type QuickData = {
  title: string;
  year?: number;
  rating?: number;
  overview?: string;
  backdropUrl?: string | null;
  posterUrl?: string | null;
  genres?: string[];
  runtime?: number | null;
  cast?: { name: string; character?: string }[];
  trailerKey?: string | null;
  torrents: Torrent[];
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

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onOpenChange]);

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
        {/* Title + Trailer CTA */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-2xl md:text-3xl font-semibold [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
            {data?.title ?? (loading ? "Loading…" : "")}{" "}
            {data?.year ? (
              <span className="font-normal text-slate-300 [text-shadow:0_1px_1px_rgba(0,0,0,.5)]">
                ({data.year})
              </span>
            ) : null}
          </div>

          {data?.trailerKey ? (
            <Button
              asChild
              className="group inline-flex items-center gap-2 rounded-lg 
               bg-gradient-to-r from-cyan-500 to-blue-500 
               px-3 py-1.5 text-xs md:text-sm font-medium text-white shadow
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
          ) : null}
        </div>

        {/* Meta */}
        <div className="mt-2 text-sm md:text-base text-slate-200 [text-shadow:0_1px_1px_rgba(0,0,0,.5)]">
          {typeof data?.rating === "number" ? `★ ${data.rating.toFixed(1)}` : null}
          {data?.runtime ? <span className="ml-3 text-slate-300">{data.runtime}m</span> : null}
          {data?.genres?.length ? (
            <span className="ml-3 text-slate-300">{data.genres.join(", ")}</span>
          ) : null}
        </div>
      </div>
    </div>
  );

  const Body = (
    <div className="overflow-hidden rounded-2xl ring-1 ring-slate-800">
      {Header}

      <div className="space-y-5 bg-[#0B0F14] p-5 md:p-6">
        {loading ? (
          <div className="space-y-3 min-h-[5.5rem]">
            <div className="h-4 w-3/4 animate-pulse rounded bg-slate-800/40" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-slate-800/30" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800/20" />
          </div>
        ) : (
          data?.overview && (
            <p className="text-sm md:text-base text-slate-300">{data.overview}</p>
          )
        )}

        {/* Top cast — boxes with full wrapping, wider on large screens */}
        {!loading && data?.cast?.length ? (
          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
              Top cast
            </div>
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

        {/* Torrents */}
        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
            Available torrents
          </div>
          <div className="flex flex-col gap-3">
            {data?.torrents?.length ? (
              data.torrents.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#0F141A] p-3 md:p-4"
                >
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2 text-sm md:text-base">
                      <Badge variant="secondary" className="bg-black/60">
                        {t.quality}
                      </Badge>
                      <span className="text-slate-300">{t.size}</span>
                      {t.audio && (
                        <span className="text-slate-400">• {t.audio}</span>
                      )}
                      {t.subs?.length ? (
                        <span className="text-slate-400">
                          • Subs: {t.subs.join(", ")}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs md:text-sm text-slate-500">
                      {t.source || "unknown"} • {t.seeds} seeds / {t.leeches} leech
                    </div>
                  </div>
                  <a href={t.magnet}>
                    <Button className="rounded-xl bg-cyan-500 text-black hover:bg-cyan-400">
                      Get magnet
                    </Button>
                  </a>
                </div>
              ))
            ) : loading ? (
              <div className="h-12 animate-pulse rounded-xl bg-slate-800/30" />
            ) : (
              <div className="rounded-xl border border-slate-800 p-4 text-sm text-slate-400">
                No torrents found.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="h-[85vh] overflow-y-auto border-slate-800 bg-[#0B0F14] p-0 text-slate-200 sm:max-w-full"
        >
          {Body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[96vw] max-w-7xl max-h-[85vh] overflow-y-auto
                   border-slate-800 bg-[#0B0F14] p-0 text-slate-200"
      >
        <DialogTitle className="sr-only">{data?.title ?? "Movie detail"}</DialogTitle>
        {Body}
      </DialogContent>
    </Dialog>
  );
}