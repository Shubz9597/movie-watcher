// Anime matching utilities - copied from Next.js
const VIDEO_EXT_RX = /\.(?:mkv|mp4|m4v|mpg|mpeg|avi|ts|m2ts|mov|wmv|webm)$/i;

export type TorrentFileEntry = {
  index: number;
  name: string;
  length?: number;
};

const PACK_KEYWORDS = [
  { rx: /\bcomplete\b/i, tag: 'complete' },
  { rx: /\bbatch\b/i, tag: 'batch' },
  { rx: /\ball[\s._-]*(?:eps?|episodes)\b/i, tag: 'all-episodes' },
  { rx: /\b(full|whole)\s+(season|series)\b/i, tag: 'full-season' },
  { rx: /\bseason\s*pack\b/i, tag: 'season-pack' },
  { rx: /\bcollection\b/i, tag: 'collection' },
  { rx: /全集|全話|完結|合集/u, tag: 'complete-localized' },
];

export type SeasonPackDetection = {
  isSeasonPack: boolean;
  keywords: string[];
  seasonMatch: boolean;
  reason?: string;
};

export const MAX_EPISODE_FOR_MATCH = 999;

export function pad(num: number, len = 2) {
  return String(num).padStart(len, '0');
}

function addRange(target: Set<number>, start?: number, end?: number) {
  if (typeof start !== 'number' || Number.isNaN(start)) return;
  if (start < 1) return;
  const s = Math.min(start, end ?? start);
  const e = Math.max(start, end ?? start);
  for (let value = s; value <= e && value <= MAX_EPISODE_FOR_MATCH; value += 1) {
    if (value >= 1) target.add(value);
  }
}

function ensureSeason(map: Map<number, Set<number>>, season: number) {
  if (!map.has(season)) map.set(season, new Set<number>());
  return map.get(season)!;
}

const FALSE_POSITIVE_PATTERNS = [
  /\b(?:part|vol|volume|batch|version|ver)\s*\d+/gi,
  /\bv\d+\b/gi,
  /\d{3,4}p\b/gi,
  /\b(?:19|20)\d{2}\b/g,
  /\bx26[45]\b/gi,
  /\bh\.?26[45]\b/gi,
  /\b\d+\s*bit\b/gi,
  /\bAAC\s*\d+[\s.]*\d*/gi,
  /\bDDP?\s*\d+[\s.]*\d*/gi,
  /\bFLAC\s*\d+[\s.]*\d*/gi,
  /\b\d+\.\d+\b/g,
  /\bHEVC\d*/gi,
  /\bAVC\d*/gi,
  /\[\w{8}\]/g,
  /\bArg0\b/gi,
  /\bS\d{1,2}\b(?!E)/gi,
];

function cleanTitleForEpisodeExtraction(title: string): string {
  let cleaned = title;
  for (const pattern of FALSE_POSITIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return cleaned;
}

export function extractEpisodeHints(title: string): {
  bySeason: Map<number, Set<number>>;
  generic: Set<number>;
} {
  const bySeason = new Map<number, Set<number>>();
  const generic = new Set<number>();
  const normalized = title.replace(/_/g, ' ');

  const seasonRegex = /S(\d{1,2})E(\d{1,3})(?:[-–~]E?(\d{1,3}))?/gi;
  let match: RegExpExecArray | null;
  while ((match = seasonRegex.exec(normalized)) !== null) {
    const season = Number(match[1]);
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    if (Number.isFinite(season) && season > 0) {
      const set = ensureSeason(bySeason, season);
      addRange(set, start, end);
    }
  }

  const cleaned = cleanTitleForEpisodeExtraction(normalized);

  const wordRegex = /\b(?:EP|Episode|#)\s*(\d{1,3})(?:\s*[-–~]\s*(\d{1,3}))?/gi;
  while ((match = wordRegex.exec(cleaned)) !== null) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    addRange(generic, start, end);
  }

  // Dots and path slashes separate too: scene-style packs name files
  // "Show.2009.022.1080p.mkv" or "Season 1/05.mkv".
  const looseRegex = /(?:^|[\s\-\[\(./])(\d{2,3})(?:\s*[-–~]\s*(\d{2,3}))?(?=[\]\s\-\)\._]|$)/g;
  while ((match = looseRegex.exec(cleaned)) !== null) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start >= 1 && start <= 500) {
      addRange(generic, start, end);
    }
  }

  return { bySeason, generic };
}

export function matchesEpisode(title: string, season?: number, episode?: number, absolute?: number): boolean {
  if (episode == null && absolute == null) return true;
  const hints = extractEpisodeHints(title);
  const targets = new Set<number>();
  if (typeof episode === 'number') targets.add(episode);
  if (typeof absolute === 'number') targets.add(absolute);
  for (const target of targets) {
    if (Number.isNaN(target)) continue;
    if (season != null) {
      const set = hints.bySeason.get(season);
      if (set?.has(target)) return true;
    } else {
      for (const set of hints.bySeason.values()) {
        if (set.has(target)) return true;
      }
    }
    if (hints.generic.has(target)) return true;
  }
  return false;
}

/**
 * A named batch/complete pack without explicit episode numbers may contain the
 * requested episode. When the title does advertise a range, only keep it if
 * that range actually includes the requested episode.
 */
export function seasonPackContainsEpisode(
  title: string,
  season?: number,
  episode?: number,
  absolute?: number,
): boolean {
  const detection = detectSeasonPack(title, season);
  if (!detection.isSeasonPack) return false;

  const hints = extractEpisodeHints(title);
  const hasExplicitEpisodes = hints.generic.size > 0 ||
    [...hints.bySeason.values()].some((episodes) => episodes.size > 0);
  if (!hasExplicitEpisodes) return true;

  return matchesEpisode(title, season, episode, absolute);
}

export function detectSeasonPack(title: string, season?: number): SeasonPackDetection {
  const keywords = PACK_KEYWORDS.filter((rule) => rule.rx.test(title)).map((rule) => rule.tag);
  const rangePatterns = [
    /\bS\d{1,2}E(\d{1,3})\s*[-–~]\s*E?(\d{1,3})\b/i,
    /\b(?:episodes?|eps?|ep)\s*(\d{1,3})\s*[-–~]\s*(\d{1,3})\b/i,
    /[\[(]\s*(\d{1,3})\s*[-–~]\s*(\d{1,3})\s*[\])]/,
    /(?:^|\s)(\d{1,3})\s*[-–~]\s*(\d{1,3})(?=\s|$)/,
  ];
  const hasEpisodeRange = rangePatterns.some((pattern) => {
    const match = title.match(pattern);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return Number.isFinite(start) && Number.isFinite(end) && start >= 1 && end > start;
  });
  if (hasEpisodeRange) keywords.push('episode-range');
  const hasKeywords = keywords.length > 0;

  let seasonMatch = false;
  if (typeof season === 'number' && Number.isFinite(season)) {
    const rxList = [
      new RegExp(`\\bs${pad(season)}\\b`, 'i'),
      new RegExp(`season[\\s._-]*0?${season}\\b`, 'i'),
      new RegExp(`\\b0?${season}(?:st|nd|rd|th)?\\s*season\\b`, 'i'),
    ];
    seasonMatch = rxList.some((rx) => rx.test(title));
  }

  // Anime releases commonly use just "Batch" or "[01-12]" without an Sxx
  // marker. Those still require selecting the correct file before playback.
  const isSeasonPack = hasEpisodeRange || hasKeywords;

  return {
    isSeasonPack,
    keywords,
    seasonMatch,
    reason: isSeasonPack
      ? seasonMatch
        ? `season-${season ?? ''}-${keywords[0] ?? 'pack'}`
        : keywords[0] ?? 'season-pack'
      : undefined,
  };
}

// Pack file matching. Episode evidence comes from the file's own name; a
// folder only says which season (or which show) the file belongs to, since a
// folder named "S02E01-10" or "Season 1-6" would otherwise vouch for every
// file inside it.
// Bonus material: any of these words as a folder name, but in a file name
// only the unambiguous markers ("The Ginyu Special Force" is an episode).
const PACK_EXTRAS_DIR_RX = /(?:^|[\/\s\[\(._-])(?:NC ?OP|NC ?ED|creditless|menus?|extras?|bonus|specials?|featurettes?|trailers?|samples?|promos?|previews?|scans|movies?|特典映像?)(?=$|[\/\s\]\)._-]|\d)/i;
const PACK_EXTRAS_FILE_RX = /(?:^|[\s\[\(._-])(?:NC ?OP|NC ?ED|creditless|menu|sample|trailer)(?=$|[\s\]\)._-]|\d)/i;
// Ranges need a dash or a second E ("S01E01-03", "S01E01E02"); "S02E01.1080p" is one episode.
// "S05E02 - 50% Off" is episode 2 with a title, so a spaced dash needs the E.
const SEASON_EPISODE_RX = /S(\d{1,2})[\s._-]*E(\d{1,4})(?:[-–~]E?(\d{1,4})|\s*[-–~]\s*E(\d{1,4})|E(\d{1,4}))?(?!\d)/gi;
const CROSS_RX = /(?:^|[^\dx])(\d{1,2})x(\d{2,3})(?=$|[^\dp])/gi;
const MARKER_RX = /(?:^|[^a-z])(?:E|EP|Ep\.|Episode|Episodio|Épisode|#)[\s._-]*(\d{1,4})(?!\d)/gi;
const LOOSE_NUMBER_RX = /(?:^|[\s\-\[\(._])(\d{1,4})(?:\s*[-–~]\s*(\d{1,4}))?(?=$|[\]\s\-\)._,!:])/g;
const DIR_SEASON_RX = /(?:^|[\/\s._\[-])(?:season|series|saison|temporada|staffel)[\s._-]*(\d{1,2})(?!\d)|(?:^|[\/\s._\[-])S(\d{1,2})(?=$|[\/\s._\]-])/gi;

type EpisodeEvidence = { kind: 'pair' | 'marker' | 'loose' | 'none'; pairs: Array<[number, number]>; numbers: number[]; ranged: Set<number> };

function episodeEvidence(baseName: string): EpisodeEvidence {
  const name = baseName.replace(/_/g, ' ').replace(/\.[a-z0-9]{2,4}$/i, '');
  const pairs: Array<[number, number]> = [];
  for (const rx of [SEASON_EPISODE_RX, CROSS_RX]) {
    rx.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rx.exec(name)) !== null) {
      const season = Number(match[1]);
      const from = Number(match[2]);
      const end = match[3] ?? match[4] ?? match[5];
      const to = end ? Number(end) : from;
      for (let episode = from; episode <= Math.min(Math.max(from, to), from + 50); episode += 1) pairs.push([season, episode]);
    }
  }
  if (pairs.length > 0) return { kind: 'pair', pairs, numbers: [], ranged: new Set() };

  const cleaned = cleanTitleForEpisodeExtraction(name);
  const markers: number[] = [];
  MARKER_RX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RX.exec(cleaned)) !== null) markers.push(Number(match[1]));
  if (markers.length > 0) return { kind: 'marker', pairs, numbers: markers, ranged: new Set() };

  const numbers: number[] = [];
  const ranged = new Set<number>();
  LOOSE_NUMBER_RX.lastIndex = 0;
  while ((match = LOOSE_NUMBER_RX.exec(cleaned)) !== null) {
    const from = Number(match[1]);
    if (match[2]) {
      const to = Number(match[2]);
      for (let episode = from; episode <= Math.min(to, from + 50); episode += 1) ranged.add(episode);
    } else if (from >= 1) {
      numbers.push(from);
    }
  }
  return { kind: numbers.length > 0 || ranged.size > 0 ? 'loose' : 'none', pairs, numbers, ranged };
}

function folderSeason(directory: string): number | undefined {
  let season: number | undefined;
  DIR_SEASON_RX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DIR_SEASON_RX.exec(directory)) !== null) season = Number(match[1] ?? match[2]);
  return season;
}

function squash(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A title "names" a file when every word of it (two or more letters) occurs
// in one folder name or in the file name before its episode number: "Dragon
// Ball Kai" names "[AnimeRG] Dragon Ball KAI - 001" and "Dragonball Z Kai 01",
// not "[RH] Dragon Ball GT - 03" or "Dragon Ball Super - S01E05 - King Kai's
// Planet" (episode titles do not count).
function titleNamesPath(title: string, directory: string, baseName: string): boolean {
  const words = title.normalize('NFKD').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 2 && !/^\d+$/.test(word));
  if (words.length === 0) return false;
  const showPart = baseName.split(/S\d{1,2}[\s._-]*E\d|(?:^|[\s._\-\[(])(?:E|EP|Episode)?[\s._-]*\d{1,4}(?=$|[\s._\-\])])/i)[0];
  return [...directory.split('/'), showPart].some((segment) => {
    const haystack = squash(segment);
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Picks the file for one episode from a torrent's file list. Strength of the
 * evidence, strongest first: S01E05 / 1x05 in the file name, an episode
 * marker ("E05", "Episode 5"), the file's first number ("Show - 005"), any
 * other number. A file that names a different episode explicitly never
 * matches. For TV a season folder must agree; anime packs number episodes
 * absolutely across arc folders, so their folders are not checked. When a
 * title is given and some files carry it, files of other shows in a
 * franchise collection are skipped.
 */
export function pickFileIndexForEpisode(
  files: TorrentFileEntry[],
  opts: { season?: number; episode?: number; absolute?: number; titles?: string[]; anime?: boolean },
) {
  if (!Array.isArray(files) || files.length === 0) return null;

  const videoFiles = files.filter((f) => VIDEO_EXT_RX.test(f.name));
  const pool = videoFiles.length > 0 ? videoFiles : files;
  const { season, episode, absolute, titles = [], anime = false } = opts;
  const targets = new Set<number>([episode, absolute].filter((value): value is number => typeof value === 'number' && value > 0));

  type Candidate = TorrentFileEntry & { score: number; matched: boolean; strength: number; named: boolean };
  const candidates: Candidate[] = pool.map((file) => {
    const slash = file.name.lastIndexOf('/');
    const directory = slash >= 0 ? file.name.slice(0, slash) : '';
    const baseName = slash >= 0 ? file.name.slice(slash + 1) : file.name;
    const evidence = episodeEvidence(baseName);
    let strength = 0;
    if (evidence.kind === 'pair') {
      for (const [pairSeason, pairEpisode] of evidence.pairs) {
        if (!targets.has(pairEpisode)) continue;
        if (season == null || pairSeason === season) strength = Math.max(strength, 4);
        else if (anime && pairEpisode === absolute) strength = Math.max(strength, 3);
      }
    } else if (evidence.kind === 'marker') {
      if (evidence.numbers.some((value) => targets.has(value))) strength = 3;
    } else if (evidence.kind === 'loose') {
      if (targets.has(evidence.numbers[0])) strength = 2;
      else if (evidence.numbers.some((value) => targets.has(value)) || [...targets].some((value) => evidence.ranged.has(value))) strength = 1;
    }
    if (strength > 0 && !anime && season != null && evidence.kind !== 'pair') {
      const dirSeason = folderSeason(directory);
      if (dirSeason != null && dirSeason !== season) strength = 0;
    }
    const named = titles.some((title) => titleNamesPath(title, directory, baseName));

    let score = strength * 60;
    if (PACK_EXTRAS_DIR_RX.test(directory) || PACK_EXTRAS_FILE_RX.test(baseName)) score -= 150;
    if (/part\s*\d+/i.test(baseName) || /\b(comp|complete|batch)\b/i.test(baseName)) score -= 20;
    if (VIDEO_EXT_RX.test(file.name)) score += 10;
    if (typeof file.length === 'number' && Number.isFinite(file.length)) score += Math.min(file.length / (75 * 1024 * 1024), 20);
    return { ...file, score, matched: strength > 0, strength, named };
  });

  // Inside a franchise collection, only the requested show's files count.
  const namedMatches = candidates.filter((candidate) => candidate.matched && candidate.named);
  const eligible = namedMatches.length > 0 ? namedMatches : candidates;
  let best: Candidate | null = null;
  for (const candidate of eligible) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (best && best.score < 0) best = { ...best, matched: false };

  return best
    ? {
        index: best.index,
        name: best.name,
        length: best.length,
        matched: best.matched,
        score: best.score,
      }
    : null;
}
