// The skip button for the segment playing now (intro, recap, credits).
// Credits that run to the end become "Next episode": seeking to the end lets
// the normal end-of-episode flow continue. Credits followed by more of the
// episode (a post-credits scene) only skip the credits.

export type SkipSegment = { type: string; start: number; end: number };
export type SkipAction = { label: string; target: number };

const SKIP_LABELS: Record<string, string> = { intro: 'Skip intro', recap: 'Skip recap', credits: 'Skip credits' };

export function skipActionAt(segments: ReadonlyArray<SkipSegment>, currentTime: number, duration: number, hasNextEpisode: boolean): SkipAction | null {
  const segment = segments.find((entry) => currentTime >= entry.start && currentTime <= entry.end && SKIP_LABELS[entry.type]);
  if (!segment) return null;
  if (segment.type === 'credits' && duration > 0 && segment.end >= duration - 5) {
    return { label: hasNextEpisode ? 'Next episode' : 'Skip credits', target: Math.max(0, duration - 0.5) };
  }
  return { label: SKIP_LABELS[segment.type], target: segment.end + 0.25 };
}
