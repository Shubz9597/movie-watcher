"use client";

import * as React from "react";
import Link from "next/link";
import PosterCard from "@/components/movies/poster-card";
import type { MovieCard } from "@/lib/types";

type Props = {
  title: string;
  items: MovieCard[];
  loading?: boolean;
  onOpen: (id: number) => void;
  onPrefetch?: (id: number) => void;
  /** Limit how many cards appear in the rail (default 10). */
  maxItems?: number;
  /** Route to the See All page, e.g. `/see-all?title=...&api=...` */
  seeAllHref?: string;
};

export default function CarouselRow({
  title,
  items,
  loading,
  onOpen,
  onPrefetch,
  maxItems = 10,
  seeAllHref,
}: Props) {
  const visible = React.useMemo(
    () => items.slice(0, maxItems),
    [items, maxItems]
  );

  return (
    <section className="space-y-3 md:space-y-4">
      {/* Heading + See all */}
      <div className="mb-1.5 md:mb-2.5 flex items-baseline justify-between">
        <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-slate-100">
          {title}
        </h2>
        {seeAllHref ? (
          <Link
            href={seeAllHref}
            className="inline-flex items-center gap-1 text-sm md:text-base font-medium text-cyan-400 hover:text-cyan-300"
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

      {/* Grid rail (no horizontal scroll) */}
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
