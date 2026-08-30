export type AnimeCatalogItem = {
  id: number;
  title: string;
  year?: number;
  originalLanguage?: string;
  genreIds?: number[];
  sourceProvider?: 'tmdb' | 'anilist';
  sourceKind?: 'movie' | 'tv' | 'anime';
  sourceLabel?: string;
};

export function isTmdbAnime(item: AnimeCatalogItem): boolean {
  return item.sourceProvider === 'tmdb' && item.originalLanguage === 'ja' && Boolean(item.genreIds?.includes(16));
}

export function normalizeAnimeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\b(?:season|part|cour)\s*\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// AniList is the canonical anime catalog. TMDB anime detection remains useful
// only to keep heuristic anime rows out of the general movie and TV rails.
export function selectAniListCatalog<T extends AnimeCatalogItem>(items: T[], limit?: number): T[] {
  const deduped: T[] = [];
  for (const item of items) {
    if (!deduped.some((existing) =>
      existing.id === item.id
    )) {
      deduped.push(item);
    }
  }
  return typeof limit === 'number' ? deduped.slice(0, limit) : deduped;
}
