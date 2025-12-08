const VIDEO_EXT_RX = /\.(?:mkv|mp4|m4v|mpg|mpeg|avi|ts|m2ts|mov|wmv|webm)$/i;

export type TorrentFileEntry = {
  index: number;
  name: string;
  length?: number;
};

const PACK_KEYWORDS = [
  { rx: /\bcomplete\b/i, tag: "complete" },
  { rx: /\bbatch\b/i, tag: "batch" },
  { rx: /\ball[\s._-]*(?:eps?|episodes)\b/i, tag: "all-episodes" },
  { rx: /\b(full|whole)\s+(season|series)\b/i, tag: "full-season" },
  { rx: /\bseason\s*pack\b/i, tag: "season-pack" },
  { rx: /\bcollection\b/i, tag: "collection" },
  { rx: /全集|全話|完結|合集/u, tag: "complete-localized" },
];

export type SeasonPackDetection = {
  isSeasonPack: boolean;
  keywords: string[];
  seasonMatch: boolean;
  reason?: string;
};

export const MAX_EPISODE_FOR_MATCH = 999;

export function pad(num: number, len = 2) {
  return String(num).padStart(len, "0");
}

function addRange(target: Set<number>, start?: number, end?: number) {
  if (typeof start !== "number" || Number.isNaN(start)) return;
  // Skip if start is 0 or negative - these are not valid episode numbers
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

// Patterns that look like numbers but are NOT episode numbers
const FALSE_POSITIVE_PATTERNS = [
  /\b(?:part|vol|volume|batch|version|ver)\s*\d+/gi, // Part 1, Vol 2, Batch 1
  /\bv\d+\b/gi, // v2, v3 (version markers)
  /\d{3,4}p\b/gi, // 720p, 1080p, 2160p (resolution)
  /\b(?:19|20)\d{2}\b/g, // Years 1900-2099
  /\bx26[45]\b/gi, // x264, x265 codecs
  /\bh\.?26[45]\b/gi, // h264, h.265 codecs
  /\b\d+\s*bit\b/gi, // 10bit, 8bit
  /\bAAC\s*\d+[\s.]*\d*/gi, // AAC 2.0, AAC 5.1, AAC2.0
  /\bDDP?\s*\d+[\s.]*\d*/gi, // DDP2.0, DD5.1, DDP 2.0
  /\bFLAC\s*\d+[\s.]*\d*/gi, // FLAC 2.0
  /\b\d+\.\d+\b/g, // Decimal numbers like 2.0, 5.1 (audio channels)
  /\bHEVC\d*/gi, // HEVC, HEVC10
  /\bAVC\d*/gi, // AVC
  /\[\w{8}\]/g, // CRC hashes like [ABCD1234]
  /\bArg0\b/gi, // Release group markers
  /\bS\d{1,2}\b(?!E)/gi, // Standalone season markers like S01 (without episode)
];

/**
 * Clean a title by removing patterns that contain numbers but aren't episode numbers.
 * This prevents "Part 1", "2160p", "x265" from being mistaken as episodes.
 */
function cleanTitleForEpisodeExtraction(title: string): string {
  let cleaned = title;
  for (const pattern of FALSE_POSITIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned;
}

export function extractEpisodeHints(title: string): {
  bySeason: Map<number, Set<number>>;
  generic: Set<number>;
} {
  const bySeason = new Map<number, Set<number>>();
  const generic = new Set<number>();
  const normalized = title.replace(/_/g, " ");

  // First pass: extract S01E01 format (most reliable, use original title)
  const seasonRegex = /S(\d{1,2})E(\d{1,3})(?:[-–]E?(\d{1,3}))?/gi;
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

  // Clean the title for subsequent passes to avoid false positives
  const cleaned = cleanTitleForEpisodeExtraction(normalized);

  // Second pass: EP/Episode patterns on cleaned title
  const wordRegex = /\b(?:EP|Episode|#)\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi;
  while ((match = wordRegex.exec(cleaned)) !== null) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    addRange(generic, start, end);
  }

  // Third pass: loose number matching on cleaned title (more restrictive)
  // Only match numbers that are clearly episode-like (preceded by common separators)
  // Require 2-3 digit numbers to reduce false positives from stray single digits
  const looseRegex = /(?:^|[\s\-\[\(])(\d{2,3})(?:\s*[-–]\s*(\d{2,3}))?(?=[\]\s\-\)\._]|$)/g;
  while ((match = looseRegex.exec(cleaned)) !== null) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    // Additional filter: skip if number is too large to be an episode (> 500)
    if (start >= 1 && start <= 500) {
      addRange(generic, start, end);
    }
  }

  return { bySeason, generic };
}

export function matchesEpisode(
  title: string,
  season?: number,
  episode?: number,
  absolute?: number
): boolean {
  if (episode == null && absolute == null) return true;
  const hints = extractEpisodeHints(title);
  const targets = new Set<number>();
  if (typeof episode === "number") targets.add(episode);
  if (typeof absolute === "number") targets.add(absolute);
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

export function detectSeasonPack(title: string, season?: number): SeasonPackDetection {
  const keywords = PACK_KEYWORDS.filter((rule) => rule.rx.test(title)).map((rule) => rule.tag);
  const hasKeywords = keywords.length > 0;

  let seasonMatch = false;
  if (typeof season === "number" && Number.isFinite(season)) {
    const rxList = [
      new RegExp(`\\bs${pad(season)}\\b`, "i"),
      new RegExp(`season[\\s._-]*0?${season}\\b`, "i"),
      new RegExp(`\\b0?${season}(?:st|nd|rd|th)?\\s*season\\b`, "i"),
    ];
    seasonMatch = rxList.some((rx) => rx.test(title));
  }

  const mentionsSeasonWord = /\bseason\b/i.test(title) || /\bs\d{1,2}\b/i.test(title);
  const mentionsSeries = /\bseries\b/i.test(title);
  const isSeasonPack = hasKeywords && (seasonMatch || mentionsSeasonWord || mentionsSeries);

  return {
    isSeasonPack,
    keywords,
    seasonMatch,
    reason: isSeasonPack
      ? seasonMatch
        ? `season-${season ?? ""}-${keywords[0] ?? "pack"}`
        : keywords[0] ?? "season-pack"
      : undefined,
  };
}

export function pickFileIndexForEpisode(
  files: TorrentFileEntry[],
  opts: { season?: number; episode?: number; absolute?: number }
) {
  if (!Array.isArray(files) || files.length === 0) return null;

  const videoFiles = files.filter((f) => VIDEO_EXT_RX.test(f.name));
  const pool = videoFiles.length > 0 ? videoFiles : files;
  const { season, episode, absolute } = opts;

  type Candidate = TorrentFileEntry & { score: number; matched: boolean };
  let best: Candidate | null = null;

  for (const file of pool) {
    let score = 0;
    const matched = matchesEpisode(file.name, season, episode, absolute);
    if (matched) {
      score += 120;
    } else if (typeof absolute === "number" && matchesEpisode(file.name, undefined, undefined, absolute)) {
      score += 80;
    }

    if (/part\s*\d+/i.test(file.name) || /\b(comp|complete|batch)\b/i.test(file.name)) {
      score -= 20;
    }

    if (VIDEO_EXT_RX.test(file.name)) {
      score += 10;
    }

    if (typeof file.length === "number" && Number.isFinite(file.length)) {
      const lengthBonus = Math.min(file.length / (75 * 1024 * 1024), 20); // cap ~20pts @ ~1.5GB
      score += lengthBonus;
    }

    if (!best || score > best.score) {
      best = { ...file, score, matched };
    }
  }

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

