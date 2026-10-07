import type { AssetSymbol } from "@/lib/types";
import {
  BINANCE_PAIR_BY_ASSET,
  COINBASE_PRODUCT_BY_ASSET,
  KRAKEN_PAIR_BY_ASSET,
} from "@/server/config";

export interface Candle {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Exchange volume when available (Coinbase seed). */
  volume?: number;
}

const MAX_CANDLES = 120;

export class CandleBuilder {
  private candles: Candle[] = [];
  private current: Candle | null = null;

  get series(): Candle[] {
    return this.candles;
  }

  get length(): number {
    return this.withLive().length;
  }

  seed(candles: Candle[]) {
    const sliced = candles.slice(-MAX_CANDLES);
    // Keep the last bar as in-progress so the first tick roll does not double-push it.
    this.candles = sliced.slice(0, -1);
    this.current = sliced[sliced.length - 1] ?? null;
  }

  /** Drop exchange/fallback history — used when CFB RTI becomes the candle source. */
  clear() {
    this.candles = [];
    this.current = null;
  }

  /** Ingest a spot tick; rolls 1-minute candles on UTC minute boundaries. */
  tick(price: number, tsMs = Date.now()) {
    const bucket = Math.floor(tsMs / 60_000) * 60_000;
    if (!this.current || this.current.openTimeMs !== bucket) {
      if (this.current && this.current.openTimeMs < bucket) {
        this.candles.push(this.current);
        if (this.candles.length > MAX_CANDLES) this.candles.shift();
      }
      this.current = {
        openTimeMs: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
      };
      return;
    }
    this.current.high = Math.max(this.current.high, price);
    this.current.low = Math.min(this.current.low, price);
    this.current.close = price;
  }

  /** Closed candles + in-progress candle for indicator calc. */
  withLive(): Candle[] {
    if (!this.current) return [...this.candles];
    const last = this.candles[this.candles.length - 1];
    if (last && last.openTimeMs === this.current.openTimeMs) {
      return [...this.candles.slice(0, -1), this.current];
    }
    return [...this.candles, this.current];
  }
}

async function fetchCoinbase1mCandles(symbol: AssetSymbol, limit = 100): Promise<Candle[]> {
  const product = COINBASE_PRODUCT_BY_ASSET[symbol];
  if (!product) throw new Error(`Coinbase candles ${symbol}: no product`);
  const end = new Date();
  const start = new Date(end.getTime() - limit * 60_000);
  const url =
    `https://api.exchange.coinbase.com/products/${product}/candles` +
    `?granularity=60&start=${encodeURIComponent(start.toISOString())}` +
    `&end=${encodeURIComponent(end.toISOString())}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": "bleepblorp/0.2 (educational)",
    },
  });
  if (!res.ok) throw new Error(`Coinbase candles ${symbol}: HTTP ${res.status}`);
  // [ time, low, high, open, close, volume ] — newest first
  const raw = (await res.json()) as number[][];
  if (!Array.isArray(raw) || !raw.length) throw new Error(`Coinbase candles ${symbol}: empty`);
  const candles = raw
    .map((c) => ({
      openTimeMs: Number(c[0]) * 1000,
      low: Number(c[1]),
      high: Number(c[2]),
      open: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    }))
    .filter((c) => Number.isFinite(c.close) && Number.isFinite(c.openTimeMs))
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  if (candles.length < 30) throw new Error(`Coinbase candles ${symbol}: only ${candles.length}`);
  return candles.slice(-limit);
}

async function fetchKraken1mCandles(symbol: AssetSymbol, limit = 100): Promise<Candle[]> {
  const pair = KRAKEN_PAIR_BY_ASSET[symbol];
  if (!pair) throw new Error(`Kraken OHLC ${symbol}: no pair`);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Kraken OHLC ${symbol}: HTTP ${res.status}`);
  const data = (await res.json()) as {
    error?: string[];
    result?: Record<string, unknown>;
  };
  if (data.error?.length) throw new Error(`Kraken OHLC ${symbol}: ${data.error.join(",")}`);
  const result = data.result ?? {};
  const key = Object.keys(result).find((k) => k !== "last");
  if (!key) throw new Error(`Kraken OHLC ${symbol}: no series`);
  const rows = result[key] as Array<[number, string, string, string, string, string, string, number]>;
  return rows.slice(-limit).map((r) => ({
    openTimeMs: Number(r[0]) * 1000,
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
  }));
}

async function fetchBinance1mCandles(symbol: AssetSymbol, limit = 100): Promise<Candle[]> {
  const pair = BINANCE_PAIR_BY_ASSET[symbol];
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=${limit}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Binance klines ${symbol}: HTTP ${res.status}`);
  const raw = (await res.json()) as unknown[][];
  return raw.map((k) => ({
    openTimeMs: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  }));
}

export async function fetchSeedCandles(
  symbol: AssetSymbol,
  limit = 100,
): Promise<{ candles: Candle[]; source: string }> {
  const attempts: Array<{ name: string; fn: () => Promise<Candle[]> }> = [
    { name: "coinbase", fn: () => fetchCoinbase1mCandles(symbol, limit) },
    { name: "kraken", fn: () => fetchKraken1mCandles(symbol, limit) },
    { name: "binance", fn: () => fetchBinance1mCandles(symbol, limit) },
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const candles = await attempt.fn();
      if (candles.length >= 30) return { candles, source: attempt.name };
      errors.push(`${attempt.name}: only ${candles.length} bars`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(errors.join(" | "));
}
