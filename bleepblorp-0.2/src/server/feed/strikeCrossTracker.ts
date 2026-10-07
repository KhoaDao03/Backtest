/** Rolling strike-cross and near-strike stats for chop regime detection. */

export interface StrikeCrossSample {
  crossCount: number;
  pctTimeNearStrike: number;
}

type SideOfStrike = "above" | "below";

interface TickerState {
  prevSide: SideOfStrike | null;
  crossCount: number;
  nearStrikeSamples: number;
  totalSamples: number;
}

export class StrikeCrossTracker {
  private byTicker = new Map<string, TickerState>();

  reset(marketTicker: string) {
    this.byTicker.delete(marketTicker);
  }

  /** Call on market rollover before binding the new ticker. */
  resetSymbolTickers(activeTickers: Iterable<string>) {
    const keep = new Set(activeTickers);
    for (const key of this.byTicker.keys()) {
      if (!keep.has(key)) this.byTicker.delete(key);
    }
  }

  sample(
    marketTicker: string,
    spot: number,
    strike: number,
    sigmaT: number,
  ): StrikeCrossSample {
    if (!Number.isFinite(spot) || !Number.isFinite(strike) || strike <= 0) {
      return { crossCount: 0, pctTimeNearStrike: 0 };
    }

    let st = this.byTicker.get(marketTicker);
    if (!st) {
      st = { prevSide: null, crossCount: 0, nearStrikeSamples: 0, totalSamples: 0 };
      this.byTicker.set(marketTicker, st);
    }

    const side: SideOfStrike = spot >= strike ? "above" : "below";
    if (st.prevSide != null && st.prevSide !== side) {
      st.crossCount++;
    }
    st.prevSide = side;
    st.totalSamples++;

    const sig = Math.max(sigmaT, 1e-9);
    if (Math.abs(spot - strike) < 0.3 * sig) {
      st.nearStrikeSamples++;
    }

    const pctTimeNearStrike =
      st.totalSamples > 0 ? st.nearStrikeSamples / st.totalSamples : 0;

    return { crossCount: st.crossCount, pctTimeNearStrike };
  }
}
