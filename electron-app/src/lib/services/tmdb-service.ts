// TMDb API service - standalone, no Next.js needed
import { getConfig } from '../config';

const TMDB_BASE = 'https://api.themoviedb.org/3';

async function getAuthHeaders(): Promise<HeadersInit> {
  const accessToken = await getConfig('TMDB_ACCESS_TOKEN');
  if (accessToken && accessToken.trim()) {
    return { Authorization: `Bearer ${accessToken.trim()}` };
  }
  return {};
}

async function buildUrl(path: string, params?: Record<string, string>): Promise<string> {
  const url = new URL(`${TMDB_BASE}${path}`);
  const apiKey = await getConfig('TMDB_API_KEY');
  const accessToken = await getConfig('TMDB_ACCESS_TOKEN');
  
  // TMDb requires either API key or access token
  if (accessToken && accessToken.trim()) {
    // Access token is used in headers, not URL
  } else if (apiKey && apiKey.trim()) {
    url.searchParams.set('api_key', apiKey.trim());
  } else {
    throw new Error('TMDb API key or access token not configured. Please set TMDB_API_KEY or TMDB_ACCESS_TOKEN in settings.');
  }
  
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  return url.toString();
}

export async function searchMulti(query: string, page = 1) {
  try {
    const url = await buildUrl('/search/multi', {
      query,
      page: String(page),
      include_adult: 'false',
      language: 'en-US',
    });
    
    const res = await fetch(url, { headers: await getAuthHeaders() });
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('TMDb API authentication failed. Please check your TMDB_API_KEY or TMDB_ACCESS_TOKEN in settings.');
      }
      throw new Error(`TMDb HTTP ${res.status}: ${res.statusText}`);
    }
  
  const data = await res.json();
  const IMG_BASE = 'https://image.tmdb.org/t/p/w185';
  
  const grouped = { movie: [] as any[], tv: [] as any[], person: [] as any[] };
  for (const item of data.results || []) {
    const basic = {
      id: item.id,
      title: item.media_type === 'movie' ? item.title : item.name,
      name: item.media_type === 'person' ? item.name : undefined,
      year: item.release_date || item.first_air_date 
        ? Number.parseInt((item.release_date || item.first_air_date).slice(0, 4), 10) 
        : undefined,
      rating: item.vote_average,
      posterUrl: item.poster_path || item.profile_path 
        ? `${IMG_BASE}${item.poster_path || item.profile_path}` 
        : null,
    };
    
    if (item.media_type === 'movie') grouped.movie.push(basic);
    else if (item.media_type === 'tv') grouped.tv.push(basic);
    else if (item.media_type === 'person') grouped.person.push(basic);
  }
  
    return grouped;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not configured')) {
      throw err;
    }
    console.error('[TMDb] Search error:', err);
    throw err;
  }
}

export async function getMovie(id: number) {
  const url = await buildUrl(`/movie/${id}`, { append_to_response: 'external_ids,credits,videos' });
  const res = await fetch(url, { headers: await getAuthHeaders() });
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}`);
  return res.json();
}

export async function getTv(id: number) {
  const url = await buildUrl(`/tv/${id}`, { append_to_response: 'external_ids,credits,videos' });
  const res = await fetch(url, { headers: await getAuthHeaders() });
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}`);
  return res.json();
}

export async function getMovies(page = 1, sort = 'trending') {
  const endpoint = sort === 'trending' ? '/trending/movie/week' : '/movie/popular';
  const url = await buildUrl(endpoint, { page: String(page) });
  const res = await fetch(url, { headers: await getAuthHeaders() });
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}`);
  return res.json();
}

export async function getTvShows(page = 1, sort = 'trending') {
  const endpoint = sort === 'trending' ? '/trending/tv/week' : '/tv/popular';
  const url = await buildUrl(endpoint, { page: String(page) });
  const res = await fetch(url, { headers: await getAuthHeaders() });
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}`);
  return res.json();
}

export async function getTvSeason(tvId: number, season: number) {
  const url = await buildUrl(`/tv/${tvId}/season/${season}`);
  const res = await fetch(url, { headers: await getAuthHeaders() });
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}`);
  return res.json();
}



