"use client";

import { useEffect, useRef } from "react";
import PosterCard from "./poster-card";
import type { MovieCard } from "@/lib/types";

export default function MovieGrid({
  items,
  onOpen,
  onPrefetch,
  loadMore = () => {},
  hasMore = false,
}: {
  items: MovieCard[];
  onOpen: (id: number) => void;
  onPrefetch?: (id: number) => void;
  loadMore?: () => void | Promise<void>;
  hasMore?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!sentinel.current || !hasMore) return;

    const el = sentinel.current;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach(async (e) => {
          if (!e.isIntersecting) return;
          if (pendingRef.current) return;

          pendingRef.current = true;
          try {
            const maybePromise = loadMore();
            if (maybePromise && typeof (maybePromise as any).then === "function") {
              await (maybePromise as Promise<void>);
            }
          } finally {
            // Give the grid a tick to render new items before retriggering
            setTimeout(() => {
              pendingRef.current = false;
            }, 100);
          }
        });
      },
      { rootMargin: "1000px" }
    );

    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  useEffect(() => {
    const onOpenMovie = (e: any) => onOpen(e.detail.id);
    window.addEventListener("open-movie", onOpenMovie as any);
    return () => window.removeEventListener("open-movie", onOpenMovie as any);
  }, [onOpen]);

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((m) => (
          <PosterCard key={m.id} movie={m} onOpen={onOpen} onPrefetch={onPrefetch} />
        ))}
      </div>
      {hasMore && <div ref={sentinel} className="h-10" />}
    </>
  );
}