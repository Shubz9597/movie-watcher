// Readable names for the audio and subtitle tracks VLC reports, and the
// built-in subtitle to show when the viewer has not chosen one.
//
// VLC names tracks "Track 2 - [English]", "Full Subtitles - [English]",
// "English" or only "Track 3". Saved preferences keep matching VLC's raw
// label; these names are for display only.

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', eng: 'English', english: 'English',
  ja: 'Japanese', jpn: 'Japanese', jap: 'Japanese', japanese: 'Japanese',
  es: 'Spanish', spa: 'Spanish', spanish: 'Spanish',
  fr: 'French', fre: 'French', fra: 'French', french: 'French',
  de: 'German', ger: 'German', deu: 'German', german: 'German',
  it: 'Italian', ita: 'Italian', italian: 'Italian',
  pt: 'Portuguese', por: 'Portuguese', portuguese: 'Portuguese',
  hi: 'Hindi', hin: 'Hindi', hindi: 'Hindi',
  ar: 'Arabic', ara: 'Arabic', arabic: 'Arabic',
  ko: 'Korean', kor: 'Korean', korean: 'Korean',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', chinese: 'Chinese',
  ru: 'Russian', rus: 'Russian', russian: 'Russian',
  ta: 'Tamil', tam: 'Tamil', tamil: 'Tamil',
  te: 'Telugu', tel: 'Telugu', telugu: 'Telugu',
};

type Parsed = { language: string; title: string };

function parseTrack(raw: string): Parsed {
  let title = raw.trim();
  let language = '';
  const bracketed = /^(.*?)\s*-\s*\[([^\]]+)\]\s*$/.exec(title);
  if (bracketed) {
    title = bracketed[1].trim();
    language = bracketed[2].trim();
  }
  if (/^track\s*\d+$/i.test(title)) title = '';
  language = LANGUAGE_NAMES[language.toLowerCase()] ?? language;
  if (!language && LANGUAGE_NAMES[title.toLowerCase()]) {
    language = LANGUAGE_NAMES[title.toLowerCase()];
    title = '';
  }
  if (title.toLowerCase() === language.toLowerCase()) title = '';
  return { language, title };
}

function singleName(raw: string, position: number): string {
  const { language, title } = parseTrack(raw);
  if (language && title) return `${language} · ${title}`;
  return language || title || `Track ${position}`;
}

/** Display names for a list of tracks; identical names get " 1", " 2". */
export function trackDisplayNames(labels: ReadonlyArray<string | undefined>): string[] {
  const names = labels.map((label, index) => singleName(label ?? '', index + 1));
  const totals = new Map<string, number>();
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((totals.get(name) ?? 0) < 2) return name;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return `${name} ${count}`;
  });
}

const PARTIAL_TRACK = /\b(signs?|songs?|forced|karaoke|commentary)\b/i;

/** True when the track carries the full dialogue in `language` (ISO 639-1). */
export function isFullDialogueTrack(raw: string | undefined, language: string): boolean {
  const wanted = LANGUAGE_NAMES[language.toLowerCase()];
  if (!wanted || !raw) return false;
  const { language: trackLanguage } = parseTrack(raw);
  return trackLanguage === wanted && !PARTIAL_TRACK.test(raw);
}

/** The built-in subtitle to show by default: the first full-dialogue track
 *  in the preferred language, or null when the video has none. */
export function preferredSubtitleTrack<T extends { id: number; label?: string }>(tracks: ReadonlyArray<T>, language: string): T | null {
  return tracks.find((track) => isFullDialogueTrack(track.label, language)) ?? null;
}
