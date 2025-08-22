import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OS_API = process.env.OPENSUB_API_URL || "https://api.opensubtitles.com/api/v1";
const OS_KEY = process.env.OPENSUB_API_KEY || "";
const OS_USER_TOKEN = process.env.OPENSUB_USER_TOKEN || ""; // optional

// Shape your hook expects (at minimum: lang + url)
type Subtrack = {
  lang: string;         // "en", "hi", ...
  label?: string;       // e.g. "English (HI) · 12k dl"
  url: string;          // points to /api/opensub?file_id=...&vtt=true
  source?: "opensub";
};

function stripTT(id: string) {
  const m = id.match(/\d+/);
  return m ? m[0] : id;
}

// If you pass s/e for TV, OS wants parent_imdb_id + season_number + episode_number.
// Otherwise, for movies, imdb_id alone is fine.
function buildSearchUrl(u: URL) {
  const imdbId = u.searchParams.get("imdbId") || "";
  const s = u.searchParams.get("s"); // season
  const e = u.searchParams.get("e"); // episode
  const langs = u.searchParams.get("langs") || ""; // "en,hi"

  const url = new URL(`${OS_API.replace(/\/$/, "")}/subtitles`);
  const imdbNumeric = stripTT(imdbId);

  if (s && e) {
    url.searchParams.set("parent_imdb_id", imdbNumeric);
    url.searchParams.set("season_number", String(Number(s)));
    url.searchParams.set("episode_number", String(Number(e)));
  } else {
    url.searchParams.set("imdb_id", imdbNumeric);
  }

  if (langs) url.searchParams.set("languages", langs); // OS accepts comma-separated
  // Popular first
  url.searchParams.set("order_by", "download_count");
  url.searchParams.set("order_direction", "desc");
  // Keep results reasonable
  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", "50");

  return url;
}

export async function GET(req: NextRequest) {
  if (!OS_KEY) return NextResponse.json({ error: "OPENSUB_API_KEY missing" }, { status: 500 });

  const u = new URL(req.url);
  const imdbId = u.searchParams.get("imdbId");
  if (!imdbId) return NextResponse.json({ subtitles: [] });

  const searchUrl = buildSearchUrl(u);
  const r = await fetch(searchUrl, {
    headers: {
      "Api-Key": OS_KEY,
      ...(OS_USER_TOKEN ? { Authorization: `Bearer ${OS_USER_TOKEN}` } : {}),
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!r.ok) return NextResponse.json({ subtitles: [] }, { status: 200 });

  const data = await r.json().catch(() => ({} as any));
  const rows: any[] = data?.data || [];

  // Dedup per language; pick the first file_id of each record
  const seenLang = new Set<string>();
  const out: Subtrack[] = [];

  for (const row of rows) {
    const a = row?.attributes || {};
    const files = a?.files || [];
    if (!files.length) continue;

    // OS tends to provide ISO-639-1 (e.g., "en"), but sometimes 3-letter; normalize to 2-letter if needed
    let lang: string = String(a.language || "").toLowerCase();
    if (lang.length === 3) {
      const map: Record<string, string> = { eng: "en", hin: "hi", spa: "es", fra: "fr", deu: "de", ita: "it", por: "pt", rus: "ru", jpn: "ja", kor: "ko", chi: "zh" };
      lang = map[lang] || lang;
    }

    if (!lang) continue;
    if (seenLang.has(lang)) continue; // keep the most popular one per lang (we already sorted)

    const fileId = files[0]?.file_id;
    if (!fileId) continue;

    const dl = a?.download_count ?? a?.downloads ?? 0;
    const hi = a?.hearing_impaired ? " (HI)" : "";
    const label = `${a?.language_name || lang.toUpperCase()}${hi} · ${dl} dl`;

    // Build a ready-to-use URL that hits your cached downloader/converter
    const baseName =
      (a?.feature_details?.title || a?.release || "subtitles")
        .toString()
        .replace(/[^\w.-]/g, "_");

    const url = new URL(req.url);
    url.pathname = "/api/opensub";
    url.search = "";
    url.searchParams.set("file_id", String(fileId));
    url.searchParams.set("name", `${baseName}.${lang}`);
    url.searchParams.set("vtt", "true"); // browser-ready by default

    out.push({ lang, label, url: url.toString(), source: "opensub" });
    seenLang.add(lang);
  }

  return NextResponse.json({ subtitles: out });
}