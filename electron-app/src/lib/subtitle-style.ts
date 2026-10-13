// Which subtitle suits the audio being played, remembered per show.
//
// Dual-audio releases (English dub + Japanese) usually carry English
// subtitles that translate the Japanese, while viewers of the dub want its
// own script. The server matches the dub's script to the video (a download's
// "Dub" subtitle file, or /subtitles/matched for streams and older
// downloads); these helpers pick between them.
import { isDubTrack, isFullDialogueTrack, languageNameForCode, trackLanguageName } from './track-labels.ts';

export type SubtitleStyle = 'dub' | 'regular' | 'off';
export type ShowPlaybackPrefs = { audioLanguage?: string; subtitle?: SubtitleStyle };
type Track = { id: number; label?: string };

const SHOW_PREFS_KEY = 'torwatch_show_playback_v1';
const MATCHED_KEY = 'torwatch_matched_subtitles_v1';
const MATCHED_LIMIT = 40;

/** Languages (English names) of a video's audio tracks. */
export function audioLanguages(tracks: ReadonlyArray<Track>): string[] {
  return [...new Set(tracks.map((track) => trackLanguageName(track.label)).filter(Boolean))];
}

/** The style to use without a choice for this video: the show's remembered
 *  one, else the dub's script when the audio is the subtitle language of a
 *  dual-audio release, else regular subtitles. */
export function defaultSubtitleStyle(show: ShowPlaybackPrefs | null, audioLanguage: string, languages: string[], subtitleLang: string): SubtitleStyle {
  if (show?.subtitle) return show.subtitle;
  const wanted = languageNameForCode(subtitleLang);
  return wanted && audioLanguage === wanted && languages.length > 1 ? 'dub' : 'regular';
}

/** The track of a style: a dub track in the language, or the first
 *  full-dialogue track that is not one. */
export function subtitleTrackFor<T extends Track>(tracks: ReadonlyArray<T>, subtitleLang: string, style: SubtitleStyle): T | null {
  if (style === 'off') return null;
  if (style === 'dub') {
    const wanted = languageNameForCode(subtitleLang);
    return tracks.find((track) => isDubTrack(track.label) && trackLanguageName(track.label) === wanted) ?? null;
  }
  return tracks.find((track) => !isDubTrack(track.label) && isFullDialogueTrack(track.label, subtitleLang)) ?? null;
}

/** The style a chosen subtitle track stands for. */
export function styleOfTrack(label: string | undefined): SubtitleStyle {
  return isDubTrack(label) ? 'dub' : 'regular';
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || 'null');
    return value && typeof value === 'object' ? value as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage, choices simply are not remembered.
  }
}

export function readShowPlaybackPrefs(showKey: string | null): ShowPlaybackPrefs | null {
  if (!showKey) return null;
  const prefs = readJSON<Record<string, ShowPlaybackPrefs>>(SHOW_PREFS_KEY, {})[showKey];
  return prefs && typeof prefs === 'object' ? prefs : null;
}

export function saveShowPlaybackPrefs(showKey: string | null, patch: ShowPlaybackPrefs): void {
  if (!showKey) return;
  const all = readJSON<Record<string, ShowPlaybackPrefs>>(SHOW_PREFS_KEY, {});
  all[showKey] = { ...all[showKey], ...patch };
  writeJSON(SHOW_PREFS_KEY, all);
}

/** A download's matched dub subtitle, kept for offline playback. */
export function cachedMatchedSubtitle(downloadId: string): string | null {
  const entry = readJSON<Record<string, { vtt: string; at: number }>>(MATCHED_KEY, {})[downloadId];
  return entry && typeof entry.vtt === 'string' ? entry.vtt : null;
}

export function cacheMatchedSubtitle(downloadId: string, vtt: string): void {
  const all = readJSON<Record<string, { vtt: string; at: number }>>(MATCHED_KEY, {});
  all[downloadId] = { vtt, at: Date.now() };
  const newest = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MATCHED_LIMIT);
  writeJSON(MATCHED_KEY, Object.fromEntries(newest));
}

export function forgetMatchedSubtitle(downloadId: string): void {
  const all = readJSON<Record<string, { vtt: string; at: number }>>(MATCHED_KEY, {});
  if (!(downloadId in all)) return;
  delete all[downloadId];
  writeJSON(MATCHED_KEY, all);
}
