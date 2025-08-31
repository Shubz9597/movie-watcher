import { NextResponse } from "next/server";
import { detailFromJikan } from "@/lib/adapters/media";

export const runtime = "nodejs";

async function jikan(path: string) {
  const r = await fetch(`https://api.jikan.moe/v4${path}`, { next: { revalidate: 300 } });
  if (!r.ok) throw new Error(`Jikan ${r.status}`);
  return r.json();
}

export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    const data = await jikan(`/anime/${params.id}/full`);
    const a = data?.data;
    return NextResponse.json(detailFromJikan(a));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "anime detail failed" }, { status: 500 });
  }
}