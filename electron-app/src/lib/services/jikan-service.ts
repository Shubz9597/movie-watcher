// Jikan API service for anime - standalone, no Next.js needed
const JIKAN_BASE = 'https://api.jikan.moe/v4';

export async function getAnime(id: number) {
  const res = await fetch(`${JIKAN_BASE}/anime/${id}/full`);
  if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
  const data = await res.json();
  return data.data;
}

export async function getAnimeList(page = 1, sort = 'bypopularity') {
  const res = await fetch(`${JIKAN_BASE}/top/anime?page=${page}&filter=${sort}`);
  if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
  const data = await res.json();
  return data;
}

export async function getAnimeEpisodes(malId: number, page = 1) {
  const res = await fetch(`${JIKAN_BASE}/anime/${malId}/episodes?page=${page}`);
  if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
  const data = await res.json();
  return data;
}

export async function searchAnime(query: string, page = 1, limit = 24) {
  const res = await fetch(
    `${JIKAN_BASE}/anime?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}&order_by=score&sort=desc`
  );
  if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
  return res.json();
}



