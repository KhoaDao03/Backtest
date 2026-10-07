import { getLiveFeed } from "@/server/feed/engine";
import {
  clearPaperJournal,
  dayKeyFromMs,
  loadAllSettled,
} from "@/server/performance/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const feed = getLiveFeed();
  feed.wake();
  const url = new URL(req.url);
  const detail = url.searchParams.get("detail") === "1";

  // Prefer the in-memory card so hard-reload does not re-parse signals.jsonl
  // on the feed event loop (that was stalling SSE + Kalshi heartbeats).
  const scorecard =
    feed.getCachedPaperScorecard() ?? feed.getPaperScorecard();

  if (!detail) {
    return Response.json({
      dayKey: scorecard.dayKey,
      scorecard,
    });
  }

  const settled = loadAllSettled();
  return Response.json({
    dayKey: scorecard.dayKey,
    scorecard,
    settledCount: settled.length,
    settled: settled.slice(-50),
  });
}

/**
 * POST /api/performance
 * POST /api/performance?scope=mid-market — Mode A only (keeps EOM journal).
 * Default — full journal wipe.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const feed = getLiveFeed();
  feed.wake();

  if (scope === "mid-market" || scope === "mode-a") {
    const scorecard = feed.resetMidMarketPaper();
    return Response.json({
      ok: true,
      scope: "mid-market",
      dayKey: scorecard?.dayKey ?? "lifetime",
      scorecard,
      settledCount: loadAllSettled().length,
      clearedAtDayKey: dayKeyFromMs(),
    });
  }

  clearPaperJournal();
  const scorecard = feed.resetPaper();
  return Response.json({
    ok: true,
    scope: "all",
    dayKey: scorecard?.dayKey ?? "lifetime",
    scorecard,
    settledCount: loadAllSettled().length,
    clearedAtDayKey: dayKeyFromMs(),
  });
}
