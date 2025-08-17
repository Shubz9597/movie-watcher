// scripts/imdb-db.ts (or imdb-scripts.ts)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";

const RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const DB_PATH = process.env.IMDB_DB_PATH || path.join(process.cwd(), "data", "imdb-ratings.db");

async function main() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // 1) Download whole gz into memory
  const res = await fetch(RATINGS_URL);
  if (!res.ok) throw new Error(`IMDb ratings download failed: ${res.status}`);
  const gzBuf = Buffer.from(await res.arrayBuffer());

  // 2) Gunzip to TSV text
  const tsv = zlib.gunzipSync(gzBuf).toString("utf8");

  // 3) Open DB and prepare schema
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = OFF");

  db.exec(`
    CREATE TABLE IF NOT EXISTS imdb_ratings (
      tconst TEXT PRIMARY KEY,
      rating REAL NOT NULL,
      votes  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO imdb_ratings (tconst, rating, votes) VALUES (?, ?, ?)"
  );
  const insertMany = db.transaction((rows: [string, number, number][]) => {
    for (const r of rows) insert.run(...r);
  });

  // 4) Parse lines and batch insert
  const lines = tsv.split(/\r?\n/);
  let batch: [string, number, number][] = [];
  const BATCH_SIZE = 5000;

  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i];
    if (!line) continue;
    const [tconst, avg, votes] = line.split("\t");
    if (!tconst || !avg || !votes) continue;

    const r = Number(avg);
    const v = Number(votes);
    if (!Number.isFinite(r) || !Number.isFinite(v)) continue;

    batch.push([tconst, r, v]);
    if (batch.length >= BATCH_SIZE) {
      insertMany(batch);
      batch = [];
    }
  }
  if (batch.length) insertMany(batch);

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('updated_at', datetime('now'))").run();
  db.close();

  console.log(`✓ IMDb ratings imported to ${DB_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});