// Search normalization preserves non-Latin titles and sequel/season numbers.
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchScore(title: string, query: string): number {
  const text = normalizeSearchText(title);
  if (!query || !text) return 0;
  if (text === query) return 4;
  if (text.startsWith(query + ' ')) return 3;
  const tokens = new Set(text.split(' '));
  if (query.split(' ').every(token => tokens.has(token))) return 2;
  return text.includes(query) ? 1 : 0;
}

export function rankSearchResults<T extends { title: string; originalTitle?: string }>(items: T[], query: string): T[] {
  const normalized = normalizeSearchText(query);
  return items.map((item, index) => ({ item, index, score: Math.max(matchScore(item.title, normalized), matchScore(item.originalTitle ?? '', normalized)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(({ item }) => item);
}

// Recents are displayed as title labels. Collapse duplicate labels even when
// older clients saved the same title under different providers/media kinds.
export function uniqueRecentSearches<T extends { item: { title: string }; searchedAt: number }>(entries: T[], limit = 8): T[] {
  const seen = new Set<string>();
  return [...entries].sort((a, b) => b.searchedAt - a.searchedAt).filter(entry => {
    const key = normalizeSearchText(entry.item.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}
