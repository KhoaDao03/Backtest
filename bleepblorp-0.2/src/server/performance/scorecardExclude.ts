import type { PaperTicket } from "@/lib/performanceTypes";

/**
 * Tickets that must not affect the live epoch scorecard / Rec.
 *
 * 2026-09-15 ~02:08–02:18 UTC deploy downtime cut the end of series *2215*;
 * opens were force-settled as market_rollover with truncated paths.
 */
export function isEpochVoidedTicket(t: PaperTicket): boolean {
  if (t.outcome === "void") return true;
  const ticker = t.marketTicker ?? "";
  if (!ticker.includes("26SEP142215")) return false;
  return (
    t.settleReason === "market_rollover" ||
    t.settleReason === "downtime_void"
  );
}
