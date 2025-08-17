import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DEFAULT_PATH = path.join(process.cwd(), "data", "imdb-ratings.db");
const DB_PATH = process.env.IMDB_DB_PATH || DEFAULT_PATH;

let db: Database.Database | null = null;

function connect() {
  if (db) return db;
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`IMDb DB not found at ${DB_PATH}. Run npm run imdb:build first.`);
  }
  db = new Database(DB_PATH, { readonly: true });
  return db;
}

export type ImdbRatingRow = { rating: number; votes: number } | null;

export function getImdbRating(imdbId: string): ImdbRatingRow {
  const tconst = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
  const row = connect().prepare("SELECT rating, votes FROM imdb_ratings WHERE tconst = ?").get(tconst) as { rating: number; votes: number } | undefined;
  return row ? { rating: row.rating, votes: row.votes } : null;
}