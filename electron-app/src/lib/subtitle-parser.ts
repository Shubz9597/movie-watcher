// Client-side subtitle parsing (v2 overlay renderer): web-loaded tracks
// (OpenSubtitles / torrent sidecars / local imports) are rendered as a web
// overlay instead of VLC slaves, so size/position are fully under the
// user's control with live pinch-resize.
//
// Supported: WebVTT, SRT, and a functional subset of ASS/SSA (Dialogue
// lines, override tags stripped — the shared subtitle contract already drops
// ASS styling for the sheet; here we keep the text and timings).

export type SubtitleCue = { start: number; end: number; text: string };

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa';

function timestampToSeconds(value: string): number | null {
  // Normalize the SRT-style comma decimal to a dot, then split on ':'.
  const cleaned = value.trim().replace(',', '.');
  const parts = cleaned.split(':').map((p) => p.trim());
  if (parts.length !== 2 && parts.length !== 3) return null;
  let seconds = 0;
  for (const part of parts) {
    const piece = Number(part);
    if (!Number.isFinite(piece)) return null;
    seconds = seconds * 60 + piece;
  }
  return seconds;
}

/** WebVTT: cue blocks with optional identifiers and settings. */
function parseVTT(raw: string): SubtitleCue[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const cues: SubtitleCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith('WEBVTT') || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      i += 1;
      continue;
    }
    let timing: string | undefined;
    if (line.includes('-->')) {
      timing = line;
      i += 1;
    } else if (i + 1 < lines.length && lines[i + 1].includes('-->')) {
      timing = lines[i + 1];
      i += 2;
    } else {
      i += 1;
      continue;
    }
    const [startRaw, endRaw] = (timing ?? '').split('-->');
    if (!startRaw || !endRaw) continue;
    const start = timestampToSeconds(startRaw.split(' ')[0]);
    const end = timestampToSeconds(endRaw.trim().split(' ')[0]);
    if (start === null || end === null || end <= start) continue;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i += 1;
    }
    const text = decodeEntities(textLines.join('\n'));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

/** SRT: numbered blocks, comma decimal separators. */
function parseSRT(raw: string): SubtitleCue[] {
  const blocks = raw.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    const timingLine = lines.find((l) => l.includes('-->'));
    if (!timingLine) continue;
    const [startRaw, endRaw] = timingLine.split('-->');
    if (!startRaw || !endRaw) continue;
    const start = timestampToSeconds(startRaw);
    const end = timestampToSeconds(endRaw.trim().split(' ')[0]);
    if (start === null || end === null || end <= start) continue;
    const textLines = lines.filter((l) => l !== timingLine && !/^\d+$/.test(l.trim()));
    const text = decodeEntities(textLines.join('\n'));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

/** ASS/SSA: [Events] Dialogue lines. The Format: line names the fields —
    the dialogue text is the field after the (n-1)th comma. Styling is
    intentionally dropped (matches the shared VTT limitation). */
function parseASS(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let textCommaIndex = 9; // v4+ default: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
  const cuesByLine = raw.replace(/\r\n?/g, '\n').split('\n');
  for (const line of cuesByLine) {
    if (line.startsWith('Format:')) {
      const fields = line.slice('Format:'.length).split(',').map((f) => f.trim().toLowerCase());
      const textIndex = fields.indexOf('text');
      if (textIndex > 0) textCommaIndex = textIndex;
      continue;
    }
    if (!line.startsWith('Dialogue:')) continue;
    const body = line.slice('Dialogue:'.length);
    // ASS timings use h:mm:ss.cc (single-digit hours are common).
    const match = /\d:\d{2}:\d{2}\.\d{2}/.exec(body);
    if (!match) continue;
    const comma1 = body.indexOf(',', match.index);
    if (comma1 < 0) continue;
    const comma2 = body.indexOf(',', comma1 + 1);
    if (comma2 < 0) continue;
    const start = timestampToSeconds(body.slice(match.index, comma1).trim());
    const end = timestampToSeconds(body.slice(comma1 + 1, comma2).trim());
    if (start === null || end === null || end <= start) continue;
    // Walk to the text field: after the (textCommaIndex)th comma.
    let commaCount = 0;
    let textStart = -1;
    for (let i = comma2; i < body.length; i++) {
      if (body[i] === ',') {
        commaCount += 1;
        if (commaCount === textCommaIndex - 2) {
          textStart = i + 1;
          break;
        }
      }
    }
    if (textStart < 0) textStart = body.length;
    const text = decodeEntities(
      body
        .slice(textStart)
        .replace(/\\N|\\n/g, '\n')
        .replace(/\{[^}]*\}/g, ''),
    );
    if (text.trim()) cues.push({ start, end, text });
  }
  return cues;
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Detects the format from content when the URL/extension is not trusted. */
export function detectSubtitleFormat(raw: string, fallback: SubtitleFormat = 'vtt'): SubtitleFormat {
  const head = raw.slice(0, 2000).trimStart();
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\d+\s*$/m.test(head.split('\n')[0] ?? '') && head.includes('-->')) return 'srt';
  if (head.startsWith('[Script Info]') || head.startsWith('[V4+ Styles]') || head.startsWith('[V4 Styles]')) {
    return head.includes('[V4+') ? 'ass' : 'ssa';
  }
  if (head.includes('-->')) return fallback === 'ass' || fallback === 'ssa' ? fallback : 'srt';
  return fallback;
}

/** Parses raw subtitle content into cues. Unknown content degrades to VTT. */
export function parseSubtitles(raw: string, hint?: SubtitleFormat): SubtitleCue[] {
  const format = detectSubtitleFormat(raw, hint ?? 'vtt');
  switch (format) {
    case 'srt': return parseSRT(raw);
    case 'ass':
    case 'ssa': return parseASS(raw);
    default: return parseVTT(raw);
  }
}
