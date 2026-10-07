import { sigmaT } from "./indicators";
import { normalCdf, normalInv } from "./math";
import type { DeltaTarget, MarketSnapshot, Side } from "./types";

/**
 * P(contract bid reaches entry + target¢ before the window ends).
 * Strike-aware: lean-scaled drift, implied-prob invert, remaining-time vol.
 */
export function modeAHitProb(args: {
  m: MarketSnapshot;
  lean: number;
  side: Side;
  ask: number;
  targetCents: DeltaTarget;
}): number {
  const { m, lean, side, ask, targetCents } = args;
  const level = ask + targetCents / 100;
  if (level >= 0.985) return 0;

  const tSec = Math.max(m.secondsLeft, 1);
  const sigNow = Math.max(sigmaT(m.atr1m, tSec), 1e-9);
  const sigPath = Math.max(sigmaT(m.atr1m, tSec), 1e-9);
  const drift = lean * sigPath;

  if (side === "up") {
    const zHit = normalInv(level);
    const spotNeeded = m.strike + sigNow * zHit;
    const expectedSpot = m.spot + drift;
    return normalCdf((expectedSpot - spotNeeded) / sigPath);
  }

  const zHit = normalInv(1 - level);
  const spotCeiling = m.strike + sigNow * zHit;
  const expectedSpot = m.spot + drift;
  return normalCdf((spotCeiling - expectedSpot) / sigPath);
}
