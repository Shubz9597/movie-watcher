"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Maximize, Minimize, Pause, Play, Volume2, VolumeX,
  Captions, SkipBack, SkipForward, Loader2, AlertTriangle
} from "lucide-react";
import { getPublicConfig } from "@/app/server-config";


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
const MIN_BUFFER_SEC = 10;                // ahead-of-play to hide spinner
const DEFAULT_PREF_LANGS = ["hi", "en"] as const;


/* ---------------- Local buffer-info hook ----------------
 * Tries GET /buffer/info (either via VOD base or /api) every pollMs.
 * If unavailable, falls back to a tiny Range probe on /stream and
 * reads the custom headers:
 *   - X-Buffer-Target-Bytes
 *   - X-Buffered-Ahead-Probe
 */

type BufInfo = {
  targetBytes: number;
  contiguousAhead: number;
  rollingBps?: number;
  targetAheadSec?: number;
  playheadBytes?: number;
  fileLength?: number;
};

export function useBufferInfo(opts: {
  baseUrl?: string | null;     // VOD base (e.g. https://vod.example.com) or null to use /api proxy
  magnet: string;
  cat: string;
  fileIndex?: number | null;
  streamUrl: string;           // used for header-probe fallback
  pollMs?: number;             // JSON poll interval when SSE isn’t available
}) {
  const { baseUrl, magnet, cat, fileIndex, streamUrl, pollMs = 1000 } = opts;
  const [info, setInfo] = useState<BufInfo | null>(null);

  useEffect(() => {
    if (!magnet || !cat) return;

    let es: EventSource | null = null;
    let aborted = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let lastProbe = 0;

    const base = baseUrl ? `${baseUrl.replace(/\/$/, "")}/buffer/info`
      : `/api/buffer/info`;

    const qs = new URLSearchParams();
    qs.set("magnet", magnet);
    qs.set("cat", cat);
    if (fileIndex != null) qs.set("fileIndex", String(fileIndex));

    const apply = (j: any) => {
      if (aborted || !j) return;
      setInfo({
        targetBytes: Number(j.targetBytes ?? 0),
        contiguousAhead: Number(j.contiguousAhead ?? 0),
        rollingBps: j.rollingBps != null ? Number(j.rollingBps) : undefined,
        targetAheadSec: j.targetAheadSec != null ? Number(j.targetAheadSec) : undefined,
        playheadBytes: j.playheadBytes != null ? Number(j.playheadBytes) : undefined,
        fileLength: j.fileLength != null ? Number(j.fileLength) : undefined,
      });
    };

    const stopSSE = () => {
      if (es) {
        try { es.close(); } catch { }
        es = null;
      }
    };

    const snapOnce = async (): Promise<boolean> => {
      try {
        const r = await fetch(`${base}?${qs}`, { cache: "no-store" });
        if (r.ok && r.headers.get("content-type")?.includes("application/json")) {
          apply(await r.json());
          return true;
        }
      } catch { }
      return false;
    };

    const headerProbe = async () => {
      try {
        const r2 = await fetch(streamUrl, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          cache: "no-store",
        });
        const tgt = Number(r2.headers.get("X-Buffer-Target-Bytes") ?? 0);
        const ahead = Number(r2.headers.get("X-Buffered-Ahead-Probe") ?? 0);
        const cr = r2.headers.get("Content-Range"); // e.g. "bytes 0-0/123456"
        const total = cr?.split("/")?.[1];
        const fileLen = total ? Number(total) : undefined;
        apply({
          targetBytes: tgt,
          contiguousAhead: ahead,
          fileLength: Number.isFinite(fileLen) ? fileLen : undefined,
        });
      } catch { }
    };

    const startPolling = () => {
      const tick = async () => {
        const ok = await snapOnce();
        const now = Date.now();
        if (!ok && now - lastProbe > 15000) {
          lastProbe = now;
          await headerProbe();
        }
        if (!aborted) pollTimer = setTimeout(tick, pollMs);
      };
      tick();
    };

    const startSSE = () => {
      try {
        // server should switch to SSE mode when it sees ?sse=1
        const url = `${base}?${qs}&sse=1`;
        es = new EventSource(url, { withCredentials: false });
        es.onmessage = (e) => {
          try { apply(JSON.parse(e.data)); } catch { /* ignore bad frame */ }
        };
        es.onerror = () => {
          // fall back to polling if SSE can’t stay up
          stopSSE();
          startPolling();
        };
      } catch {
        startPolling();
      }
    };

    // prefer SSE; it will auto-reconnect. if it fails, we’ll poll.
    startSSE();

    return () => {
      aborted = true;
      stopSSE();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [baseUrl, magnet, cat, fileIndex, streamUrl, pollMs]);

  return info;
}


export default function VideoPlayer({
  magnet,
  title,
  year,
  imdbId,
  fileIndex,
  preferLangs,
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

  // buffered state
  const [bufferedRanges, setBufferedRanges] = useState<Array<[number, number]>>([]);
  const [bufferedEnd, setBufferedEnd] = useState(0);

  const leaseRef = useRef<string | null>(null);

  //Watch Lease Manager
  const [leaseId, setLeaseId] = useState<string | null>(null);

  // --- Hover scrub tooltip state ---
  const progressRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);    // px from left inside progress
  const [hoverTime, setHoverTime] = useState<number | null>(null); // seconds at hover

  const [beUrl, setBEUrl] = useState<string | null>(null);

  useEffect(() => {
    (async function getUrls() {
      const vod = (await getPublicConfig()).VOD_API_URL;
      setBEUrl(vod.replace(/\/$/, "")); // remove trailing slash
    })()
  }, []);

  const STREAM_BASE = beUrl ? beUrl + "/stream" : '/api/stream';
  const BUFFER_BASE  = beUrl ? beUrl + "/buffer" : 'api/buffer';
  const WATCH_BASE = beUrl ? beUrl + "/watch" : '/api/watch';
  const PREFETCH_URL = beUrl ? beUrl + "/prefetch" : '/api/prefetch';
  const BUFFER_API = `${BUFFER_BASE}/state`;

  /* ---------------- Stream URL ---------------- */
const streamUrl = useMemo(() => {
  const sp = new URLSearchParams();
  sp.set("cat", cat);
  sp.set("magnet", magnet);
  if (fileIndex != null) sp.set("fileIndex", String(fileIndex));
  return `${STREAM_BASE}?${sp.toString()}`;
}, [magnet, fileIndex, cat, STREAM_BASE]);

  // --- Stable subtitle language prefs + tiny cache ---
  const preferLangsKey = useMemo(
    () => (Array.isArray(preferLangs) && preferLangs.length ? preferLangs.join(",") : DEFAULT_PREF_LANGS.join(",")),
    [Array.isArray(preferLangs) ? preferLangs.join(",") : ""]
  );
  const preferLangsArr = useMemo(() => preferLangsKey.split(","), [preferLangsKey]);

  // Cache subtitles for the session by a stable key so re-renders don’t refetch
  const subsCacheRef = useRef<Map<string, Subtrack[]>>(new Map());

  /* ---------------- Prefetching (initial warm) ---------------- */
 useEffect(() => {
  const sp = new URLSearchParams();
  sp.set("cat", cat);
  sp.set("magnet", magnet);
  if (fileIndex != null) sp.set("fileIndex", String(fileIndex));
  fetch(`${PREFETCH_URL}?${sp.toString()}`, { cache: "no-store" }).catch(() => {});
}, [cat, magnet, fileIndex, PREFETCH_URL]);

  /* ---------------- Subtitles ---------------- */
  // reset selection whenever the media changes
  useEffect(() => {
    setActiveSub("");
    setSubs([]); // optional, clears the list while loading new one
  }, [imdbId, magnet]);
  // load OpenSubtitles list and pick one
  useEffect(() => {
    if (!imdbId) return; // nothing to do without an ID

    let cancelled = false;
    const ac = new AbortController();

    const cacheKey = `${imdbId}|${preferLangsKey}`; // OS search only depends on these
    const useAndPick = (list: Subtrack[]) => {
      if (cancelled) return;
      setSubs(list);
      // Prefer user languages; don't override if user already picked
      const pick =
        preferLangsArr.map(l => list.find(s => s.lang === l)).find(Boolean) || list[0];
      setActiveSub(prev => prev || pick?.url || "");
    };

    (async () => {
      // 1) Cache
      const cached = subsCacheRef.current.get(cacheKey);
      if (cached?.length) {
        useAndPick(cached);
        return;
      }

      // 2) Query OpenSubtitles LIST endpoint; it returns urls pointing to /api/opensub?...&vtt=true
      const sp = new URLSearchParams({ imdbId, langs: preferLangsKey });
      // If you have TV context available, pass it through:
      // if (season) sp.set("s", String(season));
      // if (episode) sp.set("e", String(episode));

      const res = await fetch(`/api/subtitles/opensub?${sp.toString()}`, { signal: ac.signal });
      const j = await res.json().catch(() => ({ subtitles: [] }));
      const list: Subtrack[] = j.subtitles || [];

      subsCacheRef.current.set(cacheKey, list);
      if (list.length) useAndPick(list);
      else if (!cancelled) {
        setSubs([]);
        setActiveSub("");
      }
    })().catch(() => { /* swallow; UI stays as-is */ });

    return () => { cancelled = true; ac.abort(); };
  }, [imdbId, preferLangsKey /*, season, episode */]);

  // choose active sub meta for label/lang
  const activeSubMeta = useMemo(
    () => subs.find(s => s.url === activeSub),
    [subs, activeSub]
  );

  // If a raw .srt/.vtt URL is provided, route via /subtitles/serve so browsers get VTT
  const resolvedActiveSub = activeSub;

  /* ---------------- Auto-hide controls ---------------- */
  const showUI = () => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) {
      hideTimer.current = setTimeout(() => setUiVisible(false), 2500);
    }
  };

  useEffect(() => {
    showUI();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // ---- Watch lease: open on mount, ping every 10s, close on unmount ----
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const params = new URLSearchParams({ cat });
        if (fileIndex != null) params.set("fileIndex", String(fileIndex));
        params.set("magnet", magnet);

        const r = await fetch(`${WATCH_BASE}/open?${params.toString()}`, { method: "POST" });
        if (!r.ok) throw new Error("open failed");
        const { leaseId } = await r.json();
        if (!active) return;
        setLeaseId(leaseId);
        leaseRef.current = leaseId;

        const id = setInterval(() => {
          const lid = leaseRef.current;
          if (!lid) return;
          fetch(`${WATCH_BASE}/ping?leaseId=${encodeURIComponent(lid)}`, { method: "POST", keepalive: true })
            .catch(() => { });
        }, 10_000);
        (window as any).__watchPing = id;
      } catch { }
    })();

    return () => {
      active = false;
      if ((window as any).__watchPing) {
        clearInterval((window as any).__watchPing);
        (window as any).__watchPing = null;
      }
      const lid = leaseRef.current;
      if (lid) {
        const data = new Blob([`leaseId=${lid}`], { type: "text/plain" });
        navigator.sendBeacon(`${WATCH_BASE}/close`, new Blob([`leaseId=${lid}`], { type: "text/plain" }));
      }
    };
  }, [magnet, fileIndex, cat, WATCH_BASE]);

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
    if (v.paused) {
      v.play();
      setPlaying(true);
      const sp = new URLSearchParams({ cat, magnet });
      if (fileIndex != null) sp.set("fileIndex", String(fileIndex));
    } else {
      v.pause();
      setPlaying(false);
      const sp = new URLSearchParams({ cat, magnet });
      if (fileIndex != null) sp.set("fileIndex", String(fileIndex));
    }
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

  const updateHover = (clientX: number) => {
    const el = progressRef.current;
    if (!el || !duration) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const t = (x / rect.width) * duration;
    setHoverX(x);
    setHoverTime(t);
  };

  /* ---------------- Buffered computation ---------------- */
  const pullBuffered = () => {
    const v = videoRef.current; if (!v) return;
    const b = v.buffered;
    const arr: Array<[number, number]> = [];
    for (let i = 0; i < b.length; i++) arr.push([b.start(i), b.end(i)]);
    setBufferedRanges(arr);

    let end = 0, found = false;
    for (let i = 0; i < b.length; i++) {
      const s = b.start(i), e = b.end(i);
      if (v.currentTime >= s && v.currentTime <= e) { end = e; found = true; break; }
    }
    if (!found && b.length) end = b.end(b.length - 1);
    setBufferedEnd(end);
  };

  /* ---------------- Video events (state) ---------------- */
  const onLoadStart = () => { setLoadingMeta(true); setErrorMsg(null); setBuffering(false); };
  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setDuration((e.target as HTMLVideoElement).duration || 0);
    setLoadingMeta(false);
    pullBuffered();
  };
  const onWaiting = () => setBuffering(true);
  const onPlay = () => {
    setBuffering(false); setErrorMsg(null); setPlaying(true);
    const sp = new URLSearchParams({ cat, magnet });
    if (fileIndex != null) sp.set("fileIndex", String(fileIndex));
    fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=play`).catch(() => { });
  };
  const onPause = () => {
    setPlaying(false);
    const sp = new URLSearchParams({ cat, magnet });
    if (fileIndex != null) sp.set("fileIndex", String(fileIndex));
    fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=pause`).catch(() => { });
  };
  const onStalled = () => setBuffering(true);
  const onSeeking = () => setBuffering(true);
  const onSeeked = async () => {
    setBuffering(false); pullBuffered(); const v = videoRef.current;
    if (v && v.paused && Number.isFinite(v.duration) && v.duration > 0) {
      // quick total size probe (cache this if you want)
      try {
        const r = await fetch(streamUrl, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
        const cr = r.headers.get("Content-Range"); // "bytes 0-0/123456"
        const total = cr?.split("/")?.[1];
        const totalBytes = total ? Number(total) : NaN;
        if (Number.isFinite(totalBytes) && totalBytes > 0) {
          const posByte = Math.max(0, Math.floor((v.currentTime / v.duration) * totalBytes));
          // 0-byte fetch to update backend playhead
          fetch(streamUrl, { headers: { Range: `bytes=${posByte}-${posByte}` }, cache: "no-store" }).catch(() => { });
        }
      } catch { }
    }
  };
  const onProgress = () => {
    pullBuffered();
    const v = videoRef.current; if (!v) return;
    const ahead = Math.max(0, bufferedEnd - v.currentTime);
    if (ahead >= MIN_BUFFER_SEC || v.readyState >= 3) setBuffering(false);
  };
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


  // force-show active text track (Chrome sometimes ignores default)
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const wanted = resolvedActiveSub;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        const trackEl = v.querySelectorAll('track')[i] as HTMLTrackElement | null;
        const src = trackEl?.getAttribute('src') ?? "";
        v.textTracks[i].mode = (wanted && src === wanted) ? "showing" as TextTrackMode : "disabled";
      }
    };
    const id = setTimeout(apply, 50); // wait for track to attach
    return () => clearTimeout(id);
  }, [resolvedActiveSub, streamUrl]);

  /* ---------------- Volume binding ---------------- */
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    v.volume = volume;
    if (volume === 0 && !v.muted) v.muted = true;
    if (volume > 0 && v.muted) v.muted = false;
    setMuted(v.muted);
  }, [volume]);

  /* ---------------- Buffer Info  ---------------- */
  const info = useBufferInfo({
  baseUrl: beUrl,
  magnet,
  cat,
  fileIndex,
  streamUrl,
  pollMs: 1000,
});


  const serverBar = useMemo(() => {
    const fileLen = info?.fileLength;
    if (!fileLen || fileLen <= 0) return null;

    // Prefer backend playhead; else estimate from currentTime
    const estPlayhead =
      info?.playheadBytes ??
      (duration > 0 ? Math.floor((time / duration) * fileLen) : null);

    const aheadB = info?.contiguousAhead;
    if (estPlayhead == null || aheadB == null) return null;

    const leftPct = Math.max(0, Math.min(100, (estPlayhead / fileLen) * 100));
    const widthPct = Math.max(0, Math.min(100 - leftPct, (aheadB / fileLen) * 100));
    return { leftPct, widthPct };
  }, [info, time, duration]);
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
        preload="auto"               // allow buffering while paused
        crossOrigin="anonymous"
        controls={false}
        onLoadStart={onLoadStart}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={e => setTime((e.target as HTMLVideoElement).currentTime || 0)}
        onPlay={onPlay}
        onPause={onPause}
        onWaiting={onWaiting}
        onStalled={onStalled}
        onSeeking={onSeeking}
        onSeeked={onSeeked}
        onProgress={onProgress}
        onError={onError}
        onClick={togglePlay}
        playsInline
      >
        {resolvedActiveSub ? (
          <track
            key={activeSub || "none"}
            src={activeSub || undefined}
            kind="subtitles"
            srcLang={activeSubMeta?.lang || "en"}
            label={activeSubMeta?.label || "Subtitles"}
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

      {/* Loading / Buffering overlay (doesn't block clicks) */}
      {(loadingMeta || buffering) && !errorMsg ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 rounded-xl bg-black/60 px-3 py-2 text-white text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {loadingMeta ? "Loading video…" : "Buffering…"}
          </div>
        </div>
      ) : null}

      {/* Error overlay (interactive) */}
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
              <a
                className="underline text-white/90 text-xs"
                href={`/api/vlc?${new URLSearchParams({
                  cat,
                  magnet,
                  ...(fileIndex != null ? { fileIndex: String(fileIndex) } : {}),
                  title: `${title}${year ? ` (${year})` : ""}`,
                }).toString()}`}
              >
                Open in VLC
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
              aria-haspopup="menu"
              aria-expanded={subsOpen}
              aria-label="Subtitles"
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

        {/* Progress + Buffer (with hover tooltip) */}
        <div
          ref={progressRef}
          className="relative mt-2 w-full h-6"
          onMouseMove={(e) => updateHover(e.clientX)}
          onMouseLeave={() => { setHoverX(null); setHoverTime(null); }}
          onClick={(e) => {
            if (!duration) return;
            const el = progressRef.current; if (!el) return;
            const rect = el.getBoundingClientRect();
            const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            const t = (x / rect.width) * duration;
            const v = videoRef.current; if (!v) return;
            v.currentTime = t; setTime(t);
          }}
        >
          {/* Buffered segments (under the slider) */}
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 rounded bg-white/10 overflow-hidden">
            {bufferedRanges.map(([s, e], i) => {
              const left = duration ? (s / duration) * 100 : 0;
              const width = duration ? ((e - s) / duration) * 100 : 0;
              return (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 bg-white/25"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })}
          </div>

          {/* Played overlay */}
          <div
            className="absolute top-1/2 -translate-y-1/2 left-0 h-2 bg-white/80 rounded pointer-events-none"
            style={{ width: `${duration ? (time / duration) * 100 : 0}%` }}
          />

          {/* Server-side buffered-ahead (thin overlay) */}
          {serverBar ? (
            <div
              className="absolute top-1/2 -translate-y-1/2 h-1 bg-white/40 rounded pointer-events-none"
              style={{ left: `${serverBar.leftPct}%`, width: `${serverBar.widthPct}%` }}
            />
          ) : null}

          {/* Seek slider (on top) */}
          <input
            className="absolute inset-x-0 top-1/2 -translate-y-1/2 w-full h-2 bg-transparent
               appearance-none cursor-pointer z-10"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            onChange={e => {
              const v = videoRef.current; if (!v) return;
              const t = Number(e.target.value);
              v.currentTime = t; setTime(t); showUI();
            }}
          />

          {/* Hover tooltip */}
          {hoverX != null && hoverTime != null ? (
            <div
              className="absolute -top-8 z-20 select-none"
              style={{ left: `calc(${hoverX}px)` }}
            >
              <div className="relative -translate-x-1/2">
                <div className="px-2 py-1 rounded bg-black/80 text-white text-[11px] shadow">
                  {formatTime(hoverTime)}
                </div>
                <div className="mx-auto w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-black/80" />
              </div>
            </div>
          ) : null}
        </div>

        {/* Tiny debug footer (now shows backend buffer targets too) */}
        <div className="mt-1 text-[10px] text-white/60 truncate">
          stream: {streamUrl}
          {info ? (
            <>
              {" "}| buffer {(info.contiguousAhead / (1024 * 1024)).toFixed(1)} MB
              {" / "}
              target {(info.targetBytes / (1024 * 1024)).toFixed(1)} MB
              {info.rollingBps ? (
                <> ({Math.max(0, Math.round(info.targetBytes / Math.max(1, info.rollingBps)))}s)</>
              ) : null}
            </>
          ) : null}
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

<style jsx>{`
  input[type="range"] {
    outline: none;
  }
  /* WebKit */
  input[type="range"]::-webkit-slider-runnable-track {
    background: transparent;
    height: 8px;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px; height: 14px;
    border-radius: 9999px;
    background: white;
    margin-top: -3px; /* center thumb on 8px track */
    box-shadow: 0 0 0 2px rgba(0,0,0,.15);
  }
  /* Firefox */
  input[type="range"]::-moz-range-track {
    background: transparent;
    height: 8px;
  }
  input[type="range"]::-moz-range-thumb {
    width: 14px; height: 14px;
    border-radius: 9999px;
    background: white;
    border: none;
    box-shadow: 0 0 0 2px rgba(0,0,0,.15);
  }
`}</style>
