import type { AssetSymbol } from "@/lib/types";
import {
  ASSETS,
  BINANCE_PAIR_BY_ASSET,
  COINBASE_PRODUCT_BY_ASSET,
} from "@/server/config";

async function binanceMid(symbol: AssetSymbol): Promise<number | null> {
  const pair = BINANCE_PAIR_BY_ASSET[symbol];
  const res = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${pair}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { bidPrice?: string; askPrice?: string };
  const bid = Number(data.bidPrice);
  const ask = Number(data.askPrice);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return (bid + ask) / 2;
}

async function coinbaseMid(symbol: AssetSymbol): Promise<number | null> {
  const product = COINBASE_PRODUCT_BY_ASSET[symbol];
  if (!product) return null;
  const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { bid?: string; ask?: string; price?: string };
  const bid = Number(data.bid);
  const ask = Number(data.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  const price = Number(data.price);
  return Number.isFinite(price) ? price : null;
}

/**
 * Approximate CF Benchmarks RTI when the Kalshi CFB feed is unavailable:
 * median of available exchange mids (Binance + Coinbase).
 */
export async function approximateRti(symbol: AssetSymbol): Promise<{
  price: number;
  sources: string[];
} | null> {
  // Coinbase first — Binance often returns HTTP 451 in the US
  const settled = await Promise.allSettled([coinbaseMid(symbol), binanceMid(symbol)]);
  const prices: { src: string; px: number }[] = [];
  if (settled[0].status === "fulfilled" && settled[0].value != null) {
    prices.push({ src: "coinbase", px: settled[0].value });
  }
  if (settled[1].status === "fulfilled" && settled[1].value != null) {
    prices.push({ src: "binance", px: settled[1].value });
  }
  if (!prices.length) return null;
  prices.sort((a, b) => a.px - b.px);
  const mid = prices[Math.floor(prices.length / 2)]!.px;
  return { price: mid, sources: prices.map((p) => p.src) };
}

export async function approximateAllRti(): Promise<
  Partial<Record<AssetSymbol, { price: number; sources: string[] }>>
> {
  const out: Partial<Record<AssetSymbol, { price: number; sources: string[] }>> = {};
  await Promise.all(
    ASSETS.map(async (a) => {
      const r = await approximateRti(a);
      if (r) out[a] = r;
    }),
  );
  return out;
}
