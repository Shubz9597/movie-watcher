"use client";

import { useEffect, useRef } from "react";
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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((m) => (
          <PosterCard key={m.id} movie={m} onOpen={onOpen} onPrefetch={onPrefetch} />
        ))}
      </div>
    </>
  );
}