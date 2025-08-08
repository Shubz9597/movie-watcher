"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import type { Filters } from "@/lib/types";
import * as React from "react";

const GENRES = [
  { id: 0, name: "All Genres" },
  { id: 28, name: "Action" },
  { id: 12, name: "Adventure" },
  { id: 878, name: "Sci-Fi" },
  { id: 35, name: "Comedy" },
  { id: 18, name: "Drama" },
];

const MIN_YEAR = 1970;
const CURRENT_YEAR = new Date().getFullYear();

const PRESETS: Record<string, [number, number]> = {
  any: [MIN_YEAR, CURRENT_YEAR],
  "2020s": [2020, CURRENT_YEAR],
  "2010s": [2010, 2019],
  "2000s": [2000, 2009],
  "1990s": [1990, 1999],
  "1980s": [1980, 1989],
};

function matchPreset(r: [number, number]) {
  for (const [label, yrs] of Object.entries(PRESETS)) {
    if (yrs[0] === r[0] && yrs[1] === r[1]) return label;
  }
  return null;
}

export default function FilterBar({
  value,
  onChange,
  onApply,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
   onApply?: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [pendingRange, setPendingRange] = React.useState<[number, number]>(value.yearRange);
  const presetFromValue = matchPreset(value.yearRange) ?? "custom";

  React.useEffect(() => {
    setPendingRange(value.yearRange);
  }, [value.yearRange]);


  function update(partial: Partial<Filters>) {
    onChange({ ...value, ...partial });
  }

  function applyPreset(label: string) {
    const next = PRESETS[label as keyof typeof PRESETS];
    if (next) update({ yearRange: next as [number, number] });
  }

  function applyPending() {
    update({ yearRange: pendingRange });
    onApply?.();            // <-- tell parent to fetch immediately (skip debounce once)
    setAdvancedOpen(false); // close popover
  } 

  return (
    <section className="flex flex-wrap items-center gap-3">
      {/* Genre */}
      <Select value={`${value.genreId}`} onValueChange={(v) => update({ genreId: Number(v) })}>
        <SelectTrigger className="w-[160px] rounded-xl bg-[#0F141A]">
          <SelectValue placeholder="Genres" />
        </SelectTrigger>
        <SelectContent>
          {GENRES.map((g) => (
            <SelectItem key={g.id} value={`${g.id}`}>{g.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Sort */}
      <Select value={value.sort} onValueChange={(v) => update({ sort: v as Filters["sort"] })}>
        <SelectTrigger className="w-[160px] rounded-xl bg-[#0F141A]">
          <SelectValue placeholder="Sort" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="trending">Trending</SelectItem>
          <SelectItem value="rating">Rating</SelectItem>
          <SelectItem value="year">Year</SelectItem>
          <SelectItem value="popularity">Popularity</SelectItem>
        </SelectContent>
      </Select>

      {/* Year quick + advanced */}
      <div className="flex items-center gap-2">
        <Label className="text-sm text-slate-300">Year</Label>

        {/* Quick presets (decades) */}
        <Select value={presetFromValue} onValueChange={applyPreset}>
          <SelectTrigger className="w-[120px] rounded-xl bg-[#0F141A]">
            <SelectValue placeholder="Quick" />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(PRESETS).map((label) => (
              <SelectItem key={label} value={label}>
                {label === "any" ? "Any time" : label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Advanced popover */}
      <Popover open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="rounded-xl">Advanced</Button>
        </PopoverTrigger>
        <PopoverContent className="w-[22rem] p-4 overflow-hidden" align="start">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Custom range</div>
              <Badge variant="secondary" className="text-xs">
                {pendingRange[0]}–{pendingRange[1]}
              </Badge>
            </div>

            <Slider
              min={MIN_YEAR}
              max={CURRENT_YEAR}
              step={1}
              value={pendingRange}
              onValueChange={(vals) => {
                const [a, b] = vals as number[];
                setPendingRange([Math.min(a, b), Math.max(a, b)]);
              }}
            />

            {/* Nudge row */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="icon"
                  onClick={() => setPendingRange(([s, e]) => [Math.max(s - 1, MIN_YEAR), e])}>–</Button>
                <span className="w-16 text-center text-sm">{pendingRange[0]}</span>
                <Button variant="secondary" size="icon"
                  onClick={() => setPendingRange(([s, e]) => [Math.min(s + 1, e), e])}>+</Button>
              </div>
              <div className="text-xs text-muted-foreground">to</div>
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="icon"
                  onClick={() => setPendingRange(([s, e]) => [s, Math.max(e - 1, s)])}>–</Button>
                <span className="w-16 text-center text-sm">{pendingRange[1]}</span>
                <Button variant="secondary" size="icon"
                  onClick={() => setPendingRange(([s, e]) => [s, Math.min(e + 1, CURRENT_YEAR)])}>+</Button>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setPendingRange([MIN_YEAR, CURRENT_YEAR])}>
                Reset
              </Button>
              <Button size="sm" onClick={applyPending}>Apply</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

        {/* Compact live readout (always visible) */}
        <span className="text-xs text-slate-400">{value.yearRange[0]}–{value.yearRange[1]}</span>
      </div>

      {/* Torrent toggle */}
      <div className="ml-1 flex items-center gap-2">
        <Switch checked={value.torrentOnly} onCheckedChange={(v) => update({ torrentOnly: v })} />
        <Label className="text-sm text-slate-300">Only with torrents</Label>
      </div>

      {/* Quick text filter */}
      <div className="ml-auto">
        <input
          value={value.query}
          onChange={(e) => update({ query: e.target.value })}
          placeholder="Quick filter…"
          className="rounded-xl bg-[#0F141A] px-3 py-2 text-sm ring-1 ring-slate-800 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
        />
      </div>
    </section>
  );
}