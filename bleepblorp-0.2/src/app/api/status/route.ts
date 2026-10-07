import { getLiveFeed } from "@/server/feed/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const feed = getLiveFeed();
  return Response.json({ ok: true, ...feed.getPulse() });
}
