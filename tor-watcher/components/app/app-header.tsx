"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import GlobalSearch from "@/components/search/global-search";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Kind } from "@/app/page";

export default function AppHeader() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        document.getElementById("global-command-trigger")?.dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tiny URL-kind switcher in header (optional quick access)
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const kind = (sp.get("kind") as Kind) || "movie";

  function setKind(k: Kind) {
    const next = new URLSearchParams(Array.from(sp.entries()));
    next.set("kind", k);
    next.set("page", "1");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const pill = (k: Kind, label: string) => (
    <button
      key={k}
      onClick={() => setKind(k)}
      className={[
        "rounded-lg px-2.5 py-1 text-xs",
        k === kind ? "bg-cyan-600/20 text-cyan-200 ring-1 ring-cyan-500/40" : "bg-[#0F141A] text-slate-300 ring-1 ring-slate-800 hover:bg-slate-800/40",
      ].join(" ")}
    >
      {label}
    </button>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-[#0B0F14]/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        <Link href="/" className="font-semibold tracking-tight">🎬 MovieWatcher</Link>

        <div className="ml-3 hidden md:flex items-center gap-1">
          {pill("movie", "Movies")}
          {pill("tv", "TV")}
          {pill("anime", "Anime")}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <GlobalSearch>
            <>
              {/* Fancy pill (desktop) */}
              <button
                id="global-command-trigger"
                type="button"
                aria-haspopup="dialog"
                className="hidden md:flex items-center gap-2 rounded-xl border border-slate-800 bg-[#0F141A]/80 px-3 py-2 text-left text-sm text-slate-300 ring-1 ring-slate-800 transition hover:border-cyan-600/40 hover:bg-[#0F141A] focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                <Search className="h-4 w-4 opacity-70" />
                <span className="text-slate-400">Search movies, people…</span>
                <kbd className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">⌘K</kbd>
              </button>

              {/* Compact icon (mobile) */}
              <Button type="button" aria-label="Open search" className="md:hidden rounded-xl bg-[#0F141A] ring-1 ring-slate-800" variant="secondary">
                <Search className="h-4 w-4" />
              </Button>
            </>
          </GlobalSearch>

          <Button variant="secondary" className="rounded-xl bg-[#0F141A] ring-1 ring-slate-800">Settings</Button>
        </div>
      </div>
    </header>
  );
}