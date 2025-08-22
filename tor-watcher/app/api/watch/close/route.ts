import { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const VOD_BASE = (process.env.VOD_BASE ?? process.env.NEXT_PUBLIC_VOD_BASE ?? "http://localhost:4001").replace(/\/$/,"");

export async function POST(req: NextRequest) {
  // proxy body as-is so sendBeacon works
  const target = `${VOD_BASE}/watch/close`;
  const res = await fetch(target, { method: "POST", body: await req.text(), headers: { "content-type": "text/plain" }, keepalive: true });
  return new Response(null, { status: res.status });
}