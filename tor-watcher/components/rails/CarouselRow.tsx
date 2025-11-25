"use client";

import * as React from "react";
import Link from "next/link";
import PosterCard from "@/components/movies/poster-card";
import type { MovieCard } from "@/lib/types";

type Props = {
  title: string;
  subtitle?: string;
  items: MovieCard[];
  loading?: boolean;
  onOpen: (id: number) => void;
  onPrefetch?: (id: number) => void;
  /** Limit how many cards appear in the rail (default 10). */
  maxItems?: number;
  /** Route to the See All page, e.g. `/see-all?title=...&api=...` */
  seeAllHref?: string;
  accent?: "cyan" | "purple" | "rose";
};

export default function CarouselRow({
  title,
  subtitle,
  items,
  loading,
  onOpen,
  onPrefetch,
  maxItems = 10,
  seeAllHref,
  accent = "cyan",
}: Props) {
  const visible = React.useMemo(
    () => items.slice(0, maxItems),
    [items, maxItems]
  );

  const accentBg: Record<"cyan" | "purple" | "rose", string> = {
    cyan: "bg-gradient-to-br from-[#031b2a] via-[#050d18] to-[#05070f]",
    purple: "bg-gradient-to-br from-[#1b0f2e] via-[#0f0a1f] to-[#04050a]",
    rose: "bg-gradient-to-br from-[#2b0f19] via-[#13060c] to-[#050407]",
  } as const;

  return (
    <section className={`rounded-3xl border border-white/10 ${accentBg[accent]} p-5 md:p-7 shadow-2xl shadow-black/30`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Spotlight</p>
          <h2 className="text-2xl font-semibold text-white">{title}</h2>
          {subtitle ? <p className="text-sm text-slate-300">{subtitle}</p> : null}
        </div>
        {seeAllHref ? (
          <Link
            href={seeAllHref}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/10"
          >
            See all
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="translate-x-[1px]"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </Link>
        ) : null}
      </div>

      {loading ? (
        <RailSkeleton />
      ) : (
        <ul className="grid gap-4 sm:gap-5 grid-cols-[repeat(auto-fill,minmax(168px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(196px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {visible.map((m) => (
            <li key={m.id}>
              <PosterCard movie={m} onOpen={onOpen} onPrefetch={onPrefetch} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RailSkeleton() {
  return (
    <ul className="grid gap-4 sm:gap-5 grid-cols-[repeat(auto-fill,minmax(168px,1fr))] md:grid-cols-[repeat(auto-fill,minmax(196px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
      {Array.from({ length: 10 }).map((_, i) => (
        <li key={i} className="aspect-[2/3] rounded-2xl bg-slate-800/40 animate-pulse" />
      ))}
    </ul>
  );
}
