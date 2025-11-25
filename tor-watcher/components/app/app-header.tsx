"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import GlobalSearch from "@/components/search/global-search";
import { Search, Sparkles } from "lucide-react";

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

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#03060c]/70 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
        <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold text-white">
          <span className="rounded-full bg-cyan-500/20 p-1 text-cyan-300">
            <Sparkles className="h-4 w-4" />
          </span>
          MovieWatcher
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <GlobalSearch>
            <>
              <button
                id="global-command-trigger"
                type="button"
                aria-haspopup="dialog"
                className="hidden w-80 items-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-3 py-2 text-left text-sm text-slate-200 shadow-inner shadow-white/5 ring-1 ring-white/10 transition hover:border-cyan-500/50 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500 md:flex"
              >
                <Search className="h-4 w-4 opacity-70" />
                <span className="text-slate-400">Search movies, shows, people…</span>
                <kbd className="ml-auto rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-200">⌘K</kbd>
              </button>

              <Button
                type="button"
                aria-label="Open search"
                className="rounded-2xl bg-white/5 text-white ring-1 ring-white/10 md:hidden"
                variant="secondary"
              >
                <Search className="h-4 w-4" />
              </Button>
            </>
          </GlobalSearch>
        </div>
      </div>
    </header>
  );
}