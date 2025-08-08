"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Film, Search, Star } from "lucide-react";
import type { MovieCard } from "@/lib/types";

const MIN_CHARS = 2;
const DEBOUNCE_MS = 700;

export default function GlobalSearch({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debouncedQuery, setDebouncedQuery] = React.useState("");
  const [results, setResults] = React.useState<MovieCard[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Debounce input
  React.useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setDebouncedQuery("");
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    const t = setTimeout(() => setDebouncedQuery(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, query]);

  // Fetch when debouncedQuery changes
  React.useEffect(() => {
    const q = debouncedQuery;
    if (!open || q.length < MIN_CHARS) return;

    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const u = new URLSearchParams();
        u.set("page", "1");
        u.set("query", q);
        const res = await fetch(`/api/tmdb/movies?${u.toString()}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setResults((data.results ?? []).slice(0, 8));
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          setError(e?.message ?? "Search failed");
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [open, debouncedQuery]);

  // Enter = search now (skip debounce)
  function searchNow() {
    const q = query.trim();
    if (q.length >= MIN_CHARS) setDebouncedQuery(q);
  }

  return (
    <>
      <span onClick={() => setOpen(true)}>{children}</span>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setQuery("");
            setDebouncedQuery("");
            setResults([]);
            setLoading(false);
            setError(null);
          }
        }}
      >
        <DialogContent className="p-0 overflow-hidden">
          <DialogTitle className="sr-only">Global search</DialogTitle>
          {/* Use Command directly so we can disable built-in filtering */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search movies, people…"
              value={query}
              onValueChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === "Enter") searchNow();
              }}
            />
            <CommandList>
              <CommandEmpty>
                {error
                  ? `Error: ${error}`
                  : query.trim().length < MIN_CHARS
                  ? `Type at least ${MIN_CHARS} characters to search`
                  : loading
                  ? "Searching…"
                  : results.length === 0
                  ? "No results found."
                  : null}
              </CommandEmpty>

              {results.length > 0 && !loading && (
                <CommandGroup heading="Movies">
                  {results.map((m) => (
                    <CommandItem
                      key={m.id}
                      value={m.title} // value is fine; filtering is off
                      onSelect={() => {
                        setOpen(false);
                        window.dispatchEvent(
                          new CustomEvent("open-movie", { detail: { id: m.id } })
                        );
                      }}
                    >
                      <Film className="mr-2 size-4" />
                      <span className="flex-1">{m.title}</span>
                      <span className="text-xs text-slate-400">{m.year}</span>
                      {m.rating ? (
                        <span className="ml-2 text-xs text-slate-300">
                          ★ {m.rating.toFixed(1)}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem onSelect={() => setOpen(false)}>
                  <Search className="mr-2 size-4" /> Advanced search (coming soon)
                </CommandItem>
                <CommandItem onSelect={() => setOpen(false)}>
                  <Star className="mr-2 size-4" /> Open Watchlist
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}