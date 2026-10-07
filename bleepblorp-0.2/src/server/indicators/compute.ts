import type { Candle } from "./candles";

/** Stochastic RSI %K (smooth 3) — returns latest and previous for lean direction. */
export function stochRsi(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  smoothK = 3,
): { k: number; kPrev: number } | null {
  const minBars = rsiPeriod + stochPeriod + smoothK + 2;
  if (closes.length < minBars) return null;

  // Incremental RSI series (one Wilder pass) — faster + stable
  const rsiSeries: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    if (i <= rsiPeriod) {
      avgGain += gain;
      avgLoss += loss;
      if (i === rsiPeriod) {
        avgGain /= rsiPeriod;
        avgLoss /= rsiPeriod;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsiSeries.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
      }
    } else {
      avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
      avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsiSeries.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
    }
  }
  if (rsiSeries.length < stochPeriod + smoothK) return null;

  const stochRaw: number[] = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    stochRaw.push(hi === lo ? 50 : ((rsiSeries[i]! - lo) / (hi - lo)) * 100);
  }

  const kSeries: number[] = [];
  for (let i = smoothK - 1; i < stochRaw.length; i++) {
    const window = stochRaw.slice(i - smoothK + 1, i + 1);
    kSeries.push(window.reduce((a, b) => a + b, 0) / smoothK);
  }
  if (kSeries.length < 2) return null;
  return {
    k: kSeries[kSeries.length - 1]!,
    kPrev: kSeries[kSeries.length - 2]!,
  };
}

export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { mid: number; upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** ATR (Wilder) in price units. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]!) / period;
  }
  return atrVal;
}

/**
 * Wilder ATR on only the last `period+1` bars.
 * Same wall-clock CFB minutes → same atr1m regardless of process uptime
 * (no need to restart bots together).
 */
export function atrRolling(candles: Candle[], period = 14): number | null {
  return atr(candles.slice(-(period + 1)), period);
}

export function computeIndicators(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const stoch = stochRsi(closes);
  const bb = bollinger(closes);
  const atrVal = atr(candles);
  return { stoch, bb, atr: atrVal };
}
