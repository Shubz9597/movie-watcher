"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Maximize, Minimize, Pause, Play, Volume2, VolumeX,
  Captions, SkipBack, SkipForward, Loader2, AlertTriangle
} from "lucide-react";

type Subtrack = { label: string; lang: string; url: string; source: "torrent" | "opensub" };

type Props = {
  magnet: string;                 // required (we normalise to Go)
  title: string;
  year?: number;
  imdbId?: string;
  fileIndex?: number;
  preferLangs?: string[];         // e.g., ["hi","en"]
  cat?: "movie" | "tv" | "anime"; // for Go cache bucketing
};

const SEEK_SMALL = 5;
const SEEK_LARGE = 10;

// Toggle this if you prefer to hit your Next proxy (/api/stream) instead of Go directly.
const USE_PROXY = false;
const VOD = process.env.NEXT_PUBLIC_VOD_BASE ?? "http://localhost:4001";

export default function VideoPlayer({
  magnet,
  title,
  year,
  imdbId,
  fileIndex,
  preferLangs = ["hi", "en"],
  cat = "movie",
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);        // 0..1
  const [fs, setFs] = useState(false);

  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);

  const [subs, setSubs] = useState<Subtrack[]>([]);
  const [subsOpen, setSubsOpen] = useState(false);
  const [activeSub, setActiveSub] = useState<string>(""); // track URL

  const [loadingMeta, setLoadingMeta] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [uiVisible, setUiVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tapHint, setTapHint] = useState<"left" | "right" | null>(null);

  /* ---------------- Stream URL ---------------- */
  const streamUrl = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("cat", cat);
    sp.set("magnet", magnet);
    if (fileIndex != null) sp.set("fileIndex", String(fileIndex));

    if (USE_PROXY) {
      return `/api/stream?${sp.toString()}`;
    } else {
      return `${VOD.replace(/\/$/, "")}/stream?${sp.toString()}`;
    }
  }, [magnet, fileIndex, cat]);

  /* ---------------- Subtitles ---------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sp = new URLSearchParams({ magnet, cat });
        const res = await fetch(`/api/subtitles?${sp.toString()}`);
        const j = await res.json().catch(() => ({ subtitles: [] }));
        const list: Subtrack[] = j.subtitles || [];
        if (!cancelled && list.length) {
          setSubs(list);
          const pick =
            preferLangs.map(l => list.find(s => s.lang === l)).find(Boolean) ||
            list[0];
          setActiveSub(pick?.url || "");
          return;
        }

        // Optional: attempt OpenSubtitles fallback (your stub returns [] for now)
        if (imdbId) {
          const res2 = await fetch(`/api/subtitles/opensub?${new URLSearchParams({
            imdbId,
            langs: preferLangs.join(","),
          })}`);
          const j2 = await res2.json().catch(() => ({ subtitles: [] }));
          const list2: Subtrack[] = j2.subtitles || [];
          if (!cancelled && list2.length) {
            setSubs(list2);
            const pick2 =
              preferLangs.map(l => list2.find(s => s.lang === l)).find(Boolean) ||
              list2[0];
            setActiveSub(pick2?.url || "");
          }
        }
      } catch {
        // ignore; we'll just have no subtitles
      }
    })();
    return () => { cancelled = true; };
  }, [magnet, imdbId, preferLangs, cat]);

  /* ---------------- Auto-hide controls ---------------- */
  const showUI = () => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // Hide after 2.5s if playing
    if (playing) {
      hideTimer.current = setTimeout(() => setUiVisible(false), 2500);
    }
  };

  useEffect(() => {
    // reset timer when play state changes
    showUI();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  /* ---------------- Keyboard shortcuts ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k": e.preventDefault(); togglePlay(); break;
        case "arrowleft": e.preventDefault(); seekBy(-SEEK_SMALL); break;
        case "arrowright": e.preventDefault(); seekBy(SEEK_SMALL); break;
        case "j": e.preventDefault(); seekBy(-SEEK_LARGE); break;
        case "l": e.preventDefault(); seekBy(SEEK_LARGE); break;
        case "m": e.preventDefault(); setMuted(v.muted = !v.muted); break;
        case "f": e.preventDefault(); toggleFullscreen(); break;
        case "escape": if (document.fullscreenElement) document.exitFullscreen(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------------- Player helpers ---------------- */
  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  };

  const seekBy = (sec: number) => {
    const v = videoRef.current; if (!v) return;
    const d = duration || v.duration || 0;
    v.currentTime = Math.min(Math.max(0, v.currentTime + sec), d);
    setTime(v.currentTime);
    setTapHint(sec > 0 ? "right" : "left");
    setTimeout(() => setTapHint(null), 300);
    showUI();
  };

  const toggleFullscreen = async () => {
    const el = containerRef.current; if (!el) return;
    if (!document.fullscreenElement) {
      await el.requestFullscreen(); setFs(true);
    } else {
      await document.exitFullscreen(); setFs(false);
    }
  };

  const onDoubleTap = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width / 2) seekBy(-SEEK_LARGE); else seekBy(SEEK_LARGE);
  };

  /* ---------------- Video events (state) ---------------- */
  const onLoadStart = () => { setLoadingMeta(true); setErrorMsg(null); setBuffering(false); };
  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setDuration((e.target as HTMLVideoElement).duration || 0);
    setLoadingMeta(false);
  };
  const onWaiting = () => setBuffering(true);
  const onPlaying = () => { setBuffering(false); setErrorMsg(null); setPlaying(true); };
  const onStalled = () => setBuffering(true);
  const onError = () => {
    const v = videoRef.current;
    const code = v?.error?.code;
    const msg =
      code === 4 ? "The video format/codec isn’t supported by your browser." :
      code ? `Playback error (code ${code}).` :
      "Unknown playback error.";
    setErrorMsg(msg);
    setBuffering(false);
    setPlaying(false);
  };

  /* ---------------- Volume binding ---------------- */
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    v.volume = volume;
    if (volume === 0 && !v.muted) v.muted = true;
    if (volume > 0 && v.muted) v.muted = false;
    setMuted(v.muted);
  }, [volume]);

  /* ---------------- UI ---------------- */
  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl"
      onMouseMove={showUI}
      onTouchStart={showUI}
    >
      {/* Title bar */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/70 to-transparent
                    p-4 flex items-center justify-between transition-opacity duration-300
                    ${uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
      >
        <div className="text-white/95 drop-shadow">
          <div className="text-lg font-semibold">{title}</div>
          {year ? <div className="text-xs opacity-70">{year}</div> : null}
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
        preload="metadata"
        controls={false}
        onLoadStart={onLoadStart}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={e => setTime((e.target as HTMLVideoElement).currentTime || 0)}
        onPlay={onPlaying}
        onPause={() => setPlaying(false)}
        onWaiting={onWaiting}
        onStalled={onStalled}
        onError={onError}
        onClick={togglePlay}
      >
        {activeSub ? (
          <track
            key={activeSub}
            src={activeSub}
            kind="subtitles"
            srcLang="en"
            label="Subtitles"
            default
          />
        ) : null}
      </video>

      {/* Interaction overlay for double-tap seeking */}
      <div className="absolute inset-0 z-10" onDoubleClick={onDoubleTap} />

      {/* Tap hint bubble */}
      {tapHint ? (
        <div className={`absolute top-1/2 -translate-y-1/2 z-20 ${tapHint === "left" ? "left-6" : "right-6"}
                        bg-black/60 text-white px-3 py-2 rounded-xl text-sm`}>
          {tapHint === "left" ? "⏪ -10s" : "⏩ +10s"}
        </div>
      ) : null}

      {/* Loading / Buffering / Error overlays */}
      {(loadingMeta || buffering) && !errorMsg ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-xl bg-black/60 px-3 py-2 text-white text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {loadingMeta ? "Loading video…" : "Buffering…"}
          </div>
        </div>
      ) : null}

      {errorMsg ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center">
          <div className="rounded-xl border border-red-400/40 bg-red-900/30 text-red-100 px-4 py-3 text-sm shadow">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {errorMsg}
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => { const v = videoRef.current; v?.load(); setErrorMsg(null); }}>
                Retry
              </Button>
              <a className="underline text-white/90 text-xs" href={streamUrl} target="_blank" rel="noreferrer">
                Open stream URL
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {/* Controls bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/80 to-transparent p-4
                    transition-opacity duration-300 ${uiVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
      >
        <div className="flex items-center gap-3">
          <Button size="icon" variant="secondary" className="rounded-xl" onClick={() => seekBy(-SEEK_LARGE)}>
            <SkipBack className="h-5 w-5" />
          </Button>

          <Button size="icon" variant="secondary" className="rounded-xl" onClick={togglePlay}>
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </Button>

          <Button size="icon" variant="secondary" className="rounded-xl" onClick={() => seekBy(SEEK_LARGE)}>
            <SkipForward className="h-5 w-5" />
          </Button>

          <div className="text-white text-xs tabular-nums ml-2">
            {formatTime(time)} / {formatTime(duration)}
          </div>

          {/* Spacer */}
          <div className="ml-auto" />

          {/* Volume */}
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="secondary"
              className="rounded-xl"
              onClick={() => {
                const v = videoRef.current; if (!v) return;
                v.muted = !v.muted; setMuted(v.muted);
                if (!v.muted && volume === 0) setVolume(0.5);
              }}
            >
              {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-28 accent-white"
            />
          </div>

          {/* Subtitles menu */}
          <div className="relative">
            <Button
              size="icon"
              variant="secondary"
              className="rounded-xl"
              onClick={() => setSubsOpen(v => !v)}
            >
              <Captions className="h-5 w-5" />
            </Button>
            {subsOpen ? (
              <div className="absolute right-0 bottom-12 bg-black/85 text-white rounded-xl p-2 min-w-44 space-y-1 shadow-xl ring-1 ring-white/10">
                <button
                  className={`w-full text-left px-2 py-1 rounded ${!activeSub ? "bg-white/10" : "hover:bg-white/10"}`}
                  onClick={() => { setActiveSub(""); setSubsOpen(false); }}
                >
                  Off
                </button>
                {subs.map(s => (
                  <button
                    key={s.url}
                    className={`w-full text-left px-2 py-1 rounded ${activeSub === s.url ? "bg-white/10" : "hover:bg-white/10"}`}
                    onClick={() => { setActiveSub(s.url); setSubsOpen(false); }}
                    title={s.label}
                  >
                    {flag(s.lang)} {s.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Fullscreen duplicate on right (handy) */}
          <Button size="icon" variant="secondary" className="rounded-xl" onClick={toggleFullscreen}>
            {fs ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </Button>
        </div>

        {/* Progress bar */}
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
            showUI();
          }}
        />

        {/* Tiny debug footer */}
        <div className="mt-1 text-[10px] text-white/50 truncate">
          stream: {streamUrl}
        </div>
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */
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
