import { clip, normalCdf } from "./math";
import type { MarketSnapshot } from "./types";

export type LeanKind = "momentum" | "reversion" | "mixed" | "none";

/**
 * Continuation vs mean-reversion lean from Stoch RSI + Bollinger.
 * Returns I in [-1, 1]: positive = Up lean, negative = Down lean.
 *
 * Reversion is tuned for BB/RSI chop: band touches + Stoch extremes
 * should produce a clear fade lean so Mode A can scalp the bounce.
 */
export function indicatorLean(m: MarketSnapshot): {
  lean: number;
  label: string;
  kind: LeanKind;
} {
  const rising = m.stochK > m.stochKPrev;
  const falling = m.stochK < m.stochKPrev;

  let mom = 0;
  if (m.stochK >= 45 && m.stochK <= 80 && rising) mom = 0.55;
  else if (m.stochK >= 20 && m.stochK <= 55 && falling) mom = -0.55;
  else if (m.stochK > 55 && rising) mom = 0.35;
  else if (m.stochK < 45 && falling) mom = -0.35;

  const halfWidth = Math.max((m.bbUpper - m.bbLower) / 2, 1e-9);
  const bPos = (m.spot - m.bbMid) / halfWidth;

  let rev = 0;
  const outsideUp = m.spot > m.bbUpper;
  const outsideDown = m.spot < m.bbLower;
  const nearLower = bPos <= -0.75;
  const nearUpper = bPos >= 0.75;

  // Stoch extremes turning — classic chop fade
  if (m.stochK < 25 && rising) rev = 0.85;
  else if (m.stochK > 75 && falling) rev = -0.85;
  // Band-edge fades (inside or kissing the band)
  else if (nearLower && !outsideDown && (rising || m.stochK < 35)) rev = 0.7;
  else if (nearUpper && !outsideUp && (falling || m.stochK > 65)) rev = -0.7;
  else if (outsideDown && rising) rev = 0.55;
  else if (outsideUp && falling) rev = -0.55;
  // Soft band pressure while Stoch is stretched
  else if (nearLower && m.stochK <= 40) rev = 0.45;
  else if (nearUpper && m.stochK >= 60) rev = -0.45;

  // Breakout: price outside band + Stoch confirming → continuation, kill fade
  if (outsideUp && rising) {
    mom = Math.max(mom, 0.7);
    rev = 0;
  } else if (outsideDown && falling) {
    mom = Math.min(mom, -0.7);
    rev = 0;
  }

  const delta = 0.1;
  let lean: number;
  let label: string;
  let kind: LeanKind;

  if (Math.abs(mom) >= Math.abs(rev) + delta) {
    lean = mom;
    kind = "momentum";
    label = mom >= 0 ? "Momentum continuation → Up" : "Momentum continuation → Down";
  } else if (Math.abs(rev) > Math.abs(mom) + delta) {
    lean = rev;
    kind = "reversion";
    label = rev >= 0 ? "Mean-reversion bounce → Up" : "Mean-reversion fade → Down";
  } else if (Math.abs(mom) < 0.2 && Math.abs(rev) < 0.2) {
    lean = 0;
    kind = "none";
    label = "No clear indicator lean";
  } else if (Math.abs(rev) >= 0.45 && Math.abs(rev) >= Math.abs(mom)) {
    // Chop tie-break: prefer the fade when reversion is meaningful
    lean = rev;
    kind = "reversion";
    label = rev >= 0 ? "Mean-reversion bounce → Up" : "Mean-reversion fade → Down";
  } else {
    lean = clip(0.5 * mom + 0.5 * rev, -1, 1);
    kind = "mixed";
    label = "Mixed signals — soft blend";
  }

  return { lean: clip(lean, -1, 1), label, kind };
}

export function sigmaT(atr1m: number, secondsLeft: number): number {
  return atr1m * Math.sqrt(Math.max(secondsLeft, 1) / 60);
}

/**
 * True when 1m ATR is too thin vs spot for a mid-market Δ scalp.
 * Low-volume slides leave Stoch stuck at extremes and inflate hit odds
 * against the ATR floor — Mode A should Wait, not chase fades.
 */
export function marketAsleep(m: MarketSnapshot, ratioFloor: number): boolean {
  const spot = Math.max(m.spot, 1e-9);
  return m.atr1m / spot < ratioFloor;
}

export function baseFinishProb(spot: number, strike: number, sig: number): number {
  const z = (spot - strike) / Math.max(sig, 1e-9);
  return normalCdf(z);
}
