// Deterministic upstream provider stub (validation ONLY).
//
// Serves the subset of the TMDb API the staging backend needs so automated
// validation can exercise catalog, title detail, Library writes and
// recommendations without real provider credentials. Evidence produced
// through this stub must be labelled STUB-BACKED. It is never used when a
// real TMDB_API_KEY is configured, and it is never part of normal staging.
import http from "node:http";

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const port = Number(readOption("--port", "4499"));

function movie(id) {
  const numeric = Number(id.replace(/\D/g, "")) || 1;
  return {
    id: numeric,
    title: `Staging Movie ${numeric}`,
    original_title: `Staging Movie ${numeric}`,
    release_date: "2024-01-01",
    overview: `Deterministic staging overview for movie ${numeric}.`,
    poster_path: null,
    backdrop_path: null,
    original_language: "en",
    runtime: 100,
    genres: [{ id: 28, name: "Action" }, { id: 878, name: "Science Fiction" }],
    homepage: "",
  };
}

function tv(id) {
  const numeric = Number(id.replace(/\D/g, "")) || 1;
  return {
    id: numeric,
    name: `Staging Series ${numeric}`,
    original_name: `Staging Series ${numeric}`,
    first_air_date: "2023-01-01",
    overview: `Deterministic staging overview for series ${numeric}.`,
    poster_path: null,
    backdrop_path: null,
    original_language: "en",
    episode_run_time: [45],
    genres: [{ id: 18, name: "Drama" }],
    homepage: "",
    seasons: [{ season_number: 1, name: "Season 1", episode_count: 8, air_date: "2023-01-01" }],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (body, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") {
    return json({ status: "ok" });
  }
  if (url.pathname === "/3/genre/movie/list") {
    return json({ genres: [{ id: 28, name: "Action" }, { id: 878, name: "Science Fiction" }, { id: 18, name: "Drama" }] });
  }
  if (url.pathname === "/3/genre/tv/list") {
    return json({ genres: [{ id: 18, name: "Drama" }, { id: 10759, name: "Action & Adventure" }] });
  }
  if (url.pathname === "/3/search/multi") {
    const q = url.searchParams.get("query") || "";
    const seed = (q.length % 5) + 1;
    return json({ results: [
      { media_type: "movie", id: seed, title: `Staging Movie ${seed} (${q})`, release_date: "2024-01-01", overview: "stub", genre_ids: [28, 878], original_language: "en" },
      { media_type: "tv", id: seed + 10, name: `Staging Series ${seed + 10} (${q})`, first_air_date: "2023-01-01", overview: "stub", genre_ids: [18], original_language: "en" },
    ]});
  }
  if (url.pathname === "/3/trending/all/week" || url.pathname === "/3/trending/all/day") {
    return json({ page: 1, total_pages: 1, results: [
      { media_type: "movie", id: 101, title: "Staging Popular One", release_date: "2024-01-01", genre_ids: [28], original_language: "en" },
      { media_type: "movie", id: 102, title: "Staging Popular Two", release_date: "2024-02-01", genre_ids: [878], original_language: "en" },
      { media_type: "movie", id: 103, title: "Staging Popular Three", release_date: "2024-03-01", genre_ids: [28, 878], original_language: "en" },
    ]});
  }
  if (url.pathname === "/3/discover/movie" || url.pathname === "/3/discover/tv") {
    // Genre/See-All sections (M0.2 desktop smoke): deterministic per genre so
    // genre rails render without egress. Same shape as real discover.
    const page = Number(url.searchParams.get("page") || "1");
    const genre = url.pathname.endsWith("/tv") ? "Series" : "Movie";
    const withGenres = Number(url.searchParams.get("with_genres") || "28");
    return json({ page, total_pages: 2, results: [
      { media_type: url.pathname.endsWith("/tv") ? "tv" : "movie", id: withGenres * 10 + page,
        title: `Staging ${genre} Genre ${withGenres} P${page}`, name: `Staging ${genre} Genre ${withGenres} P${page}`,
        release_date: "2024-05-01", first_air_date: "2024-05-01", genre_ids: [withGenres], original_language: "en" },
      { media_type: url.pathname.endsWith("/tv") ? "tv" : "movie", id: withGenres * 10 + page + 100,
        title: `Staging ${genre} Genre ${withGenres} P${page} B`, name: `Staging ${genre} Genre ${withGenres} P${page} B`,
        release_date: "2024-06-01", first_air_date: "2024-06-01", genre_ids: [withGenres], original_language: "en" },
    ]});
  }
  const movieMatch = url.pathname.match(/^\/3\/movie\/(\d+)$/);
  if (movieMatch) return json(movie(movieMatch[1]));
  const tvMatch = url.pathname.match(/^\/3\/tv\/(\d+)$/);
  if (tvMatch) return json(tv(tvMatch[1]));
  if (url.pathname.startsWith("/3/tv/")) {
    // season fetch: /3/tv/<id>/season/<n>
    return json({ season_number: 1, episodes: [
      { episode_number: 1, season_number: 1, name: "Episode 1", air_date: "2023-01-01", runtime: 45 },
      { episode_number: 2, season_number: 1, name: "Episode 2", air_date: "2023-01-08", runtime: 45 },
    ]});
  }
  json({ status_code: 34 }, 404);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[provider-stub] deterministic TMDb stub on http://127.0.0.1:${port} (validation only)`);
});
