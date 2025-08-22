import { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const VOD_BASE = (process.env.VOD_BASE ?? process.env.NEXT_PUBLIC_VOD_BASE ?? "http://localhost:4001").replace(/\/$/,"");

export async function POST(req: NextRequest) {
  const incoming = new URL(req.url);
  const target = `${VOD_BASE}/watch/ping?${incoming.searchParams.toString()}`;
  const res = await fetch(target, { method: "POST", keepalive: true });
  return new Response(null, { status: res.status });
}