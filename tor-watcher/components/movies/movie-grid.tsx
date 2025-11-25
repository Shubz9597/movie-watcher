"use client";

import { useEffect } from "react";
import PosterCard from "./poster-card";
import type { MovieCard } from "@/lib/types";

export default function MovieGrid({
  items,
  onOpen,
  onPrefetch,
}: {
  items: MovieCard[];
  onOpen: (id: number) => void;
  onPrefetch?: (id: number) => void;
}) {
  useEffect(() => {
    const onOpenMovie = (e: Event) => {
      const ce = e as CustomEvent<{ id: number }>;
      const id = ce.detail?.id;
      if (typeof id === "number") onOpen(id);
    };
    window.addEventListener("open-movie", onOpenMovie as EventListener);
    return () => window.removeEventListener("open-movie", onOpenMovie as EventListener);
  }, [onOpen]);

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4 sm:gap-5 md:gap-6">
        {items.map((m) => (
          <PosterCard key={m.id} movie={m} onOpen={onOpen} onPrefetch={onPrefetch} />
        ))}
      </div>
    </>
  );
}