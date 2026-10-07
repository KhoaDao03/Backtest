import type { Candle } from "@/server/indicators/candles";
import { marketAsleep } from "./indicators";
import { modeAHitProb } from "./modeAHitProb";
import { clip } from "./math";
import { signedCushion } from "./arms";
import {
  candleRangeBps,
  relativeVolume,
} from "./chop";
import {
  MODE_A_ASLEEP_ATR_RATIO,
  MODE_A_MOM_MAX_CHOP_SCORE,
  MODE_A_MOM_MAX_CROSS_COUNT,
  MODE_A_MOM_MIN_TREND_SCORE,
  MODE_A_MOM_MIN_VOLUME,
  MODE_A_REV_MAX_ATR_RATIO,
  MODE_A_REV_MAX_VOLUME,
  type ChopRegime,
  type DeltaTarget,
  type MarketSnapshot,
  type Side,
  type TrendRegime,
} from "./types";

/** Signed cushion toward `side`, in bps of spot. */
export function signedCushionBps(m: MarketSnapshot, side: Side): number {
  const spot = Math.max(m.spot, 1e-9);
  return (signedCushion(m, side) / spot) * 10_000;
}

/** Trend regime — inverse of chop: spot leaving strike with participation. */
export function computeTrendRegime(args: {
  m: MarketSnapshot;
  candles: Candle[];
  crossCount: number;
  pctTimeNearStrike: number;
  chop: ChopRegime;
}): TrendRegime {
  const { m, candles, crossCount, pctTimeNearStrike, chop } = args;
  const spot = Math.max(m.spot, 1e-9);
  const atrRatio = m.atr1m / spot;
  const rangeBps = candleRangeBps(candles, spot);
  const relVolume = relativeVolume(candles);

  const asleep = marketAsleep(m, MODE_A_ASLEEP_ATR_RATIO);
  const volBandOk =
    !asleep && atrRatio >= MODE_A_ASLEEP_ATR_RATIO && atrRatio <= MODE_A_REV_MAX_ATR_RATIO;
  const volumeOk =
    relVolume >= MODE_A_MOM_MIN_VOLUME && relVolume <= MODE_A_REV_MAX_VOLUME;

  const crossScore = crossCount <= MODE_A_MOM_MAX_CROSS_COUNT ? 1 : 0;
  const awayScore = clip(1 - pctTimeNearStrike / 0.4, 0, 1);
  const volumeScore = volumeOk ? 1 : 0;
  const volScore = volBandOk ? 1 : 0;
  const antiChopScore = chop.confirmed ? 0 : clip(1 - chop.score / MODE_A_MOM_MAX_CHOP_SCORE, 0, 1);

  const score =
    crossScore * 0.25 +
    awayScore * 0.2 +
    volumeScore * 0.15 +
    volScore * 0.15 +
    antiChopScore * 0.25;

  const confirmed =
    score >= MODE_A_MOM_MIN_TREND_SCORE &&
    crossCount <= MODE_A_MOM_MAX_CROSS_COUNT &&
    !chop.confirmed &&
    chop.score < MODE_A_MOM_MAX_CHOP_SCORE &&
    volBandOk &&
    volumeOk;

  return {
    crossCount,
    pctTimeNearStrike,
    rangeBps,
    relVolume,
    chopScore: chop.score,
    score,
    confirmed,
  };
}

export type MomArchetype = "runaway" | "breakout";

/** Stoch + BB confirmation for momentum continuation on `side`. */
export function momentumStochConfirms(m: MarketSnapshot, side: Side): boolean {
  const rising = m.stochK > m.stochKPrev;
  const falling = m.stochK < m.stochKPrev;
  const outsideUp = m.spot > m.bbUpper;
  const outsideDown = m.spot < m.bbLower;

  if (side === "up") {
    if (m.stochK > 80) return false;
    if (outsideUp && rising) return true;
    return m.stochK >= 45 && m.stochK <= 80 && rising;
  }
  if (m.stochK < 25) return false;
  if (outsideDown && falling) return true;
  return m.stochK >= 20 && m.stochK <= 55 && falling;
}

/** Strike-aware hit probability with trend-regime adjustments. */
export function trendHitProb(args: {
  m: MarketSnapshot;
  lean: number;
  side: Side;
  ask: number;
  targetCents: DeltaTarget;
  trend: TrendRegime;
}): number {
  const { m, lean, side, ask, targetCents, trend } = args;
  const bps = signedCushionBps(m, side);
  if (bps < 2) return 0;

  let p = modeAHitProb({ m, lean, side, ask, targetCents });

  if (bps >= 10) p += 0.08;
  else if (bps >= 5) p += 0.04;

  if (!trend.confirmed) p -= 0.06;
  if (trend.chopScore >= MODE_A_MOM_MAX_CHOP_SCORE) p -= 0.12;

  const cush = signedCushion(m, side);
  if (Math.sign(lean) !== Math.sign(cush) && cush !== 0) p -= 0.15;

  return clip(p, 0, 1);
}
