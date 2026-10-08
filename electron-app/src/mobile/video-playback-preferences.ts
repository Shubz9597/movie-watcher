import type { SubtitleCue, SubtitleFormat } from '../lib/subtitle-parser.ts';

export type SavedTrack = { id: number; label?: string; language?: string };
export type SavedSubtitle =
  | { kind: 'off' }
  | { kind: 'embedded'; track: SavedTrack }
  | { kind: 'external'; url: string; format: SubtitleFormat; label?: string; language?: string };

export type VideoPlaybackPreferences = {
  subtitle: SavedSubtitle | null;
  subtitleDelay: number;
  audioTrack: SavedTrack | null;
  audioDelay: number;
};

export function videoPlaybackPreferenceKey(input: {
  origin: string; magnet: string; downloadId?: string; cat: string;
  fileIndex?: number; season: number; episode: number;
}): string | null {
  if (input.downloadId) return `mw_video_settings_v1:${JSON.stringify(['download', input.downloadId])}`;
  if (!input.magnet.trim()) return null;
  // Tracker/title changes in the magnet do not make this a different video.
  let source = input.magnet.trim();
  try {
    const magnet = new URL(source);
    if (magnet.protocol === 'magnet:') {
      const hash = magnet.searchParams.getAll('xt').find(value => /^urn:bt(?:ih|mh):/i.test(value));
      if (hash) source = hash.toLowerCase();
    }
  } catch { /* Retain the exact source when it is not a magnet URL. */ }
  return `mw_video_settings_v1:${JSON.stringify([
    input.origin.replace(/\/+$/, ''), source, input.cat, input.fileIndex ?? 0, input.season, input.episode,
  ])}`;
}

export function clampPlaybackDelay(value: number): number {
  return Number.isFinite(value) ? Math.max(-30, Math.min(30, Math.round(value * 10) / 10)) : 0;
}

function readTrack(value: unknown): SavedTrack | null {
  if (!value || typeof value !== 'object') return null;
  const track = value as Record<string, unknown>;
  if (!Number.isInteger(track.id) || Number(track.id) < 0) return null;
  return {
    id: Number(track.id),
    ...(typeof track.label === 'string' ? { label: track.label } : {}),
    ...(typeof track.language === 'string' ? { language: track.language } : {}),
  };
}

export function readVideoPlaybackPreferences(key: string | null): VideoPlaybackPreferences | null {
  if (!key) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    if (!stored || stored.version !== 1) return null;
    let subtitle: SavedSubtitle | null = null;
    const selection = stored.subtitle;
    if (selection?.kind === 'off') subtitle = { kind: 'off' };
    if (selection?.kind === 'embedded') {
      const track = readTrack(selection.track);
      if (track) subtitle = { kind: 'embedded', track };
    }
    if (selection?.kind === 'external' && typeof selection.url === 'string' && selection.url &&
        ['vtt', 'srt', 'ass', 'ssa'].includes(selection.format)) {
      subtitle = {
        kind: 'external', url: selection.url, format: selection.format,
        ...(typeof selection.label === 'string' ? { label: selection.label } : {}),
        ...(typeof selection.language === 'string' ? { language: selection.language } : {}),
      };
    }
    return {
      subtitle,
      subtitleDelay: clampPlaybackDelay(stored.subtitleDelay),
      audioTrack: readTrack(stored.audioTrack),
      audioDelay: clampPlaybackDelay(stored.audioDelay),
    };
  } catch { return null; }
}

export function saveVideoPlaybackPreferences(key: string | null, preferences: VideoPlaybackPreferences): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ version: 1, ...preferences }));
  } catch { /* Playback remains usable when device storage is unavailable. */ }
}

/** IDs can change when a native engine enumerates the same file again. */
export function matchingSavedTrack<T extends SavedTrack>(tracks: T[], saved: SavedTrack): T | null {
  const matches = (track: T) => (!saved.label || track.label === saved.label)
    && (!saved.language || track.language === saved.language);
  const byId = tracks.find(track => track.id === saved.id && matches(track));
  if (byId) return byId;
  if (!saved.label && !saved.language) return null;
  const byDescription = tracks.filter(matches);
  return byDescription.length === 1 ? byDescription[0] : null;
}

/** Positive delay displays subtitles later; negative delay brings them forward. */
export function subtitleCueAtTime(cues: SubtitleCue[], time: number, delay: number): SubtitleCue | null {
  const subtitleTime = time - delay;
  return cues.find(cue => subtitleTime >= cue.start && subtitleTime <= cue.end) ?? null;
}
