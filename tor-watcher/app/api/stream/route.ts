import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Where your Go streamer runs
const VOD_BASE =
  process.env.VOD_BASE ??
  process.env.NEXT_PUBLIC_VOD_BASE ??
  "http://localhost:4001";

// ---- small helper to build a URL with modified path/search ----
function makeTarget(base: string, path: string, search: URLSearchParams) {
  const qs = new URLSearchParams(search); // clone
  const s = qs.toString();
  const b = base.replace(/\/$/, "");
  return `${b}${path}${s ? `?${s}` : ""}`;
}

export async function GET(req: NextRequest) {
  const incoming = new URL(req.url);
  const isPrefetch =
    incoming.searchParams.get("prefetch") === "1" ||
    incoming.searchParams.get("prefetch") === "true";

  if (isPrefetch) {
    // --- PREFETCH: forward to Go's /prefetch and return JSON as-is ---
    const search = new URLSearchParams(incoming.searchParams);
    search.delete("prefetch"); // Go expects /prefetch without this flag
    const target = makeTarget(VOD_BASE, "/prefetch", search);

    const res = await fetch(target, {
      method: "GET",
      headers: { "cache-control": "no-store" },
      redirect: "manual",
    });

    const headers = new Headers();
    const ct = res.headers.get("content-type") || "application/json; charset=utf-8";
    const cl = res.headers.get("content-length");
    headers.set("content-type", ct);
    if (cl) headers.set("content-length", cl);
    // pass through simple cache header if present
    const cc = res.headers.get("cache-control");
    if (cc) headers.set("cache-control", cc);

    return new Response(res.body, { status: res.status, headers });
  }

  // --- STREAM: forward to Go's /stream and proxy bytes + range headers ---
  const target = makeTarget(VOD_BASE, "/stream", incoming.searchParams);
  const range = req.headers.get("range") ?? undefined;

  const res = await fetch(target, {
    method: "GET",
    headers: range ? { range } : undefined,
    redirect: "manual",
  });

  // Pass through the important streaming headers (added X-File-*)
  const headers = new Headers();
  for (const [k, v] of res.headers.entries()) {
    switch (k.toLowerCase()) {
      case "content-type":
      case "content-length":
      case "accept-ranges":
      case "content-range":
      case "cache-control":
      case "content-disposition":
      case "x-file-index":
      case "x-file-name":
      case "x-buffer-target-bytes":
      case "x-buffered-ahead-probe":
        headers.set(k, v);
        break;
    }
  }

  return new Response(res.body, { status: res.status, headers });
}

// Optional: some players send HEAD first.
// We just mirror the GET (stream) headers without a body.
export async function HEAD(req: NextRequest) {
  const incoming = new URL(req.url);
  const target = makeTarget(VOD_BASE, "/stream", incoming.searchParams);
  const range = req.headers.get("range") ?? undefined;

  const res = await fetch(target, {
    method: "HEAD",
    headers: range ? { range } : undefined,
    redirect: "manual",
  });

  const headers = new Headers();
  for (const [k, v] of res.headers.entries()) {
    switch (k.toLowerCase()) {
      case "content-type":
      case "content-length":
      case "accept-ranges":
      case "content-range":
      case "cache-control":
      case "content-disposition":
      case "x-file-index":
      case "x-file-name":
      case "x-buffer-target-bytes":
      case "x-buffered-ahead-probe":
        headers.set(k, v);
        break;
    }
  }
  return new Response(null, { status: res.status, headers });
}
