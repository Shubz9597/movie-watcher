"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Maximize, Minimize, Pause, Play, Volume2, VolumeX,
  Captions, SkipBack, SkipForward, Loader2, AlertTriangle
} from "lucide-react";

// ---------- Hardcoded VOD endpoints ----------
const VOD_BASE = "http://localhost:4001";
const STREAM_BASE = `${VOD_BASE}/stream`;
const BUFFER_BASE = `${VOD_BASE}/buffer`;
const WATCH_BASE  = `${VOD_BASE}/watch`;
const PREFETCH_URL = `${VOD_BASE}/prefetch`;

const AUTOSTART_THRESHOLD = 0.9; // 90% of target buffer
const HEARTBEAT_MS = 5000;

// ---------- Types ----------
type Subtrack = { label: string; lang: string; url: string; source: "torrent" | "opensub" };

type Props = {
  // legacy magnet flow (kept)
  magnet?: string;
  fileIndex?: number;
  cat?: "movie" | "tv" | "anime";

  // NEW: session-friendly props (optional; will be read from URL if missing)
  streamUrl?: string;
  seriesId?: string;
  season?: number;
  episode?: number;
  kind?: "movie" | "tv" | "anime";
  seriesTitle?: string;
  estRuntimeMin?: number;

  // UI niceties you already had
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
  const newId =
    (crypto as any)?.randomUUID?.() ??
    (Math.random().toString(36).slice(2) + Date.now().toString(36));
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
    .filter(([mime]) => (window as any).MediaSource?.isTypeSupported?.(mime))
    .map(([, k]) => k)
    .sort()
    .join(",");
  return `caps:${supported || "h264"}|v1`;
}

function readQS(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

function qsString(name: string): string | undefined {
  const v = readQS().get(name);
  return v ?? undefined;
}
function qsInt(name: string): number | undefined {
  const v = readQS().get(name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

type BufInfo = {
  targetBytes: number;
  contiguousAhead: number;
  rollingBps?: number;
  targetAheadSec?: number;
  playheadBytes?: number;
  fileLength?: number;
};

// ---------------- Local buffer-info hook ----------------
export function useBufferInfo(opts: {
  baseUrl?: string | null;
  magnet?: string;
  cat: string;
  fileIndex?: number | null;
  streamUrl: string; // used for header-probe fallback
  pollMs?: number;
}) {
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

    const stopSSE = () => { try { es?.close(); } catch {} es = null; };

    const snapOnce = async (): Promise<boolean> => {
      try {
        const r = await fetch(`${base}?${qs}`, { cache: "no-store" });
        if (r.ok && r.headers.get("content-type")?.includes("application/json")) {
          apply(await r.json());
          return true;
        }
      } catch {}
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
        const cr = r2.headers.get("Content-Range");
        const total = cr?.split("/")?.[1];
        const fileLen = total ? Number(total) : undefined;
        apply({
          targetBytes: tgt,
          contiguousAhead: ahead,
          fileLength: Number.isFinite(fileLen) ? fileLen : undefined,
        });
      } catch {}
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
        const url = `${base}?${qs}&sse=1`;
        es = new EventSource(url, { withCredentials: false });
        es.onmessage = (e) => {
          try { apply(JSON.parse(e.data)); } catch {}
        };
        es.onerror = () => { stopSSE(); startPolling(); };
      } catch {
        startPolling();
      }
    };

    startSSE();

    return () => {
      aborted = true;
      stopSSE();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [baseUrl, magnet, cat, fileIndex, streamUrl, pollMs]);

  return info;
}

export default function VideoPlayer(props: Props) {
  // ---------- derive identifiers ----------
  const kind = (props.kind ?? (qsString("kind") as Props["kind"])) ?? props.cat ?? "movie";
  const seriesId = props.seriesId ?? qsString("seriesId");
  const initialSeason = props.season ?? qsInt("season") ?? (kind === "movie" ? 0 : 1);
  const initialEpisode = props.episode ?? qsInt("episode") ?? (kind === "movie" ? 0 : 1);
  const estRuntimeMin = props.estRuntimeMin ?? (kind === "movie" ? 120 : 42);

  // local S/E we can bump on autoplay-next
  const [curSeason, setCurSeason] = useState<number>(initialSeason);
  const [curEpisode, setCurEpisode] = useState<number>(initialEpisode);

  const subjectId = useMemo(getDeviceId, []);
  const [profileHash, setProfileHash] = useState("caps:h264|v1");
  useEffect(() => { computeProfileHash().then(setProfileHash).catch(()=>{}); }, []);

  // ---------- core refs & state ----------
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const [bufferedRanges, setBufferedRanges] = useState<Array<[number, number]>>([]);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const leaseRef = useRef<string | null>(null);

  const progressRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [autoStartArmed, setAutoStartArmed] = useState(true);

  // ---------- choose initial SOURCE (streamUrl or magnet) ----------
  const [src, setSrc] = useState<string>("");

  useEffect(() => {
    // session flow first
    const qsStream = qsString("streamUrl");
    if (props.streamUrl || qsStream) {
      const base = props.streamUrl ?? qsStream!;
      const withCat = base.includes("?") ? `${base}&cat=${kind}` : `${base}?cat=${kind}`;
      setSrc(withCat);
      return;
    }
    // magnet fallback
    const magnet = props.magnet ?? qsString("src");
    if (magnet) {
      const sp = new URLSearchParams();
      sp.set("cat", kind);
      sp.set("magnet", magnet);
      const fi = props.fileIndex ?? qsInt("fileIndex");
      if (fi != null) sp.set("fileIndex", String(fi));
      setSrc(`${STREAM_BASE}?${sp.toString()}`);
    }
  }, [props.streamUrl, props.magnet, props.fileIndex, kind]);

  // ---------- prefetch & warm ----------
  useEffect(() => {
    const magnet = props.magnet ?? qsString("src");
    const fi = props.fileIndex ?? qsInt("fileIndex");
    if (!magnet) return;
    const sp = new URLSearchParams();
    sp.set("cat", kind);
    sp.set("magnet", magnet);
    if (fi != null) sp.set("fileIndex", String(fi));
    fetch(`${PREFETCH_URL}?${sp.toString()}`, { cache: "no-store" }).catch(() => {});
  }, [props.magnet, props.fileIndex, kind]);

  useEffect(() => {
    // tell Go to warm but not play
    const magnet = props.magnet ?? qsString("src");
    const fi = props.fileIndex ?? qsInt("fileIndex");
    const sp = new URLSearchParams({ cat: kind });
    if (magnet) sp.set("magnet", magnet);
    if (fi != null) sp.set("fileIndex", String(fi));
    fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=pause`).catch(() => {});
    setAutoStartArmed(true);
  }, [props.magnet, props.fileIndex, kind]);

  // ---------- subtitles (unchanged: using your Next API) ----------
  useEffect(() => { setActiveSub(""); setSubs([]); }, [props.imdbId, props.magnet]);

  const preferLangsKey = useMemo(
    () => (Array.isArray(props.preferLangs) && props.preferLangs.length
      ? props.preferLangs.join(",")
      : DEFAULT_PREF_LANGS.join(",")),
    [Array.isArray(props.preferLangs) ? props.preferLangs.join(",") : ""]
  );
  const preferLangsArr = useMemo(() => preferLangsKey.split(","), [preferLangsKey]);
  const subsCacheRef = useRef<Map<string, Subtrack[]>>(new Map());

  useEffect(() => {
    const imdbId = props.imdbId;
    if (!imdbId) return;
    let cancelled = false;
    const ac = new AbortController();

    const cacheKey = `${imdbId}|${preferLangsKey}`;
    const useAndPick = (list: Subtrack[]) => {
      if (cancelled) return;
      setSubs(list);
      const pick =
        preferLangsArr.map(l => list.find(s => s.lang === l)).find(Boolean) || list[0];
      setActiveSub(prev => prev || pick?.url || "");
    };

    (async () => {
      const cached = subsCacheRef.current.get(cacheKey);
      if (cached?.length) { useAndPick(cached); return; }

      const sp = new URLSearchParams({ imdbId, langs: preferLangsKey });
      const res = await fetch(`/api/subtitles/opensub?${sp.toString()}`, { signal: ac.signal });
      const j = await res.json().catch(() => ({ subtitles: [] }));
      const list: Subtrack[] = j.subtitles || [];

      subsCacheRef.current.set(cacheKey, list);
      if (list.length) useAndPick(list);
      else if (!cancelled) { setSubs([]); setActiveSub(""); }
    })().catch(() => {});

    return () => { cancelled = true; ac.abort(); };
  }, [props.imdbId, preferLangsKey, preferLangsArr]);

  const activeSubMeta = useMemo(
    () => subs.find(s => s.url === activeSub),
    [subs, activeSub]
  );
  const resolvedActiveSub = activeSub;

  // ---------- auto-hide controls ----------
  const showUI = () => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = setTimeout(() => setUiVisible(false), 2500);
  };
  useEffect(() => { showUI(); /* eslint-disable-next-line */ }, [playing]);

  // ---------- watch lease ----------
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
          const lid = leaseRef.current;
          if (!lid) return;
          fetch(`${WATCH_BASE}/ping?leaseId=${encodeURIComponent(lid)}`, { method: "POST", keepalive: true })
            .catch(() => {});
        }, 10_000);
        (window as any).__watchPing = id;
      } catch {}
    })();

    return () => {
      stopped = true;
      const ping = (window as any).__watchPing;
      if (ping) { clearInterval(ping); (window as any).__watchPing = null; }
      const lid = leaseRef.current;
      if (lid) {
        const data = new Blob([`leaseId=${lid}`], { type: "text/plain" });
        navigator.sendBeacon(`${WATCH_BASE}/close`, data);
      }
    };
  }, [props.magnet, props.fileIndex, kind]);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current; if (!v) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k": e.preventDefault(); togglePlay(); break;
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
  }, [volume]);

  // ---------- player helpers ----------
  const togglePlay = () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
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
    if (!document.fullscreenElement) { await el.requestFullscreen(); setFs(true); }
    else { await document.exitFullscreen(); setFs(false); }
  };
  const onDoubleTap = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width / 2) seekBy(-SEEK_LARGE); else seekBy(SEEK_LARGE);
  };
  const updateHover = (clientX: number) => {
    const el = progressRef.current; if (!el || !duration) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const t = (x / rect.width) * duration;
    setHoverX(x);
    setHoverTime(t);
  };
  function explainMediaError(v: HTMLVideoElement | null) {
    const err = v?.error;
    if (!err) return null;
    switch (err.code) {
      case err.MEDIA_ERR_ABORTED: return "Playback aborted (user or browser).";
      case err.MEDIA_ERR_NETWORK: return "Network error while fetching the stream.";
      case err.MEDIA_ERR_DECODE: return "Decode failed (codec/bitstream).";
      case err.MEDIA_ERR_SRC_NOT_SUPPORTED:
      default: return "Source not supported by this browser.";
    }
  }
  async function probeStreamHead(url: string) {
    try {
      const r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
      const fileName = r.headers.get("X-File-Name") ?? "";
      const contentType = r.headers.get("Content-Type") ?? "";
      return { ok: r.ok, status: r.status, fileName, contentType };
    } catch {
      return { ok: false, status: 0, fileName: "", contentType: "" };
    }
  }

  // ---------- buffer ranges ----------
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

  // ---------- video events ----------
  const onLoadStart = () => { setLoadingMeta(true); setErrorMsg(null); setBuffering(false); };
  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setDuration((e.target as HTMLVideoElement).duration || 0);
    setLoadingMeta(false);
    pullBuffered();
  };
  const onWaiting = () => setBuffering(true);
  const onPlay = () => {
    setBuffering(false); setErrorMsg(null); setPlaying(true);
    const sp = new URLSearchParams({ cat: kind });
    const magnet = props.magnet ?? qsString("src");
    const fi = props.fileIndex ?? qsInt("fileIndex");
    if (fi != null) sp.set("fileIndex", String(fi));
    if (magnet) sp.set("magnet", magnet);
    fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=play`).catch(() => {});
  };
  const onPause = () => {
    setPlaying(false);
    const sp = new URLSearchParams({ cat: kind });
    const magnet = props.magnet ?? qsString("src");
    const fi = props.fileIndex ?? qsInt("fileIndex");
    if (fi != null) sp.set("fileIndex", String(fi));
    if (magnet) sp.set("magnet", magnet);
    fetch(`${BUFFER_BASE}/state?${sp.toString()}&state=pause`).catch(() => {});
  };
  const onStalled = () => setBuffering(true);
  const onSeeking = () => setBuffering(true);
  const onSeeked = async () => {
    setBuffering(false); pullBuffered(); const v = videoRef.current;
    if (v && v.paused && Number.isFinite(v.duration) && v.duration > 0 && src) {
      try {
        const r = await fetch(src, { headers: { Range: "bytes=0-0" }, cache: "no-store" });
        const cr = r.headers.get("Content-Range"); // "bytes 0-0/123456"
        const total = cr?.split("/")?.[1];
        const totalBytes = total ? Number(total) : NaN;
        if (Number.isFinite(totalBytes) && totalBytes > 0) {
          const posByte = Math.max(0, Math.floor((v.currentTime / v.duration) * totalBytes));
          fetch(src, { headers: { Range: `bytes=${posByte}-${posByte}` }, cache: "no-store" }).catch(() => {});
        }
      } catch {}
    }
  };
  const onProgress = () => {
    pullBuffered();
    const v = videoRef.current; if (!v) return;
    const ahead = Math.max(0, bufferedEnd - v.currentTime);
    if (ahead >= MIN_BUFFER_SEC || v.readyState >= 3) setBuffering(false);
  };
  const onError = async () => {
    const v = videoRef.current;
    const basic = explainMediaError(v);
    const head = src ? await probeStreamHead(src) : { ok: false, status: 0, fileName: "", contentType: "" };

    let help = basic ?? "Playback error.";
    if (head.status === 504) help += " Server timed out fetching torrent metadata.";
    if (/\.mkv$/i.test(head.fileName) || /video\/x-matroska/.test(head.contentType)) {
      help += " MKV container may be HEVC/H.265 which some browsers can't decode. Try Edge or open in VLC.";
    }
    setErrorMsg(help);
    setBuffering(false);
    setPlaying(false);
  };

  // ---------- resume seek ----------
  useEffect(() => {
    if (!seriesId) return;
    const el = videoRef.current;
    if (!el) return;
    fetch(`${VOD_BASE}/v1/resume?subjectId=${encodeURIComponent(subjectId)}&seriesId=${encodeURIComponent(seriesId)}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then((j) => {
        if (!j || j.found === false) return;
        if (j.season !== curSeason || j.episode !== curEpisode) return;
        const pos = Number(j.position_s ?? 0);
        const onMeta = () => { try { el.currentTime = Math.max(pos, 0); } catch {} el.removeEventListener("loadedmetadata", onMeta); };
        el.addEventListener("loadedmetadata", onMeta);
      })
      .catch(()=>{});
  }, [seriesId, subjectId, curSeason, curEpisode]);

  // ---------- heartbeat ----------
  useEffect(() => {
    if (!seriesId) return;
    const v = videoRef.current;
    if (!v) return;
    const t = setInterval(() => {
      if (!v.duration || isNaN(v.duration)) return;
      const body = {
        subjectId,
        seriesId,
        season: curSeason,
        episode: curEpisode,
        position_s: Math.floor(v.currentTime),
        duration_s: Math.floor(v.duration),
      };
      fetch(`${VOD_BASE}/v1/session/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(()=>{});
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [seriesId, curSeason, curEpisode, subjectId]);

  // ---------- autoplay next ----------
  const onEnded = async () => {
    if (!seriesId || kind === "movie") return;
    try {
      const body = {
        seriesId,
        seriesTitle: props.seriesTitle ?? props.title ?? "",
        kind,
        season: curSeason,
        episode: curEpisode,
        profileHash,
        estRuntimeMin,
      };
      const r = await fetch(`${VOD_BASE}/v1/session/ended`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) return;
      const out = await r.json();
      const next = String(out.streamUrl || "");
      const delay = Number(out.autoplayIn) || 10;

      if (next) {
        const withCat = next.includes("?") ? `${next}&cat=${kind}` : `${next}?cat=${kind}`;
        setSrc(withCat);
        setCurEpisode(e => e + 1); // naive bump; backend already chose next pick
        setTimeout(() => videoRef.current?.play().catch(()=>{}), delay * 1000);
      }
    } catch {}
  };

  // ---------- volume bind ----------
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    v.volume = volume;
    if (volume === 0 && !v.muted) v.muted = true;
    if (volume > 0 && v.muted) v.muted = false;
    setMuted(v.muted);
  }, [volume]);

  // ---------- server buffer info ----------
  const info = useBufferInfo({
    baseUrl: VOD_BASE,
    magnet: props.magnet ?? qsString("src"),
    cat: kind,
    fileIndex: props.fileIndex ?? qsInt("fileIndex"),
    streamUrl: src,
    pollMs: 1000,
  });

  const serverBar = useMemo(() => {
    const fileLen = info?.fileLength;
    if (!fileLen || fileLen <= 0) return null;

    const estPlayhead =
      info?.playheadBytes ??
      (duration > 0 ? Math.floor((time / duration) * fileLen) : null);

    const aheadB = info?.contiguousAhead;
    if (estPlayhead == null || aheadB == null) return null;

    const leftPct = Math.max(0, Math.min(100, (estPlayhead / fileLen) * 100));
    const widthPct = Math.max(0, Math.min(100 - leftPct, (aheadB / fileLen) * 100));
    return { leftPct, widthPct };
  }, [info, time, duration]);

  useEffect(() => {
    if (!autoStartArmed || playing) return;
    const v = videoRef.current;
    if (!v || !info) return;

    const target = Math.max(1, info.targetBytes || 0);
    const ahead = Math.max(0, info.contiguousAhead || 0);

    const remaining = (info.fileLength ?? Infinity) - (info.playheadBytes ?? 0);
    const goal = Math.min(target, remaining);

    if (goal > 0 && ahead >= goal * AUTOSTART_THRESHOLD) {
      v.play().catch(() => {});
      setAutoStartArmed(false);
    }
  }, [info, playing, autoStartArmed]);

  // ---------- UI ----------
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
          <div className="text-lg font-semibold">{props.title}</div>
          {props.year ? <div className="text-xs opacity-70">{props.year}</div> : null}
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
        src={src}
        preload="auto"
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
        onEnded={onEnded}
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

      {/* Loading / Buffering overlay */}
      {(loadingMeta || buffering) && !errorMsg ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 rounded-xl bg-black/60 px-3 py-2 text-white text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {loadingMeta ? "Loading video…" : "Buffering…"}
          </div>
        </div>
      ) : null}

      {/* Error overlay */}
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
              {src ? (
                <a className="underline text-white/90 text-xs" href={src} target="_blank" rel="noreferrer">
                  Open stream URL
                </a>
              ) : null}
              {/* keep your VLC helper if you want */}
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

          {/* Fullscreen duplicate */}
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
          {/* Buffered segments */}
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

          {/* Server-side buffered-ahead */}
          {serverBar ? (
            <div
              className="absolute top-1/2 -translate-y-1/2 h-1 bg-white/40 rounded pointer-events-none"
              style={{ left: `${serverBar.leftPct}%`, width: `${serverBar.widthPct}%` }}
            />
          ) : null}

          {/* Seek slider */}
          <input
            className="absolute inset-x-0 top-1/2 -translate-y-1/2 w-full h-2 bg-transparent
               appearance-none cursor-pointer z-10"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            onChange={(e) => {
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

        {/* Tiny debug footer */}
        <div className="mt-1 text-[10px] text-white/60 truncate">
          stream: {src}
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

/* slider styles */
<style jsx>{`
  input[type="range"] { outline: none; }
  /* WebKit */
  input[type="range"]::-webkit-slider-runnable-track { background: transparent; height: 8px; }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 14px; height: 14px; border-radius: 9999px; background: white; margin-top: -3px;
    box-shadow: 0 0 0 2px rgba(0,0,0,.15);
  }
  /* Firefox */
  input[type="range"]::-moz-range-track { background: transparent; height: 8px; }
  input[type="range"]::-moz-range-thumb {
    width: 14px; height: 14px; border-radius: 9999px; background: white; border: none;
    box-shadow: 0 0 0 2px rgba(0,0,0,.15);
  }
`}</style>
