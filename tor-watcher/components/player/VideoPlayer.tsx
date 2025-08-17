"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX, Captions, SkipBack, SkipForward } from "lucide-react";

type Subtrack = { label: string; lang: string; url: string; source: "torrent" | "opensub" };
type Props = {
  magnet: string;
  title: string;
  year?: number;
  imdbId?: string;              // for OpenSubtitles fallback
  fileIndex?: number;           // if you allow picking a specific file
  preferLangs?: string[];       // e.g., ["hi","en"]
};

const SEEK_SMALL = 5;
const SEEK_LARGE = 10;

export default function VideoPlayer({ magnet, title, year, imdbId, fileIndex, preferLangs = ["hi", "en"] }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [subs, setSubs] = useState<Subtrack[]>([]);
  const [activeSub, setActiveSub] = useState<string>(""); // url
  const [tapHint, setTapHint] = useState<"left" | "right" | null>(null);

  const streamUrl = useMemo(() => {
    const base = `/api/stream?magnet=${encodeURIComponent(magnet)}`;
    return fileIndex != null ? `${base}&fileIndex=${fileIndex}` : base;
  }, [magnet, fileIndex]);

  // Load subtitles from torrent, then fall back to OpenSubtitles
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/subtitles?magnet=${encodeURIComponent(magnet)}`);
        const j = await res.json();
        const list: Subtrack[] = j.subtitles || [];
        if (!cancelled && list.length) {
          setSubs(list);
          const pick = preferLangs.map(l => list.find(s => s.lang === l)).find(Boolean) || list[0];
          setActiveSub(pick?.url || "");
          return;
        }

        if (imdbId) {
          const res2 = await fetch(`/api/subtitles/opensub?imdbId=${encodeURIComponent(imdbId)}&langs=${preferLangs.join(",")}`);
          if (res2.ok) {
            const j2 = await res2.json();
            const list2: Subtrack[] = j2.subtitles || [];
            if (!cancelled && list2.length) {
              setSubs(list2);
              const pick2 = preferLangs.map(l => list2.find(s => s.lang === l)).find(Boolean) || list2[0];
              setActiveSub(pick2?.url || "");
            }
          }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [magnet, imdbId, preferLangs]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "arrowleft":
          e.preventDefault();
          seekBy(-SEEK_SMALL);
          break;
        case "arrowright":
          e.preventDefault();
          seekBy(SEEK_SMALL);
          break;
        case "j":
          e.preventDefault();
          seekBy(-SEEK_LARGE);
          break;
        case "l":
          e.preventDefault();
          seekBy(SEEK_LARGE);
          break;
        case "m":
          e.preventDefault();
          v.muted = !v.muted; setMuted(v.muted);
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "escape":
          if (document.fullscreenElement) document.exitFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  };

  const seekBy = (sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + sec), duration || v.duration || 0);
    setTime(v.currentTime);
    setTapHint(sec > 0 ? "right" : "left");
    setTimeout(() => setTapHint(null), 300);
  };

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      await el.requestFullscreen();
      setFs(true);
    } else {
      await document.exitFullscreen();
      setFs(false);
    }
  };

  const onDoubleTap = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width / 2) seekBy(-SEEK_LARGE);
    else seekBy(SEEK_LARGE);
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    for (const t of Array.from(v.textTracks)) t.mode = "disabled";
  }, [activeSub]);

  return (
    <div ref={containerRef} className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-xl">
      {/* Title bar */}
      <div className="absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/70 to-transparent p-4 flex items-center justify-between">
        <div className="text-white">
          <div className="text-lg font-semibold">{title}</div>
          {year ? <div className="text-xs opacity-80">{year}</div> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="icon" onClick={toggleFullscreen} className="rounded-xl">
            {fs ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Video */}
      <video
        ref={videoRef}
        className="w-full h-full"
        src={streamUrl}
        controls={false}
        preload="metadata"
        onLoadedMetadata={e => setDuration((e.target as HTMLVideoElement).duration || 0)}
        onTimeUpdate={e => setTime((e.target as HTMLVideoElement).currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={togglePlay}
      >
        {activeSub ? <track key={activeSub} src={activeSub} kind="subtitles" srcLang="en" label="Subtitles" default /> : null}
      </video>

      {/* Double-tap overlay */}
      <div className="absolute inset-0 z-10" onDoubleClick={onDoubleTap} />

      {/* Tap hint */}
      {tapHint ? (
        <div className={`absolute top-1/2 -translate-y-1/2 z-20 ${tapHint === "left" ? "left-6" : "right-6"} bg-black/60 text-white px-3 py-2 rounded-xl text-sm`}>
          {tapHint === "left" ? "⏪ -10s" : "⏩ +10s"}
        </div>
      ) : null}

      {/* Controls */}
      <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/80 to-transparent p-4">
        <div className="flex items-center gap-3">
          <Button size="icon" variant="secondary" className="rounded-xl" onClick={() => seekBy(-SEEK_LARGE)}><SkipBack className="h-5 w-5" /></Button>
          <Button size="icon" variant="secondary" className="rounded-xl" onClick={togglePlay}>{playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}</Button>
          <Button size="icon" variant="secondary" className="rounded-xl" onClick={() => seekBy(SEEK_LARGE)}><SkipForward className="h-5 w-5" /></Button>

          <div className="text-white text-xs tabular-nums ml-2">
            {formatTime(time)} / {formatTime(duration)}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button size="icon" variant="secondary" className="rounded-xl" onClick={() => {
              const v = videoRef.current; if (!v) return;
              v.muted = !v.muted; setMuted(v.muted);
            }}>
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </Button>

            <div className="relative">
              <Button size="icon" variant="secondary" className="rounded-xl"><Captions className="h-5 w-5" /></Button>
              <div className="absolute right-0 bottom-12 bg-black/80 text-white rounded-xl p-2 min-w-40 space-y-1">
                <button className={`w-full text-left px-2 py-1 rounded ${!activeSub ? "bg-white/10" : "hover:bg-white/10"}`} onClick={() => setActiveSub("")}>Off</button>
                {subs.map(s => (
                  <button key={s.url} className={`w-full text-left px-2 py-1 rounded ${activeSub === s.url ? "bg-white/10" : "hover:bg-white/10"}`} onClick={() => setActiveSub(s.url)}>
                    {flag(s.lang)} {s.label}
                  </button>
                ))}
              </div>
            </div>

            <Button size="icon" variant="secondary" className="rounded-xl" onClick={toggleFullscreen}>
              {fs ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        <input
          className="w-full mt-2 accent-white"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          onChange={e => {
            const v = videoRef.current; if (!v) return;
            const t = Number(e.target.value);
            v.currentTime = t; setTime(t);
          }}
        />
      </div>
    </div>
  );
}

function formatTime(s: number) {
  if (!isFinite(s)) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function flag(lang: string) {
  switch (lang) {
    case "hi": return "🇮🇳";
    case "en": return "🇬🇧";
    case "fr": return "🇫🇷";
    case "es": return "🇪🇸";
    default: return "🌐";
  }
}