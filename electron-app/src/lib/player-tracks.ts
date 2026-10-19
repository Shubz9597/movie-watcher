// The desktop player's audio and subtitle tracks, named and picked the way
// the phone does (lib/track-labels, lib/subtitle-style). The server lists a
// video's own tracks (/media/tracks) in container order, which is how mpv
// numbers them: audio 1, 2, … and subtitles 1, 2, ….
import { audioLanguages, defaultSubtitleStyle, subtitleTrackFor, type ShowPlaybackPrefs } from './subtitle-style.ts';
import { trackLanguageName } from './track-labels.ts';

export type MediaTrack = {
  language?: string;
  title?: string;
  codec?: string;
  channels?: number;
  default?: boolean;
  forced?: boolean;
  cc?: boolean;
};

/** A player track: mpv's id and a label in the "Title - [Language]" form
 *  the naming helpers read. `styled`: an ASS track with positioned signs or
 *  karaoke, drawn as its author styled it; every other text track gets the
 *  app's subtitle box (as on the phone). */
export type PlayerTrack = { id: number; label: string; default: boolean; styled: boolean };

// As the server's (downloads/embedded_subtitles.go): whole words, so
// "Subtitles" and "Dubtitles" are not "Titles".
const STYLED_TITLE = /\b(signs?|songs?|stylized|styled|karaoke|titles|typeset|forced)\b/i;
const PLAIN_TITLE = /\b(dub|dubs|dubbed|dubtitles|dialogue|dialog|full|cc|sdh)\b/i;

function styledTrack(track: MediaTrack): boolean {
  const codec = (track.codec ?? '').toLowerCase();
  if (codec !== 'ass' && codec !== 'ssa') return false;
  const title = track.title ?? '';
  return STYLED_TITLE.test(title) || !PLAIN_TITLE.test(title);
}

export function playerTracks(tracks: ReadonlyArray<MediaTrack> | undefined): PlayerTrack[] {
  return (tracks ?? []).map((track, index) => {
    const language = (track.language ?? '').trim();
    const title = (track.title ?? '').trim() || (track.cc ? 'SDH' : track.forced ? 'Forced' : '');
    const label = language && title ? `${title} - [${language}]` : language || title;
    return { id: index + 1, label, default: Boolean(track.default), styled: styledTrack(track) };
  });
}

/** What to show without a choice for this video. "matched": the dub's own
 *  script, matched by the server; `fallback` plays until it arrives. */
export type SubtitlePlan =
  | { kind: 'track'; id: number }
  | { kind: 'matched'; fallback: number | null }
  | { kind: 'off' }
  | { kind: 'keep' };

export type TrackPlan = { audio: number | null; subtitle: SubtitlePlan };

/** The audio (the show's remembered language, else the player's current
 *  one, else the video's default) and the subtitle that suits it. */
export function planTracks({ audio, subtitles, show, subtitleLang, currentAudio = null }: {
  audio: ReadonlyArray<PlayerTrack>;
  subtitles: ReadonlyArray<PlayerTrack>;
  show: ShowPlaybackPrefs | null;
  subtitleLang: string;
  currentAudio?: number | null;
}): TrackPlan {
  const remembered = show?.audioLanguage
    ? audio.find((track) => trackLanguageName(track.label) === show.audioLanguage)
    : undefined;
  const chosen = remembered
    ?? audio.find((track) => track.id === currentAudio)
    ?? audio.find((track) => track.default)
    ?? audio[0];
  const languages = audioLanguages(audio);
  const style = defaultSubtitleStyle(show, trackLanguageName(chosen?.label), languages, subtitleLang);
  const result = (subtitle: SubtitlePlan): TrackPlan => ({ audio: chosen?.id ?? null, subtitle });
  if (style === 'off') return result({ kind: 'off' });
  const track = subtitleTrackFor(subtitles, subtitleLang, style);
  if (track) return result({ kind: 'track', id: track.id });
  const regular = subtitleTrackFor(subtitles, subtitleLang, 'regular');
  if (style === 'dub' && languages.length > 1) return result({ kind: 'matched', fallback: regular?.id ?? null });
  return result(regular ? { kind: 'track', id: regular.id } : { kind: 'keep' });
}
