import {
  MODE_A_EXPLORER,
  MODE_A_EXPLORER_MIN_SEC,
  MODE_A_REV_ENABLED,
  MODE_A_UNLIT_DEBOUNCE_MS,
  type AssetSymbol,
  type DecisionResult,
  type ModeALane,
  type ModeARecommendation,
} from "@/lib/types";

type Episode = {
  rec: ModeARecommendation;
  marketTicker: string;
  /** First tick the live rule went Wait; null while still Buy. */
  unlitSinceMs: number | null;
};

function laneKey(symbol: AssetSymbol, lane: ModeALane): string {
  return `${symbol}:${lane}`;
}

export function readModeALane(
  decision: DecisionResult,
  lane: ModeALane,
): ModeARecommendation {
  if (lane === "mom") return decision.modeAMom ?? decision.modeA;
  return (
    decision.modeARev ?? {
      action: "wait",
      confidence: 0,
      reason: "Wait.",
      factors: [],
    }
  );
}

export function patchModeALane(
  decision: DecisionResult,
  lane: ModeALane,
  rec: ModeARecommendation,
): DecisionResult {
  if (lane === "mom") return { ...decision, modeA: rec, modeAMom: rec };
  return { ...decision, modeARev: rec };
}

/**
 * One lighting episode per mid-market lane: the box stays Buy while the live
 * rule still says Buy (same side). A brief Wait does not unlight it; a Wait
 * that lasts MODE_A_UNLIT_DEBOUNCE_MS does, so the next Buy is a new rec.
 * The rec locked at light-up (side, ask, target) stays on screen for the
 * whole episode so a drifting book is not a new call.
 */
export class ModeAStickyGate {
  private episodes = new Map<string, Episode>();

  /** Clear the lit episode (paper stop, or caller wants the box dark). */
  clear(symbol: AssetSymbol, lane?: ModeALane) {
    if (lane) {
      this.episodes.delete(laneKey(symbol, lane));
      return;
    }
    this.episodes.delete(laneKey(symbol, "mom"));
    this.episodes.delete(laneKey(symbol, "rev"));
  }

  apply(
    symbol: AssetSymbol,
    marketTicker: string,
    secondsLeft: number,
    decision: DecisionResult,
  ): DecisionResult {
    let next = decision;
    next = this.applyLane(symbol, marketTicker, secondsLeft, next, "mom");
    if (MODE_A_REV_ENABLED) {
      next = this.applyLane(symbol, marketTicker, secondsLeft, next, "rev");
    }
    return next;
  }

  private applyLane(
    symbol: AssetSymbol,
    marketTicker: string,
    secondsLeft: number,
    decision: DecisionResult,
    lane: ModeALane,
  ): DecisionResult {
    const now = Date.now();
    const key = laneKey(symbol, lane);
    let ep = this.episodes.get(key);

    if (ep && ep.marketTicker !== marketTicker) {
      this.episodes.delete(key);
      ep = undefined;
    }

    if (secondsLeft < MODE_A_EXPLORER_MIN_SEC) {
      this.episodes.delete(key);
      return patchModeALane(
        decision,
        lane,
        forceWait(
          readModeALane(decision, lane),
          "No new positions — open tickets still tracked.",
        ),
      );
    }

    const raw = readModeALane(decision, lane);

    if (!MODE_A_EXPLORER) {
      const modeB = decision.modeB01 ?? decision.modeB;
      const modeBLive = modeB.action === "buy" || modeB.action === "hold";
      if (
        ep &&
        ep.rec.action === "buy" &&
        modeBLive &&
        ep.rec.side &&
        modeB.side &&
        ep.rec.side !== modeB.side
      ) {
        this.episodes.delete(key);
        ep = undefined;
      }
    }

    if (raw.action === "buy" && raw.side && raw.entryAsk != null) {
      if (!ep || ep.rec.side !== raw.side) {
        ep = { rec: raw, marketTicker, unlitSinceMs: null };
      } else {
        ep = { ...ep, unlitSinceMs: null };
      }
      this.episodes.set(key, ep);
      return patchModeALane(decision, lane, ep.rec);
    }

    if (!ep || ep.rec.action !== "buy") {
      return decision;
    }

    if (ep.unlitSinceMs == null) {
      ep = { ...ep, unlitSinceMs: now };
      this.episodes.set(key, ep);
    }

    const unlitFor = now - (ep.unlitSinceMs ?? now);
    if (unlitFor < MODE_A_UNLIT_DEBOUNCE_MS) {
      return patchModeALane(decision, lane, ep.rec);
    }

    this.episodes.delete(key);
    return decision;
  }
}

function forceWait(
  rec: ModeARecommendation,
  reason: string,
  confidence = 0,
): ModeARecommendation {
  return {
    action: "wait",
    side: rec.side,
    confidence,
    reason,
    factors: rec.factors,
  };
}
