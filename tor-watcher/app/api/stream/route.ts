import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Where your Go streamer runs
const VOD_BASE =
  process.env.VOD_BASE ??
  process.env.NEXT_PUBLIC_VOD_BASE ??
  "http://localhost:4001";

export async function GET(req: NextRequest) {
  // Build target: /stream?magnet=...&fileIndex=...&cat=movie
  const incoming = new URL(req.url);
  const target = `${VOD_BASE.replace(/\/$/, "")}/stream${incoming.search}`;

  // Forward Range header so seeking works
  const range = req.headers.get("range") ?? undefined;

  const res = await fetch(target, {
    method: "GET",
    headers: range ? { range } : undefined,
    redirect: "manual",
  });

  // Pass through the important streaming headers
  const headers = new Headers();
  for (const [k, v] of res.headers.entries()) {
    switch (k.toLowerCase()) {
      case "content-type":
      case "content-length":
      case "accept-ranges":
      case "content-range":
      case "cache-control":
      case "content-disposition":
        headers.set(k, v);
        break;
    }
  }

  return new Response(res.body, { status: res.status, headers });
}