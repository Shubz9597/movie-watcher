// Search result organization: AniList lists every arc/season/movie of a
// franchise as its own entry and TMDb adds theatrical compilations, so a
// search like "demon slayer" used to return a flat wall of near-identical
// titles. Results are labelled by kind/format, cross-provider duplicates are
// dropped, and franchise entries are grouped: the main series first, then the
// rest by release year, with long franchises collapsed behind "Show more".

export type SearchItemLike = {
  id: number;
  title: string;
  year?: number;
  sourceProvider?: 'tmdb' | 'anilist';
  sourceKind?: 'movie' | 'tv' | 'anime';
  format?: string;
  popularity?: number;
};

export type OrganizedEntry<T> =
  | { kind: 'item'; item: T; label: string }
  | { kind: 'more'; groupKey: string; name: string; hidden: number };

const VISIBLE_PER_FRANCHISE = 4;

function normalize(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function franchiseKey(title: string): string {
  const words = normalize(title).split(' ').filter(Boolean);
  const significant = words[0] === 'the' ? words.slice(1) : words;
  return significant.slice(0, 3).join(' ');
}

/** The franchise's display name: the title before any subtitle. */
function franchiseName(title: string): string {
  const cut = title.split(/:| - | -|–/)[0]?.trim();
  return cut && cut.length >= 3 ? cut : title;
}

const isAnime = (item: SearchItemLike) => item.sourceProvider === 'anilist' || item.sourceKind === 'anime';

export function resultLabel(item: SearchItemLike): string {
  const format = (item.format ?? '').toLowerCase();
  if (isAnime(item)) {
    if (format === 'movie') return 'Anime movie';
    if (format === 'ova') return 'Anime OVA';
    if (format === 'ona') return 'Anime ONA';
    if (format === 'special') return 'Anime special';
    return 'Anime series';
  }
  return item.sourceKind === 'tv' || format === 'tv' ? 'Series' : 'Movie';
}

function isSeries(item: SearchItemLike): boolean {
  const format = (item.format ?? '').toLowerCase();
  return format === 'tv' || format === 'tv_short' || item.sourceKind === 'tv';
}

export function organizeSearchResults<T extends SearchItemLike>(
  ranked: T[],
  expanded: ReadonlySet<string> = new Set(),
): OrganizedEntry<T>[] {
  // 1. Cross-provider duplicates (same title and year): keep one, preferring
  //    the AniList entry for anime (richer episode data).
  const byIdentity = new Map<string, T>();
  const deduped: T[] = [];
  for (const item of ranked) {
    const identity = `${normalize(item.title)}|${item.year ?? ''}`;
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, item);
      deduped.push(item);
    } else if (existing.sourceProvider !== 'anilist' && item.sourceProvider === 'anilist' && isAnime(item)) {
      deduped[deduped.indexOf(existing)] = item;
      byIdentity.set(identity, item);
    }
  }

  // 2. Franchise groups in first-appearance (relevance) order.
  const groups = new Map<string, T[]>();
  for (const item of deduped) {
    const key = franchiseKey(item.title);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const out: OrganizedEntry<T>[] = [];
  for (const [key, members] of groups) {
    if (members.length < 3) {
      for (const item of members) out.push({ kind: 'item', item, label: resultLabel(item) });
      continue;
    }
    // Main entry: the most popular series of the franchise, else the most
    // relevant member; the rest follow by release year (unreleased last).
    const series = members.filter(isSeries);
    const primary = (series.length ? series : members)
      .slice()
      .sort((left, right) => (right.popularity ?? 0) - (left.popularity ?? 0))[0];
    const rest = members
      .filter((item) => item !== primary)
      .sort((left, right) => (left.year ?? Number.MAX_SAFE_INTEGER) - (right.year ?? Number.MAX_SAFE_INTEGER));
    const ordered = [primary, ...rest];
    const visible = expanded.has(key) ? ordered : ordered.slice(0, VISIBLE_PER_FRANCHISE);
    for (const item of visible) out.push({ kind: 'item', item, label: resultLabel(item) });
    if (visible.length < ordered.length) {
      out.push({ kind: 'more', groupKey: key, name: franchiseName(primary.title), hidden: ordered.length - visible.length });
    }
  }
  return out;
}
