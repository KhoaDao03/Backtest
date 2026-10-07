/**
 * Competing mid-market selection rules, graded against one shared tick stream.
 *
 * Running these as separate live bots would give each arm its own sample, and
 * most of the difference between them would come down to which windows each
 * happened to catch. Scoring them on identical quotes makes the comparison
 * paired instead: on the exact moments where two arms disagreed, we can see who
 * was right, which settles the question on far less data.
 *
 * The arms differ only in selection. Target sizing, stops and settlement are
 * shared, so a difference in results can't be an artifact of trade management.
 */

import { reachProbability } from "./convergence";
import {
  MODE_A_HARD_MIN_ASK,
  MODE_A_MIN_REACH_PROB,
  SCANNER_ARMS,
  type ArmId,
  type DeltaTarget,
  type MarketSnapshot,
  type ModeARecommendation,
  type Side,
} from "./types";

export interface ArmVerdict {
  take: boolean;
  /** Reach probability for this arm's view of the candidate, 0–1. */
  prob: number;
  reason: string;
}

export interface ArmInput {
  m: MarketSnapshot;
  side: Side;
  targetCents: DeltaTarget;
  /** Indicator lean in [-1, 1]; positive favours Up. */
  lean: number;
  /** Protocol-13 (0.1) recommendation for this same snapshot. */
  control: ModeARecommendation;
  /** Protocol-13-with-widened-gates recommendation for this same snapshot. */
  wide: ModeARecommendation;
}

/** Whether a baseline's recommendation is the same ticket a scanner arm is eyeing. */
function agreesWith(
  rec: ModeARecommendation,
  side: Side,
  targetCents: DeltaTarget,
): boolean {
  return rec.action === "buy" && rec.side === side && rec.targetCents === targetCents;
}

function quote(m: MarketSnapshot, side: Side): { ask: number; bid: number } {
  return side === "up"
    ? { ask: m.askUp, bid: m.bidUp }
    : { ask: m.askDown, bid: m.bidDown };
}

/** Distance from strike measured toward the side we're buying. */
export function signedCushion(m: MarketSnapshot, side: Side): number {
  const raw = m.spot - m.strike;
  return side === "up" ? raw : -raw;
}

/**
 * Arm S — price and time only. No indicators, no directional view.
 * Edge, if any, comes from volatility shrinking on a contract that is already ahead.
 */
export function armStripped(input: ArmInput): ArmVerdict {
  const { m, side, targetCents } = input;
  const { ask, bid } = quote(m, side);
  const prob = reachProbability({
    midNow: (ask + bid) / 2,
    entryAsk: ask,
    targetCents,
    spread: ask - bid,
  });
  const take = prob >= MODE_A_MIN_REACH_PROB;
  return {
    take,
    prob,
    reason: take
      ? `${(prob * 100).toFixed(0)}% to reach +${targetCents}¢ on price and clock alone.`
      : `${(prob * 100).toFixed(0)}% is under the ${(MODE_A_MIN_REACH_PROB * 100).toFixed(0)}% bar.`,
  };
}

/**
 * Arm I — the same calculation, plus a Stoch RSI / Bollinger lean fed in as
 * expected drift over the remaining window. Identical threshold to Arm S, so
 * the only thing under test is whether the indicators carry information.
 */
export function armIndicators(input: ArmInput): ArmVerdict {
  const { m, side, targetCents, lean } = input;
  const { ask, bid } = quote(m, side);
  // Lean points at Up; flip it when we're buying Down so drift always favours our side.
  const drift = side === "up" ? lean : -lean;
  const prob = reachProbability({
    midNow: (ask + bid) / 2,
    entryAsk: ask,
    targetCents,
    spread: ask - bid,
    driftSigma: drift,
  });
  if (ask < MODE_A_HARD_MIN_ASK) {
    return {
      take: false,
      prob,
      reason: "Ask below 35¢ — Indicators does not take lottery tickets.",
    };
  }
  const take = prob >= MODE_A_MIN_REACH_PROB;
  return {
    take,
    prob,
    reason: take
      ? `${(prob * 100).toFixed(0)}% to reach +${targetCents}¢ with the indicator lean applied.`
      : `${(prob * 100).toFixed(0)}% with lean is under the ${(MODE_A_MIN_REACH_PROB * 100).toFixed(0)}% bar.`,
  };
}

/** Arm C — protocol 13 (0.1), the version with a measured edge, as the bar for progress. */
export function armControl(input: ArmInput): ArmVerdict {
  const { control, side, targetCents } = input;
  const agrees = agreesWith(control, side, targetCents);
  return {
    take: agrees,
    prob: control.confidence / 100,
    reason: agrees
      ? `Protocol 13 also buys ${side} for +${targetCents}¢.`
      : control.action === "buy"
        ? `Protocol 13 buys a different ticket (${control.side} +${control.targetCents}¢).`
        : "Protocol 13 waits here.",
  };
}

/** Arm P — 0.1's rule with the price band and clock opened up. */
export function armWide(input: ArmInput): ArmVerdict {
  const { wide, side, targetCents } = input;
  const agrees = agreesWith(wide, side, targetCents);
  return {
    take: agrees,
    prob: wide.confidence / 100,
    reason: agrees
      ? `Wide 0.1 also buys ${side} for +${targetCents}¢.`
      : wide.action === "buy"
        ? `Wide 0.1 buys a different ticket (${wide.side} +${wide.targetCents}¢).`
        : "Wide 0.1 waits here.",
  };
}

export function evaluateArms(input: ArmInput): Record<ArmId, ArmVerdict> {
  return {
    S: armStripped(input),
    I: armIndicators(input),
    C: armControl(input),
    P: armWide(input),
  };
}

/**
 * Only the model arms can open an explorer ticket. C and P are scored on the
 * trades their protocols actually take through their own paths, so folding them
 * in here would mix "0.1 happened to agree with this" into a row that is
 * supposed to mean "this is what 0.1 earned".
 */
export function approvingArms(verdicts: Record<ArmId, ArmVerdict>): ArmId[] {
  return SCANNER_ARMS.filter((id) => verdicts[id].take);
}
