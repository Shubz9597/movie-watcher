"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Maximize, Minimize, Pause, Play, Volume2, VolumeX, Volume1,
  Captions, SkipBack, SkipForward, Loader2, AlertTriangle,
  Download, MonitorPlay, RotateCcw
} from "lucide-react";

// ---------- Hardcoded VOD endpoints ----------
const VOD_BASE = "http://localhost:4001";
const isElectron = typeof window !== "undefined" && Boolean((window as any).electronAPI);
const STREAM_BASE = `${VOD_BASE}/stream`;
const BUFFER_BASE = `${VOD_BASE}/buffer`;
const WATCH_BASE  = `${VOD_BASE}/watch`;
const PREFETCH_URL = `${VOD_BASE}/prefetch`;

const AUTOSTART_THRESHOLD = 0.9;
const HEARTBEAT_MS = 5000;

type Subtrack = { label: string; lang: string; url: string; source: "torrent" | "opensub" };
type NextEpisodeState = { season: number; episode: number; streamUrl: string; countdown: number; title?: string | null; };

type Props = {
  magnet?: string;
  fileIndex?: number;
  cat?: "movie" | "tv" | "anime";
  streamUrl?: string;
  seriesId?: string;
  season?: number;
  episode?: number;
  kind?: "movie" | "tv" | "anime";
  seriesTitle?: string;
  estRuntimeMin?: number;
  title: string;
  year?: number;
  imdbId?: string;
  preferLangs?: string[];
};

const SEEK_SMALL = 5;
const SEEK_LARGE = 10;
const MIN_BUFFER_SEC = 10;
const DEFAULT_PREF_LANGS = ["hi", "en"] as const;

// ---------- helpers ----------
function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  const KEY = "mw_device_id";
  const existing = localStorage.getItem(KEY);
  if (existing && existing !== "null" && existing !== "undefined") return existing;
  const canUseUUID = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function";
  const newId = canUseUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem(KEY, newId);
  return newId;
}

async function computeProfileHash(): Promise<string> {
  const tests = [
    ['video/mp4; codecs="avc1.42E01E"', "h264"],
    ['video/mp4; codecs="hev1.1.6.L93.B0"', "hevc"],
    ['video/mp4; codecs="av01.0.05M.08"', "av1"],
  ] as const;
  const supported = tests
    .filter(([mime]) => typeof window !== "undefined" && "MediaSource" in window && typeof (window.MediaSource as { isTypeSupported?: (type: string) => boolean }).isTypeSupported === "function" && (window.MediaSource as { isTypeSupported: (type: string) => boolean }).isTypeSupported(mime))
    .map(([, k]) => k).sort().join(",");
  return `caps:${supported || "h264"}|v1`;
}

function readQS(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}
function qsString(name: string): string | undefined { const v = readQS().get(name); return v ?? undefined; }
function qsInt(name: string): number | undefined { const v = readQS().get(name); if (!v) return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }

function appendCatParam(url: string, cat: string) {
  if (!url) return url;
  if (url.includes("cat=")) return url;
  return url.includes("?") ? `${url}&cat=${cat}` : `${url}?cat=${cat}`;
}

function downloadM3U(streamUrl: string, title: string, year?: number, subtitleUrl?: string) {
  const displayTitle = year ? `${title} (${year})` : title;
  const safeFilename = displayTitle.replace(/[<>:"/\\|?*]/g, "_");
  
  // Build M3U with optional subtitle for VLC
  // Use input-slave for network URLs (sub-file only works for local paths)
  let m3uContent = `#EXTM3U\n#EXTINF:-1,${displayTitle}\n`;
  if (subtitleUrl) {
    // VLC uses input-slave for additional network streams (subtitles)
    m3uContent += `#EXTVLCOPT:input-slave=${subtitleUrl}\n`;
    // Also set subtitle track to load automatically
    m3uContent += `#EXTVLCOPT:sub-track=0\n`;
  }
  m3uContent += `${streamUrl}\n`;
  
  const blob = new Blob([m3uContent], { type: "audio/x-mpegurl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFilename}.m3u`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

type BufInfo = { targetBytes: number; contiguousAhead: number; rollingBps?: number; targetAheadSec?: number; playheadBytes?: number; fileLength?: number; };

export function useBufferInfo(opts: { baseUrl?: string | null; magnet?: string; cat: string; fileIndex?: number | null; streamUrl: string; pollMs?: number; }) {
  const { baseUrl, magnet, cat, fileIndex, streamUrl, pollMs = 1000 } = opts;
  const [info, setInfo] = useState<BufInfo | null>(null);

  useEffect(() => {
    if (!cat) return;
    let es: EventSource | null = null;
    let aborted = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let lastProbe = 0;

    const base = baseUrl ? `${baseUrl.replace(/\/$/, "")}/buffer/info` : `/api/buffer/info`;
    const qs = new URLSearchParams();
    if (magnet) qs.set("magnet", magnet);
    qs.set("cat", cat);
    if (fileIndex != null) qs.set("fileIndex", String(fileIndex));

    type BufInfoPayload = { targetBytes?: number; contiguousAhead?: number; rollingBps?: number | null; targetAheadSec?: number | null; playheadBytes?: number | null; fileLength?: number | null; };
    const apply = (j: BufInfoPayload | null | undefined) => {
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

    const stopSSE = () => { try { es?.close(); } catch {} es = null; };
    const snapOnce = async (): Promise<boolean> => {
      try { const r = await fetch(`${base}?${qs}`, { cache: "no-store" }); if (r.ok && r.headers.get("content-type")?.includes("application/json")) { apply(await r.json()); return true; } } catch {}
      return false;
    };
    const headerProbe = async () => {
      try {
        const r2 = await fetch(streamUrl, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" });
        const tgt = Number(r2.headers.get("X-Buffer-Target-Bytes") ?? 0);
        const ahead = Number(r2.headers.get("X-Buffered-Ahead-Probe") ?? 0);
        const cr = r2.headers.get("Content-Range");
        const total = cr?.split("/")?.[1];
        const fileLen = total ? Number(total) : undefined;
        apply({ targetBytes: tgt, contiguousAhead: ahead, fileLength: Number.isFinite(fileLen) ? fileLen : undefined });
      } catch {}
    };
    const startPolling = () => {
      const tick = async () => {
        const ok = await snapOnce();
        const now = Date.now();
        if (!ok && now - lastProbe > 15000) { lastProbe = now; await headerProbe(); }
        if (!aborted) pollTimer = setTimeout(tick, pollMs);
      };
      tick();
    };
    const startSSE = () => {
      try {
        const url = `${base}?${qs}&sse=1`;
        es = new EventSource(url, { withCredentials: false });
        es.onmessage = (e) => { try { apply(JSON.parse(e.data)); } catch {} };
        es.onerror = () => { stopSSE(); startPolling(); };
      } catch { startPolling(); }
    };

    startSSE();
    return () => { aborted = true; stopSSE(); if (pollTimer) clearTimeout(pollTimer); };
  }, [baseUrl, magnet, cat, fileIndex, streamUrl, pollMs]);

  return info;
}

export default function VideoPlayer(props: Props) {
  const kind = (props.kind ?? (qsString("kind") as Props["kind"])) ?? props.cat ?? "movie";
  const seriesId = props.seriesId ?? qsString("seriesId");
  const initialSeason = props.season ?? qsInt("season") ?? (kind === "movie" ? 0 : 1);
  const initialEpisode = props.episode ?? qsInt("episode") ?? (kind === "movie" ? 0 : 1);
  const estRuntimeMin = props.estRuntimeMin ?? (kind === "movie" ? 120 : 42);

  const isElectron = typeof window !== "undefined" && Boolean((window as any).electronAPI);
  const [curSeason, setCurSeason] = useState<number>(initialSeason);
  const [curEpisode, setCurEpisode] = useState<number>(initialEpisode);

  const subjectId = useMemo(getDeviceId, []);
  const [profileHash, setProfileHash] = useState("caps:h264|v1");
  useEffect(() => { computeProfileHash().then(setProfileHash).catch(()=>{}); }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fs, setFs] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);

  const [subs, setSubs] = useState<Subtrack[]>([]);
  const [subsOpen, setSubsOpen] = useState(false);
  const [activeSub, setActiveSub] = useState<string>("");

  const [loadingMeta, setLoadingMeta] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [uiVisible, setUiVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tapHint, setTapHint] = useState<"left" | "right" | null>(null);
  const [volumeHover, setVolumeHover] = useState(false);
  const [seekPreview, setSeekPreview] = useState<{ x: number; time: number } | null>(null);

  const [bufferedRanges, setBufferedRanges] = useState<Array<[number, number]>>([]);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const leaseRef = useRef<string | null>(null);
  const [autoStartArmed, setAutoStartArmed] = useState(true);

  const [nextUp, setNextUp] = useState<NextEpisodeState | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [autoplayNext, setAutoplayNext] = useState(true);

  const [src, setSrc] = useState<string | undefined>(undefined);
  const withCat = useCallback((url: string) => appendCatParam(url, kind), [kind]);

  useEffect(() => {
    const qsStream = qsString("streamUrl");
    if (props.streamUrl || qsStream) { 
      const url = withCat(props.streamUrl ?? qsStream!);
      console.log("[VideoPlayer] Setting src from streamUrl:", url);
      setSrc(url); 
      return; 
    }
    const magnet = props.magnet ?? qsString("src");
    if (magnet) {
      const sp = new URLSearchParams(); sp.set("cat", kind); sp.set("magnet", magnet);
      const fi = props.fileIndex ?? qsInt("fileIndex");
      if (fi != null) sp.set("fileIndex", String(fi));
      const url = `${STREAM_BASE}?${sp.toString()}`;
      console.log("[VideoPlayer] Setting src from magnet:", url);
      setSrc(url);
    } else {
      console.log("[VideoPlayer] No magnet or streamUrl found, props:", props, "qsString src:", qsString("src"));
    }
  }, [props.streamUrl, props.magnet, props.fileIndex, withCat, kind]);

  // Explicitly load video when src changes - don't wait for buffer info
  // Keep it paused until prebuffer threshold is met
  useEffect(() => {
    if (!src) {
      // Do not clear video aggressively; just wait until src is set
      return;
    }
    const v = videoRef.current;
    if (!v) {
      console.log("[VideoPlayer] Video element not ready yet, will retry");
      // Retry after a short delay
      const timer = setTimeout(() => {
        const v2 = videoRef.current;
        if (v2 && src) {
          console.log("[VideoPlayer] Retry: Updating video src and calling load()");
          v2.src = src;
          v2.pause(); // Ensure paused - autostart will play when ready
          v2.load();
        }
      }, 200);
      return () => clearTimeout(timer);
    }
    console.log("[VideoPlayer] src changed, current video src:", v.src, "new src:", src);
    if (v.src !== src) {
      console.log("[VideoPlayer] Updating video src and calling load() - starting stream download (paused until prebuffer ready)");
      v.src = src;
      v.pause(); // Explicitly pause - autostart logic will play when prebuffer threshold is met
      
      // Add event listeners to track video loading
      const onLoadStart = () => console.log("[VideoPlayer] Video loadstart event - stream request initiated");
      const onCanPlay = () => console.log("[VideoPlayer] Video canplay event - data available");
      const onError = (e: Event) => console.error("[VideoPlayer] Video error:", e);
      
      v.addEventListener("loadstart", onLoadStart);
      v.addEventListener("canplay", onCanPlay);
      v.addEventListener("error", onError);
      
      v.load();
      
      // Clean up listeners after a delay
      setTimeout(() => {
        v.removeEventListener("loadstart", onLoadStart);
        v.removeEventListener("canplay", onCanPlay);
        v.removeEventListener("error", onError);
      }, 10000);
      
      // Trigger a probe request to wake up the buffer and get initial buffer info
      setTimeout(() => {
        console.log("[VideoPlayer] Sending probe request to wake buffer");
        fetch(src, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" })
          .then(r => {
            console.log("[VideoPlayer] Probe response:", r.status, "target:", r.headers.get("X-Buffer-Target-Bytes"), "ahead:", r.headers.get("X-Buffered-Ahead-Probe"));
          })
          .catch(err => console.log("[VideoPlayer] Probe error:", err));
      }, 100);
    }
  }, [src]);

  useEffect(() => {
    const magnet = props.magnet ?? qsString("src");
    const fi = props.fileIndex ?? qsInt("fileIndex");
    if (!magnet) return;
    const sp = new URLSearchParams(); sp.set("cat", kind); sp.set("magnet", magnet);
    if (fi != null) sp.set("fileIndex", String(fi));
    fetch(`${PREFETCH_URL}?${sp.toString()}`, { cache: "no-store" }).catch(() => {});
  }, [props.magnet, props.fileIndex, kind]);

  useEffect(() => {
    const magnet = props.magnet ?? qsString("src");
    const fi = props.fileIndex ?? qsInt("fileIndex");
    const sp = new URLSearchParams({ cat: kind });
    if (magnet) sp.set("magnet", magnet);
    if (fi != null) sp.set("fileIndex", String(fi));
    fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=pause`).catch(() => {});
    setAutoStartArmed(true);
  }, [props.magnet, props.fileIndex, kind]);

  const beginNextEpisode = useCallback((entry?: NextEpisodeState | null) => {
    const target = entry ?? nextUp; if (!target) return;
    const nextUrl = withCat(target.streamUrl); if (!nextUrl) return;
    setSrc(nextUrl);
    setCurSeason(target.season); setCurEpisode(target.episode);
    setNextUp(null); setNextError(null); setAutoplayNext(true); setAutoStartArmed(true);
    setTimeout(() => videoRef.current?.play().catch(() => {}), 300);
  }, [nextUp, withCat]);

  useEffect(() => {
    if (!nextUp || !autoplayNext) return;
    if (nextUp.countdown <= 0) { beginNextEpisode(nextUp); return; }
    const timer = setTimeout(() => { setNextUp((prev) => (prev ? { ...prev, countdown: prev.countdown - 1 } : null)); }, 1000);
    return () => clearTimeout(timer);
  }, [nextUp, autoplayNext, beginNextEpisode]);

  useEffect(() => { setNextUp(null); setNextError(null); setAutoplayNext(true); }, [src]);
  useEffect(() => { if (!seriesId || kind === "movie") { setNextUp(null); setNextError(null); } }, [seriesId, kind]);

  // Subtitles - fetch from Go backend which checks torrent first, then external sources
  useEffect(() => { setActiveSub(""); setSubs([]); }, [props.imdbId, props.magnet]);
  const preferLangsKey = useMemo(() => (props.preferLangs?.length ? props.preferLangs.join(",") : DEFAULT_PREF_LANGS.join(",")), [props.preferLangs]);
  const preferLangsArr = useMemo(() => preferLangsKey.split(","), [preferLangsKey]);
  const subsCacheRef = useRef<Map<string, Subtrack[]>>(new Map());

  useEffect(() => {
    const magnet = props.magnet ?? qsString("src");
    const imdbId = props.imdbId;
    if (!magnet && !imdbId) return;
    
    let cancelled = false;
    const ac = new AbortController();
    const cacheKey = `${magnet || ""}|${imdbId || ""}|${preferLangsKey}`;
    
    const applySubs = (list: Subtrack[]) => {
      if (cancelled) return;
      setSubs(list);
      const pick = preferLangsArr.map(l => list.find(s => s.lang === l)).find(Boolean) || list[0];
      setActiveSub(prev => prev || pick?.url || "");
    };

    (async () => {
      const cached = subsCacheRef.current.get(cacheKey);
      if (cached?.length) { applySubs(cached); return; }
      
      // Build params for Go backend /subtitles/list endpoint
      const sp = new URLSearchParams({ cat: kind });
      if (magnet) sp.set("magnet", magnet);
      if (imdbId) sp.set("imdbId", imdbId);
      sp.set("langs", preferLangsKey);
      
      const res = await fetch(`${VOD_BASE}/subtitles/list?${sp.toString()}`, { signal: ac.signal });
      if (!res.ok) throw new Error("subtitles request failed");
      
      const j = await res.json().catch(() => ({ torrent: [], external: [] }));
      
      // Combine torrent and external subtitles
      const list: Subtrack[] = [];
      
      // Torrent subtitles first (they're local, faster)
      type TorrentSub = { index: number; path: string; name: string; lang: string; ext: string };
      for (const sub of (j.torrent || []) as TorrentSub[]) {
        list.push({
          label: sub.name || `${sub.lang.toUpperCase()} (torrent)`,
          lang: sub.lang,
          url: `${VOD_BASE}/subtitles/torrent?magnet=${encodeURIComponent(magnet || "")}&cat=${kind}&fileIndex=${sub.index}`,
          source: "torrent",
        });
      }
      
      // External subtitles
      type ExternalSub = { source: string; id: string; lang: string; label: string; url: string };
      for (const sub of (j.external || []) as ExternalSub[]) {
        list.push({
          label: sub.label || `${sub.lang.toUpperCase()} (${sub.source})`,
          lang: sub.lang,
          url: `${VOD_BASE}${sub.url}`,
          source: "opensub",
        });
      }
      
      subsCacheRef.current.set(cacheKey, list);
      if (list.length) applySubs(list);
      else if (!cancelled) { setSubs([]); setActiveSub(""); }
    })().catch(() => {});

    return () => { cancelled = true; ac.abort(); };
  }, [props.imdbId, props.magnet, preferLangsKey, preferLangsArr, kind]);

  const activeSubMeta = useMemo(() => subs.find(s => s.url === activeSub), [subs, activeSub]);

  // Auto-hide controls
  const showUI = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = setTimeout(() => setUiVisible(false), 3000);
  }, [playing]);
  useEffect(() => { showUI(); }, [showUI]);

  // Watch lease
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const params = new URLSearchParams({ cat: kind });
        const magnet = props.magnet ?? qsString("src");
        const fi = props.fileIndex ?? qsInt("fileIndex");
        if (fi != null) params.set("fileIndex", String(fi));
        if (magnet) params.set("magnet", magnet);
        const r = await fetch(`${WATCH_BASE}/open?${params.toString()}`, { method: "POST" });
        if (!r.ok) throw new Error("open failed");
        const { leaseId } = await r.json();
        if (stopped) return;
        leaseRef.current = leaseId;
        const id = setInterval(() => {
          const lid = leaseRef.current; if (!lid) return;
          fetch(`${WATCH_BASE}/ping?leaseId=${encodeURIComponent(lid)}`, { method: "POST", keepalive: true })
            .then(r => {
              if (!r.ok) {
                console.warn("[VideoPlayer] Ping failed:", r.status, r.statusText);
              }
            })
            .catch(err => {
              console.error("[VideoPlayer] Ping error:", err);
            });
        }, 10_000);
        (window as unknown as Record<string, NodeJS.Timeout | null>).__watchPing = id;
      } catch {}
    })();

    return () => {
      stopped = true;
      const ping = (window as unknown as Record<string, NodeJS.Timeout | null>).__watchPing;
      if (ping) { clearInterval(ping); (window as unknown as Record<string, NodeJS.Timeout | null>).__watchPing = null; }
      const lid = leaseRef.current;
      if (lid) { const data = new Blob([`leaseId=${lid}`], { type: "text/plain" }); navigator.sendBeacon(`${WATCH_BASE}/close`, data); }
    };
  }, [props.magnet, props.fileIndex, kind]);

  // Keyboard
  const seekBy = useCallback((sec: number) => {
    if (isElectron) {
      (window as any).electronAPI?.seekMpv?.(sec, true);
      setTapHint(sec > 0 ? "right" : "left");
      setTimeout(() => setTapHint(null), 400);
      showUI();
      return;
    }
    const v = videoRef.current; if (!v) return;
    const d = duration || v.duration || 0;
    v.currentTime = Math.min(Math.max(0, v.currentTime + sec), d);
    setTime(v.currentTime);
    setTapHint(sec > 0 ? "right" : "left");
    setTimeout(() => setTapHint(null), 400);
    showUI();
  }, [duration, showUI]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current; if (!v) return;
      switch (e.key.toLowerCase()) {
        case " ": case "k": e.preventDefault(); togglePlay(); break;
        case "arrowleft": e.preventDefault(); seekBy(-SEEK_SMALL); break;
        case "arrowright": e.preventDefault(); seekBy(SEEK_SMALL); break;
        case "j": e.preventDefault(); seekBy(-SEEK_LARGE); break;
        case "l": e.preventDefault(); seekBy(SEEK_LARGE); break;
        case "m": e.preventDefault(); v.muted = !v.muted; setMuted(v.muted); if (!v.muted && volume === 0) setVolume(0.5); break;
        case "f": e.preventDefault(); toggleFullscreen(); break;
        case "escape": if (document.fullscreenElement) document.exitFullscreen(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [volume, seekBy]);

  // Poll mpv state when in Electron mode to sync UI (time, duration, playing state)
  useEffect(() => {
    if (!isElectron || !playing) return;
    
    const pollMpvState = async () => {
      try {
        const state = await (window as any).electronAPI?.getMpvState?.();
        if (state?.ok && state?.state) {
          const s = state.state;
          if (typeof s.time === "number") setTime(s.time);
          if (typeof s.duration === "number" && s.duration > 0) setDuration(s.duration);
          if (typeof s.paused === "boolean") setPlaying(!s.paused);
          if (typeof s.volume === "number") setVolume(s.volume);
          if (typeof s.mute === "boolean") setMuted(s.mute);
        }
      } catch (err) {
        // Silently fail - mpv might not be ready yet
      }
    };
    
    // Poll every 250ms for smooth updates
    const interval = setInterval(pollMpvState, 250);
    pollMpvState(); // Initial poll
    
    return () => clearInterval(interval);
  }, [isElectron, playing]);

  const prepareNextEpisode = useCallback(async () => {
    if (!seriesId || kind === "movie") return;
    try {
      setNextError(null);
      const res = await fetch(`${VOD_BASE}/v1/session/ended`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ SeriesID: seriesId, SeriesTitle: props.seriesTitle ?? props.title ?? "", Kind: kind, Season: curSeason, Episode: curEpisode, ProfileHash: profileHash, EstRuntimeMin: estRuntimeMin }),
      });
      if (!res.ok) throw new Error(`Next episode failed (${res.status})`);
      const data = await res.json();
      const countdown = Number(data?.autoplayIn ?? 10) || 10;
      const stream = withCat(data?.streamUrl || "");
      if (!stream) throw new Error("Missing stream URL");
      setNextUp({ season: data?.nextPick?.Season ?? curSeason, episode: data?.nextPick?.Episode ?? curEpisode + 1, streamUrl: stream, countdown, title: data?.nextPick?.ReleaseGroup || props.seriesTitle || props.title || "Up next" });
      setAutoplayNext(true);
    } catch (err) { setNextError((err as Error)?.message || "Failed to fetch next episode"); setNextUp(null); }
  }, [seriesId, kind, curSeason, curEpisode, profileHash, estRuntimeMin, props.seriesTitle, props.title, withCat]);

  // Player helpers
  const playWithElectron = useCallback(async () => {
    if (!isElectron) return;
    if (!src) { console.warn("[VideoPlayer] No stream URL available for mpv"); return; }
    try {
      // Ensure the in-page video stays paused to avoid double playback
      const v = videoRef.current; v?.pause();
      setPlaying(true);
      const res = await (window as any).electronAPI.playInMpv(src);
      if (!res?.ok) {
        console.error("[VideoPlayer] mpv play failed", res?.error);
        setPlaying(false);
      }
    } catch (err) {
      console.error("[VideoPlayer] mpv play error", err);
      setPlaying(false);
    }
  }, [isElectron, src]);

  const togglePlay = useCallback(() => {
    if (isElectron) {
      if (!playing) {
        void playWithElectron();
      } else {
        (window as any).electronAPI?.pauseMpv?.(true);
        setPlaying(false);
      }
      return;
    }
    const v = videoRef.current; if (!v) return;
    if (v.paused) { v.play().catch(() => {}); setPlaying(true); } else { v.pause(); setPlaying(false); }
  }, [isElectron, playWithElectron, playing]);
  const toggleFullscreen = async () => { const el = containerRef.current; if (!el) return; if (!document.fullscreenElement) { await el.requestFullscreen(); setFs(true); } else { await document.exitFullscreen(); setFs(false); } };
  const onDoubleTap = (e: React.MouseEvent<HTMLDivElement>) => { const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); const x = e.clientX - rect.left; if (x < rect.width / 3) seekBy(-SEEK_LARGE); else if (x > rect.width * 2 / 3) seekBy(SEEK_LARGE); else togglePlay(); };

  function explainMediaError(v: HTMLVideoElement | null) {
    const err = v?.error; if (!err) return null;
    switch (err.code) {
      case err.MEDIA_ERR_ABORTED: return "Playback aborted.";
      case err.MEDIA_ERR_NETWORK: return "Network error.";
      case err.MEDIA_ERR_DECODE: return "Decode failed (codec issue).";
      case err.MEDIA_ERR_SRC_NOT_SUPPORTED: default: return "Format not supported by browser.";
    }
  }

  // Buffer ranges
  const pullBuffered = () => {
    const v = videoRef.current; if (!v) return;
    const b = v.buffered;
    const arr: Array<[number, number]> = [];
    for (let i = 0; i < b.length; i++) arr.push([b.start(i), b.end(i)]);
    setBufferedRanges(arr);
    let end = 0, found = false;
    for (let i = 0; i < b.length; i++) { const s = b.start(i), e = b.end(i); if (v.currentTime >= s && v.currentTime <= e) { end = e; found = true; break; } }
    if (!found && b.length) end = b.end(b.length - 1);
    setBufferedEnd(end);
  };

  // Video events
  const onLoadStart = () => { setLoadingMeta(true); setErrorMsg(null); setBuffering(false); };
  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => { setDuration((e.target as HTMLVideoElement).duration || 0); setLoadingMeta(false); pullBuffered(); };
  const onWaiting = () => setBuffering(true);
  const onPlay = () => {
    if (!isElectron) {
      setBuffering(false); setErrorMsg(null); setPlaying(true);
      const sp = new URLSearchParams({ cat: kind }); const magnet = props.magnet ?? qsString("src"); const fi = props.fileIndex ?? qsInt("fileIndex");
      if (fi != null) sp.set("fileIndex", String(fi)); if (magnet) sp.set("magnet", magnet);
      fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=play`).catch(() => {});
    } else {
      setBuffering(false); setErrorMsg(null); setPlaying(true);
    }
  };
  const onPause = () => {
    if (!isElectron) {
      setPlaying(false);
      const sp = new URLSearchParams({ cat: kind }); const magnet = props.magnet ?? qsString("src"); const fi = props.fileIndex ?? qsInt("fileIndex");
      if (fi != null) sp.set("fileIndex", String(fi)); if (magnet) sp.set("magnet", magnet);
      fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=pause`).catch(() => {});
    } else {
      setPlaying(false);
      (window as any).electronAPI?.pauseMpv?.(true);
    }
  };
  const onStalled = () => setBuffering(true);
  const onSeeking = () => setBuffering(true);
  const onSeeked = async () => { setBuffering(false); pullBuffered(); };
  const onProgress = () => { 
    pullBuffered(); 
    const v = videoRef.current; 
    if (!v) return; 
    const ahead = Math.max(0, bufferedEnd - v.currentTime); 
    if (ahead >= MIN_BUFFER_SEC || v.readyState >= 3) setBuffering(false);
    // Trigger autostart check if buffer info isn't available and video is paused with enough data
    if (v.paused && !info && ahead >= 3 && v.readyState >= 2) {
      console.log("[VideoPlayer] Autostart triggered from onProgress (fallback, buffer info unavailable)");
      v.play().catch(() => {}); 
      setAutoStartArmed(false);
    }
  };
  const onError = async () => {
    const v = videoRef.current;
    let help = explainMediaError(v) ?? "Playback error.";
    if (src) {
      try {
        const r = await fetch(src, { method: "GET", headers: { Range: "bytes=0-0" } });
        const fn = r.headers.get("X-File-Name") ?? "";
        const ct = r.headers.get("Content-Type") ?? "";
        if (/\.mkv$/i.test(fn) || /matroska/.test(ct)) help += " MKV may be HEVC. Try Edge or VLC.";
        if (r.status === 504) help += " Server timeout.";
      } catch {}
    }
    setErrorMsg(help); setBuffering(false); setPlaying(false);
  };

  // Resume seek
  useEffect(() => {
    if (!seriesId) return;
    const el = videoRef.current; if (!el) return;
    fetch(`${VOD_BASE}/v1/resume?subjectId=${encodeURIComponent(subjectId)}&seriesId=${encodeURIComponent(seriesId)}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then((j) => { if (!j || j.found === false || j.season !== curSeason || j.episode !== curEpisode) return; const pos = Number(j.position_s ?? 0); const onMeta = () => { try { el.currentTime = Math.max(pos, 0); } catch {} el.removeEventListener("loadedmetadata", onMeta); }; el.addEventListener("loadedmetadata", onMeta); })
      .catch(()=>{});
  }, [seriesId, subjectId, curSeason, curEpisode]);

  // Heartbeat
  useEffect(() => {
    if (!seriesId) return;
    const v = videoRef.current; if (!v) return;
    const t = setInterval(() => {
      if (!v.duration || isNaN(v.duration)) return;
      fetch(`${VOD_BASE}/v1/session/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subjectId, seriesId, season: curSeason, episode: curEpisode, position_s: Math.floor(v.currentTime), duration_s: Math.floor(v.duration) }) }).catch(()=>{});
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [seriesId, curSeason, curEpisode, subjectId]);

  const onEnded = async () => { 
    if (isElectron) { setPlaying(false); return; }
    if (!seriesId || kind === "movie") return; await prepareNextEpisode(); 
  };

  // Volume
  useEffect(() => { const v = videoRef.current; if (!v) return; v.volume = volume; if (volume === 0 && !v.muted) v.muted = true; if (volume > 0 && v.muted) v.muted = false; setMuted(v.muted); }, [volume]);

  // Buffer info
  const info = !isElectron ? useBufferInfo({ baseUrl: VOD_BASE, magnet: props.magnet ?? qsString("src"), cat: kind, fileIndex: props.fileIndex ?? qsInt("fileIndex"), streamUrl: src || "", pollMs: 1000 }) : null;

  useEffect(() => {
    if (isElectron) return;
    const v = videoRef.current;
    const hasSrc = v && v.src && v.src.length > 0;
    
    if (!autoStartArmed || playing || !hasSrc) {
      console.log("[VideoPlayer] Autostart skip:", { autoStartArmed, playing, hasSrc, videoSrc: v?.src });
      return;
    }
    if (!v) {
      console.log("[VideoPlayer] Autostart waiting: no video element");
      return;
    }
    
    if (info) {
      const target = Math.max(1, info.targetBytes || 0);
      const ahead = Math.max(0, info.contiguousAhead || 0);
      const remaining = (info.fileLength ?? Infinity) - (info.playheadBytes ?? 0);
      const goal = Math.min(target, remaining);
      console.log("[VideoPlayer] Autostart check (with buffer info):", { target, ahead, goal, threshold: goal * AUTOSTART_THRESHOLD, ready: goal > 0 && ahead >= goal * AUTOSTART_THRESHOLD });
      if (goal > 0 && ahead >= goal * AUTOSTART_THRESHOLD) { 
        console.log("[VideoPlayer] AUTOSTARTING PLAYBACK (buffer info ready)!");
        v.play().catch(() => {}); 
        setAutoStartArmed(false); 
      }
      return;
    }
    
    const buffered = v.buffered;
    if (buffered.length > 0) {
      const bufferedEnd = buffered.end(buffered.length - 1);
      const bufferedAhead = bufferedEnd - v.currentTime;
      const minBufferSec = 3;
      console.log("[VideoPlayer] Autostart check (fallback):", { bufferedAhead, minBufferSec, ready: bufferedAhead >= minBufferSec, readyState: v.readyState });
      if (bufferedAhead >= minBufferSec && v.readyState >= 2) {
        console.log("[VideoPlayer] AUTOSTARTING PLAYBACK (fallback - video element ready)!");
        v.play().catch(() => {}); 
        setAutoStartArmed(false); 
      }
    }
  }, [info, playing, autoStartArmed]);

  const isSeriesPlayback = kind !== "movie" && !!seriesId;
  const seriesTitleDisplay = props.seriesTitle || props.title;
  const episodeBadge = isSeriesPlayback ? `S${String(curSeason).padStart(2, "0")}E${String(curEpisode).padStart(2, "0")}` : null;
  const nextEpisodeBadge = nextUp ? `S${String(nextUp.season).padStart(2, "0")}E${String(nextUp.episode).padStart(2, "0")}` : null;
  const showNextOverlay = Boolean(isSeriesPlayback && (nextUp || nextError));
  const progress = duration > 0 ? (time / duration) * 100 : 0;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // ---------- UI ----------
  return (
    <div ref={containerRef} className="group relative w-full aspect-video bg-black overflow-hidden select-none" onMouseMove={showUI} onMouseLeave={() => setVolumeHover(false)} onTouchStart={showUI}>
      {/* Cinematic gradients */}
      <div className={`absolute inset-0 pointer-events-none transition-opacity duration-700 z-10 ${uiVisible ? "opacity-100" : "opacity-0"}`}>
        <div className="absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-black/90 via-black/50 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-60 bg-gradient-to-t from-black via-black/70 to-transparent" />
      </div>

      {/* Video */}
      <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" src={!isElectron ? src || undefined : undefined} preload="auto" crossOrigin="anonymous" controls={false} style={isElectron ? { display: "none" } : undefined}
        onLoadStart={onLoadStart} onLoadedMetadata={onLoadedMetadata} onTimeUpdate={e => setTime((e.target as HTMLVideoElement).currentTime || 0)}
        onPlay={onPlay} onPause={onPause} onWaiting={onWaiting} onStalled={onStalled} onSeeking={onSeeking} onSeeked={onSeeked} onProgress={onProgress} onError={onError} onEnded={onEnded} onClick={togglePlay} playsInline>
        {activeSub && <track src={activeSub} kind="subtitles" srcLang={activeSubMeta?.lang || "en"} label={activeSubMeta?.label || "Subtitles"} default />}
      </video>

      {/* Top bar */}
      <div className={`absolute top-0 inset-x-0 z-20 px-5 md:px-8 py-5 flex items-start justify-between transition-all duration-500 ${uiVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4 pointer-events-none"}`}>
        <div className="space-y-1">
          {seriesTitleDisplay && <p className="text-[10px] uppercase tracking-[0.35em] text-white/50 font-medium">{seriesTitleDisplay}</p>}
          <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight drop-shadow-2xl">{props.title}</h1>
          <div className="flex items-center gap-3">
            {episodeBadge && <span className="px-2.5 py-0.5 rounded-md bg-white/15 text-[11px] font-semibold text-white/90 backdrop-blur-sm">{episodeBadge}</span>}
            {props.year && <span className="text-sm text-white/60">{props.year}</span>}
          </div>
        </div>
        {src && <button onClick={() => downloadM3U(src, props.title, props.year, activeSub || undefined)} className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm transition-all duration-200 hover:scale-105" title="Open in VLC"><MonitorPlay className="h-5 w-5 text-white" /></button>}
      </div>

      {/* Double-tap zones */}
      <div className="absolute inset-0 z-10" onDoubleClick={onDoubleTap} />

      {/* Tap hint */}
      {tapHint && (
        <div className={`absolute top-1/2 -translate-y-1/2 z-20 ${tapHint === "left" ? "left-8" : "right-8"}`}>
          <div className="flex flex-col items-center gap-1 animate-pulse">
            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
              {tapHint === "left" ? <SkipBack className="w-6 h-6 text-white" /> : <SkipForward className="w-6 h-6 text-white" />}
            </div>
            <span className="text-xs text-white font-medium">{tapHint === "left" ? "-10s" : "+10s"}</span>
          </div>
        </div>
      )}

      {/* Center play button when paused */}
      {!playing && !loadingMeta && !buffering && !errorMsg && (
        <div className="absolute inset-0 z-15 flex items-center justify-center">
          <button onClick={togglePlay} className="w-20 h-20 md:w-24 md:h-24 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center hover:bg-white/30 hover:scale-110 transition-all duration-300 shadow-2xl">
            <Play className="w-10 h-10 md:w-12 md:h-12 text-white ml-1" fill="white" />
          </button>
        </div>
      )}

      {/* Loading / Prebuffer Progress UI */}
      {(loadingMeta || (buffering && !playing)) && !errorMsg && (
        <div className="absolute inset-0 z-30 flex items-center justify-center">
          <div className="w-full max-w-md mx-4 p-6 rounded-2xl bg-black/90 backdrop-blur-md border border-white/10 shadow-2xl">
            {/* Header */}
            <div className="flex items-center gap-3 mb-5">
              <div className="relative w-10 h-10">
                <div className="absolute inset-0 rounded-full border-3 border-white/10" />
                <div className="absolute inset-0 rounded-full border-3 border-transparent border-t-red-500 animate-spin" />
              </div>
              <div>
                <h3 className="text-white font-semibold">
                  {!info ? "Connecting..." : info.targetBytes === 0 ? "Fetching metadata..." : "Prebuffering..."}
                </h3>
                <p className="text-xs text-white/50">
                  {!info ? "Finding peers and trackers" : info.targetBytes === 0 ? "Loading torrent info" : "Preparing for smooth playback"}
                </p>
              </div>
            </div>

            {/* Progress bar */}
            {info && info.targetBytes > 0 && (
              <>
                <div className="relative h-2 bg-white/10 rounded-full overflow-hidden mb-3">
                  <div 
                    className="absolute h-full bg-gradient-to-r from-red-600 to-red-500 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, (info.contiguousAhead / info.targetBytes) * 100)}%` }}
                  />
                  {/* Animated shimmer */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-white/5 rounded-lg p-3">
                    <div className="text-white/40 text-xs mb-1">Buffered</div>
                    <div className="text-white font-semibold">
                      {(info.contiguousAhead / (1024 * 1024)).toFixed(1)} MB
                      <span className="text-white/40 font-normal"> / {(info.targetBytes / (1024 * 1024)).toFixed(1)} MB</span>
                    </div>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3">
                    <div className="text-white/40 text-xs mb-1">Progress</div>
                    <div className="text-white font-semibold">
                      {Math.min(100, Math.round((info.contiguousAhead / info.targetBytes) * 100))}%
                      {info.contiguousAhead >= info.targetBytes * AUTOSTART_THRESHOLD && (
                        <span className="ml-2 text-green-400 text-xs">Ready!</span>
                      )}
                    </div>
                  </div>
                  {info.rollingBps != null && info.rollingBps > 0 && (
                    <div className="bg-white/5 rounded-lg p-3">
                      <div className="text-white/40 text-xs mb-1">Speed</div>
                      <div className="text-white font-semibold">
                        {info.rollingBps > 1024 * 1024 
                          ? `${(info.rollingBps / (1024 * 1024)).toFixed(1)} MB/s`
                          : `${(info.rollingBps / 1024).toFixed(0)} KB/s`
                        }
                      </div>
                    </div>
                  )}
                  {info.rollingBps != null && info.rollingBps > 0 && info.contiguousAhead < info.targetBytes && (
                    <div className="bg-white/5 rounded-lg p-3">
                      <div className="text-white/40 text-xs mb-1">ETA</div>
                      <div className="text-white font-semibold">
                        {(() => {
                          const remaining = info.targetBytes - info.contiguousAhead;
                          const eta = Math.ceil(remaining / info.rollingBps!);
                          return eta > 60 ? `${Math.floor(eta / 60)}m ${eta % 60}s` : `${eta}s`;
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                {/* File info */}
                {info.fileLength != null && info.fileLength > 0 && (
                  <div className="mt-3 pt-3 border-t border-white/10 text-xs text-white/40">
                    Total file: {(info.fileLength / (1024 * 1024 * 1024)).toFixed(2)} GB
                  </div>
                )}
              </>
            )}

            {/* No buffer info yet - show simple spinner */}
            {(!info || info.targetBytes === 0) && (
              <div className="flex items-center justify-center py-4">
                <div className="flex items-center gap-2 text-white/50 text-sm">
                  <div className="w-2 h-2 rounded-full bg-white/50 animate-pulse" />
                  <div className="w-2 h-2 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: "0.2s" }} />
                  <div className="w-2 h-2 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: "0.4s" }} />
                </div>
              </div>
            )}

            {/* VLC fallback hint */}
            {src && (
              <div className="mt-4 pt-4 border-t border-white/10">
                <button 
                  onClick={() => downloadM3U(src, props.title, props.year, activeSub || undefined)}
                  className="w-full py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/60 hover:text-white text-sm flex items-center justify-center gap-2 transition-colors"
                >
                  <MonitorPlay className="w-4 h-4" />
                  Can&apos;t wait? Open in VLC instead
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Small buffering indicator when playing */}
      {buffering && playing && !errorMsg && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 pointer-events-none">
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full border-4 border-white/10" />
            <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-white animate-spin" />
          </div>
        </div>
      )}

      {/* Error overlay */}
      {errorMsg && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="max-w-md mx-4 p-6 rounded-2xl bg-gradient-to-b from-zinc-900 to-black border border-white/10 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-red-500/20"><AlertTriangle className="w-6 h-6 text-red-400" /></div>
              <div><h3 className="text-lg font-semibold text-white">Playback Error</h3><p className="text-sm text-white/60">{errorMsg}</p></div>
            </div>
            {src && (
              <div className="p-4 rounded-xl bg-orange-500/10 border border-orange-500/20 mb-4">
                <p className="text-sm text-orange-200 mb-3 flex items-center gap-2"><MonitorPlay className="w-4 h-4" /> Try VLC Player</p>
                <button onClick={() => downloadM3U(src, props.title, props.year, activeSub || undefined)} className="w-full py-2.5 rounded-lg bg-orange-500 hover:bg-orange-400 text-black font-semibold flex items-center justify-center gap-2 transition-colors">
                  <Download className="w-4 h-4" />Download .m3u for VLC
                </button>
              </div>
            )}
            <button onClick={() => { videoRef.current?.load(); setErrorMsg(null); }} className="w-full py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium flex items-center justify-center gap-2 transition-colors">
              <RotateCcw className="w-4 h-4" />Retry
            </button>
          </div>
        </div>
      )}

      {/* Next episode overlay */}
      {showNextOverlay && (
        <div className="absolute bottom-32 right-4 md:right-8 z-30 w-80 p-5 rounded-2xl bg-black/80 backdrop-blur-md border border-white/10 shadow-2xl">
          {nextError ? (
            <>
              <p className="text-xs text-red-400 mb-2">Couldn&apos;t load next episode</p>
              <button onClick={() => prepareNextEpisode()} className="px-4 py-2 rounded-lg bg-white text-black font-semibold text-sm hover:bg-white/90 transition-colors">Retry</button>
            </>
          ) : nextUp && (
            <>
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-1">Up Next</p>
              <p className="text-white font-semibold text-lg">{nextUp.title || seriesTitleDisplay}</p>
              {nextEpisodeBadge && <p className="text-sm text-white/60 mt-0.5">{nextEpisodeBadge}</p>}
              <div className="mt-3 h-1 rounded-full bg-white/20 overflow-hidden"><div className="h-full bg-white transition-all duration-1000" style={{ width: `${(nextUp.countdown / 10) * 100}%` }} /></div>
              <p className="text-xs text-white/40 mt-2">Playing in {nextUp.countdown}s</p>
              <div className="flex gap-2 mt-4">
                <button onClick={() => beginNextEpisode(nextUp)} className="flex-1 py-2.5 rounded-lg bg-white text-black font-semibold text-sm hover:bg-white/90 transition-colors">Play Now</button>
                <button onClick={() => setAutoplayNext(false)} className="px-4 py-2.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 transition-colors">Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Bottom controls */}
      <div className={`absolute bottom-0 inset-x-0 z-20 transition-all duration-500 ${uiVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}>
        {/* Progress bar */}
        <div ref={progressRef} className="mx-4 md:mx-8 mb-2 group/progress cursor-pointer py-2"
          onMouseMove={(e) => { const rect = progressRef.current?.getBoundingClientRect(); if (!rect || !duration) return; const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width)); setSeekPreview({ x, time: (x / rect.width) * duration }); }}
          onMouseLeave={() => setSeekPreview(null)}
          onClick={(e) => { const rect = progressRef.current?.getBoundingClientRect(); if (!rect || !duration) return; const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width)); const t = (x / rect.width) * duration; const v = videoRef.current; if (v) { v.currentTime = t; setTime(t); } }}>
          {seekPreview && <div className="absolute -top-8 z-50 pointer-events-none" style={{ left: seekPreview.x, transform: "translateX(-50%)" }}><div className="px-2 py-1 rounded bg-white text-black text-xs font-semibold shadow-lg">{formatTime(seekPreview.time)}</div></div>}
          <div className="relative h-1 group-hover/progress:h-1.5 bg-white/20 rounded-full transition-all overflow-hidden">
            {bufferedRanges.map(([s, e], i) => <div key={i} className="absolute h-full bg-white/30" style={{ left: `${(s / (duration || 1)) * 100}%`, width: `${((e - s) / (duration || 1)) * 100}%` }} />)}
            <div className="absolute h-full bg-red-600 rounded-full transition-all" style={{ width: `${progress}%` }} />
            <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-red-600 opacity-0 group-hover/progress:opacity-100 transition-opacity shadow-lg scale-0 group-hover/progress:scale-100" style={{ left: `calc(${progress}% - 6px)` }} />
          </div>
        </div>

        {/* Control buttons */}
        <div className="flex items-center gap-1 md:gap-2 px-4 md:px-8 pb-4 md:pb-6">
          <button onClick={togglePlay} className="p-2 rounded-full hover:bg-white/10 transition-colors">
            {playing ? <Pause className="w-7 h-7 text-white" fill="white" /> : <Play className="w-7 h-7 text-white ml-0.5" fill="white" />}
          </button>
          <button onClick={() => seekBy(-SEEK_LARGE)} className="p-2 rounded-full hover:bg-white/10 transition-colors hidden sm:block"><SkipBack className="w-5 h-5 text-white" /></button>
          <button onClick={() => seekBy(SEEK_LARGE)} className="p-2 rounded-full hover:bg-white/10 transition-colors hidden sm:block"><SkipForward className="w-5 h-5 text-white" /></button>

          {/* Volume */}
          <div className="relative flex items-center" onMouseEnter={() => setVolumeHover(true)} onMouseLeave={() => setVolumeHover(false)}>
            <button onClick={() => { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted); if (!v.muted && volume === 0) setVolume(0.5); } }} className="p-2 rounded-full hover:bg-white/10 transition-colors">
              <VolumeIcon className="w-5 h-5 text-white" />
            </button>
            <div className={`overflow-hidden transition-all duration-300 ${volumeHover ? "w-20 opacity-100 ml-1" : "w-0 opacity-0"}`}>
              <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={(e) => setVolume(Number(e.target.value))}
                className="w-full h-1 rounded-full appearance-none cursor-pointer bg-white/30 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0" />
            </div>
          </div>

          {/* Time */}
          <div className="text-white text-sm font-medium tabular-nums ml-2">
            <span>{formatTime(time)}</span>
            <span className="text-white/40 mx-1">/</span>
            <span className="text-white/60">{formatTime(duration)}</span>
          </div>

          <div className="flex-1" />

          {/* Subtitles */}
          <div className="relative">
            <button onClick={() => setSubsOpen(v => !v)} className={`p-2 rounded-full transition-colors ${activeSub ? "bg-white/20" : "hover:bg-white/10"}`}><Captions className="w-5 h-5 text-white" /></button>
            {subsOpen && (
              <div className="absolute bottom-full right-0 mb-2 w-48 py-2 rounded-xl bg-zinc-900/95 backdrop-blur-sm border border-white/10 shadow-2xl">
                <button onClick={() => { setActiveSub(""); setSubsOpen(false); }} className={`w-full px-4 py-2.5 text-left text-sm ${!activeSub ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5"}`}>Off</button>
                {subs.map(s => <button key={s.url} onClick={() => { setActiveSub(s.url); setSubsOpen(false); }} className={`w-full px-4 py-2.5 text-left text-sm ${activeSub === s.url ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5"}`}>{flag(s.lang)} {s.label}</button>)}
              </div>
            )}
          </div>

          <button onClick={toggleFullscreen} className="p-2 rounded-full hover:bg-white/10 transition-colors">
            {fs ? <Minimize className="w-5 h-5 text-white" /> : <Maximize className="w-5 h-5 text-white" />}
          </button>
        </div>
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
