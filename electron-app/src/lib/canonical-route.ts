// Shared canonical-id → title-route mapping (feature 002): the route keeps
// kind + numeric id (M3.1.1 detail requests rebuild the media-qualified id
// from the route's explicit media namespace). The canonical id itself is
// never stripped, parsed into a provider assumption, or rebuilt as tmdb:N.
export type CanonicalRoute = {
  kind: 'movie' | 'tv' | 'anime';
  id: string;
  provider: 'tmdb' | 'anilist' | 'jikan' | 'imdb';
  mediaKind?: 'movie' | 'tv';
};

export function routeIdFromCanonical(canonicalId: string): CanonicalRoute {
  const parts = canonicalId.split(':');
  if (parts[0] === 'tmdb' && (parts[1] === 'movie' || parts[1] === 'tv')) {
    return { kind: parts[1] === 'movie' ? 'movie' : 'tv', id: parts[2] ?? '', provider: 'tmdb', mediaKind: parts[1] };
  }
  if (parts[0] === 'anilist') return { kind: 'anime', id: parts[1] ?? '', provider: 'anilist' };
  if (parts[0] === 'jikan') return { kind: 'anime', id: parts[1] ?? '', provider: 'jikan' };
  return { kind: 'movie', id: parts[1] ?? '', provider: 'imdb' };
}

// titleRouteParams builds the navigation params for a canonical id, carrying
// the provider/mediaKind namespace for TMDb-backed anime routes. The optional
// `type` is the server's canonical classification: a TMDb anime is classified
// anime OVER its structural tmdb:tv/tmdb:movie identity — the route kind must
// be `anime` (so TitlePage renders the anime classification) while the
// QUALIFIED tmdb identity is preserved through provider+mediaKind. Without a
// type the route kind comes from the id's structural media namespace.
export function titleRouteParams(canonicalId: string, type?: 'movie' | 'series' | 'anime'): Record<string, string> {
  const route = routeIdFromCanonical(canonicalId);
  const params: Record<string, string> = {};
  if (type === 'anime' && route.provider === 'tmdb') {
    params.kind = 'anime';
    params.provider = 'tmdb';
    params.mediaKind = route.mediaKind ?? (route.kind === 'movie' ? 'movie' : 'tv');
  } else {
    params.kind = route.kind;
  }
  params.id = route.id;
  return params;
}
