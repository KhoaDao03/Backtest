import type { AssetSymbol } from "@/lib/types";
import { ASSET_SYMBOLS } from "@/lib/types";

export const KALSHI_REST_BASE =
  process.env.KALSHI_REST_BASE ?? "https://external-api.kalshi.com/trade-api/v2";

export const KALSHI_WS_URL =
  process.env.KALSHI_WS_URL ?? "wss://external-api-ws.kalshi.com/trade-api/ws/v2";

export const SERIES_BY_ASSET: Record<AssetSymbol, string> = {
  BTC: "KXBTC15M",
  ETH: "KXETH15M",
  SOL: "KXSOL15M",
  XRP: "KXXRP15M",
};

/** CF Benchmarks index IDs used by Kalshi settlement rules. */
export const CFB_INDEX_BY_ASSET: Record<AssetSymbol, string> = {
  BTC: "BRTI",
  ETH: "ETHUSD_RTI",
  SOL: "SOLUSD_RTI",
  XRP: "XRPUSD_RTI",
};

export const ASSETS: AssetSymbol[] = [...ASSET_SYMBOLS];

/** Binance USDT pairs for candle seeding / fallback RTI. */
export const BINANCE_PAIR_BY_ASSET: Record<AssetSymbol, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT",
};

/** Coinbase products — omit coins that are not listed there. */
export const COINBASE_PRODUCT_BY_ASSET: Partial<Record<AssetSymbol, string>> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
  XRP: "XRP-USD",
};

/** Kraken OHLC pairs — omit coins Kraken does not publish. */
export const KRAKEN_PAIR_BY_ASSET: Partial<Record<AssetSymbol, string>> = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  SOL: "SOLUSD",
  XRP: "XRPUSD",
};
