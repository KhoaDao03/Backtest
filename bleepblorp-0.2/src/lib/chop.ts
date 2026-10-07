import type { Candle } from "@/server/indicators/candles";
import { marketAsleep, sigmaT } from "./indicators";
import { modeAHitProb } from "./modeAHitProb";
import { clip } from "./math";
import { convergenceEtaSec } from "./convergence";
import { signedCushion } from "./arms";
import {
  MODE_A_ASLEEP_ATR_RATIO,
  MODE_A_REV_MAX_ATR_RATIO,
  MODE_A_REV_MIN_CHOP_SCORE,
  MODE_A_REV_MIN_CROSS_COUNT,
  MODE_A_REV_MIN_VOLUME,
  MODE_A_REV_MAX_VOLUME,
  MODE_A_REV_RANGE_BPS_MAX,
  MODE_A_REV_RANGE_BPS_MIN,
  type ChopRegime,
  type DeltaTarget,
  type MarketSnapshot,
  type Side,
} from "./types";

export function relativeVolume(candles: Candle[]): number {
  const withVol = candles.filter((c) => (c.volume ?? 0) > 0);
  if (withVol.length < 21) return 1;
  const recent = withVol.slice(-3);
  const base = withVol.slice(-23, -3);
  const rAvg = recent.reduce((s, c) => s + (c.volume ?? 0), 0) / recent.length;
  const bAvg = base.reduce((s, c) => s + (c.volume ?? 0), 0) / base.length;
  return bAvg > 0 ? rAvg / bAvg : 1;
}

export function candleRangeBps(candles: Candle[], spot: number): number {
  const slice = candles.slice(-10);
  if (slice.length < 5 || spot <= 0) return 0;
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  return ((hi - lo) / spot) * 10_000;
}

export function strikeInRange(candles: Candle[], strike: number): boolean {
  const slice = candles.slice(-10);
  if (slice.length < 5) return false;
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  return strike >= lo && strike <= hi;
}

/** Chop regime from live spot path, candles, and strike-cross history. */
export function computeChopRegime(args: {
  m: MarketSnapshot;
  candles: Candle[];
  crossCount: number;
  pctTimeNearStrike: number;
}): ChopRegime {
  const { m, candles, crossCount, pctTimeNearStrike } = args;
  const spot = Math.max(m.spot, 1e-9);
  const atrRatio = m.atr1m / spot;
  const rangeBps = candleRangeBps(candles, spot);
  const relVolume = relativeVolume(candles);
  const inRange = strikeInRange(candles, m.strike);

  const asleep = marketAsleep(m, MODE_A_ASLEEP_ATR_RATIO);
  const volBandOk =
    !asleep && atrRatio >= MODE_A_ASLEEP_ATR_RATIO && atrRatio <= MODE_A_REV_MAX_ATR_RATIO;
  const rangeOk =
    rangeBps >= MODE_A_REV_RANGE_BPS_MIN && rangeBps <= MODE_A_REV_RANGE_BPS_MAX;
  const volumeOk =
    relVolume >= MODE_A_REV_MIN_VOLUME && relVolume <= MODE_A_REV_MAX_VOLUME;

  const crossScore = clip(crossCount / 3, 0, 1);
  const nearScore = clip(pctTimeNearStrike / 0.4, 0, 1);
  const rangeScore = rangeOk && inRange ? 1 : 0;
  const volumeScore = volumeOk ? 1 : 0;
  const volScore = volBandOk ? 1 : 0;

  const score =
    (crossScore * 0.3 +
      nearScore * 0.2 +
      rangeScore * 0.2 +
      volumeScore * 0.15 +
      volScore * 0.15);

  const confirmed =
    score >= MODE_A_REV_MIN_CHOP_SCORE &&
    crossCount >= MODE_A_REV_MIN_CROSS_COUNT &&
    inRange &&
    volBandOk &&
    volumeOk;

  return {
    crossCount,
    pctTimeNearStrike,
    rangeBps,
    relVolume,
    score,
    confirmed,
  };
}

export type ChopArchetype = "decay" | "fade";

/** Strike-aware hit probability with chop-regime adjustments. */
export function chopHitProb(args: {
  m: MarketSnapshot;
  lean: number;
  side: Side;
  ask: number;
  targetCents: DeltaTarget;
  chop: ChopRegime;
  spread: number;
}): number {
  const { m, lean, side, ask, targetCents, chop, spread } = args;
  let p = modeAHitProb({ m, lean, side, ask, targetCents });
  const cush = signedCushion(m, side);
  const sig = Math.max(sigmaT(m.atr1m, m.secondsLeft), 1e-9);

  if (cush <= 0 && chop.confirmed) {
    const crossBoost = Math.min(chop.crossCount / 4, 0.15);
    const stretchPenalty = Math.max(0, Math.abs(m.spot - m.strike) / sig - 1) * 0.1;
    p = clip(p + crossBoost - stretchPenalty, 0, 1);
  } else if (cush > 0) {
    const eta = convergenceEtaSec({
      cushion: cush,
      atr1m: m.atr1m,
      entryAsk: ask,
      targetCents,
      spread,
    });
    if (eta != null && eta <= m.secondsLeft) {
      p = clip(p + 0.05, 0, 1);
    }
  }

  return p;
}
