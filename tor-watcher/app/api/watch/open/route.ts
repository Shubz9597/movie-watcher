import { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const VOD_BASE = (process.env.VOD_BASE ?? process.env.NEXT_PUBLIC_VOD_BASE ?? "http://localhost:4001").replace(/\/$/,"");

export async function POST(req: NextRequest) {
  const incoming = new URL(req.url);
  const target = `${VOD_BASE}/watch/open?${incoming.searchParams.toString()}`;
  const res = await fetch(target, { method: "POST" });
  const headers = new Headers();
  headers.set("content-type", res.headers.get("content-type") ?? "application/json; charset=utf-8");
  return new Response(res.body, { status: res.status, headers });
}