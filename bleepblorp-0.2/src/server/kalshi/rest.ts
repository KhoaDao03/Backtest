import type { AssetSymbol } from "@/lib/types";
import { snapKalshiBook } from "@/lib/math";
import { ASSETS, KALSHI_REST_BASE, SERIES_BY_ASSET } from "@/server/config";
import { REST_429_BASE_MS, SERIES_STAGGER_MS } from "@/server/kalshi/pacing";

export interface KalshiMarketQuote {
  symbol: AssetSymbol;
  seriesTicker: string;
  marketTicker: string;
  eventTicker: string;
  title: string;
  strike: number;
  /** True when Kalshi has not published floor_strike yet (subtitle still TBD). */
  strikePending?: boolean;
  askUp: number;
  bidUp: number;
  askDown: number;
  bidDown: number;
  openTimeMs: number;
  closeTimeMs: number;
  status: string;
  /** Kalshi matching shard. Omit on orders defaults to 0 and 404s shard-2 books. */
  exchangeIndex: number;
}

interface RawMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  floor_strike?: number;
  yes_sub_title?: string;
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  no_ask_dollars?: string;
  no_bid_dollars?: string;
  open_time?: string;
  close_time?: string;
  exchange_index?: number;
}

/** Official strike, or parse from "Target Price: $…", else null while TBD. */
export function resolveFloorStrike(m: RawMarket): number | null {
  if (m.floor_strike != null && Number.isFinite(Number(m.floor_strike))) {
    return Number(m.floor_strike);
  }
  const sub = m.yes_sub_title ?? "";
  const match = sub.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (!match) return null;
  const n = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseDollars(v: string | undefined): number {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pick the live 15m market — never fall back to an already-closed ticker.
 * Prefer currently open; else the next one opening within a short window.
 */
export function pickActiveMarket(markets: RawMarket[], now = Date.now()): RawMarket | null {
  if (!markets.length) return null;

  const annotated = markets
    .map((m) => ({
      m,
      openMs: m.open_time ? Date.parse(m.open_time) : NaN,
      closeMs: m.close_time ? Date.parse(m.close_time) : NaN,
    }))
    .filter((x) => Number.isFinite(x.openMs) && Number.isFinite(x.closeMs));

  const live = annotated.filter((x) => x.openMs <= now && now < x.closeMs);
  if (live.length) {
    // Prefer explicitly open/active, but accept any in-window market.
    const preferred = live.filter(
      (x) => x.m.status === "active" || x.m.status === "open" || !x.m.status,
    );
    const pool = preferred.length ? preferred : live;
    pool.sort((a, b) => a.closeMs - b.closeMs);
    return pool[0]!.m;
  }

  // Next window already listed but not quite open yet (common near rollover).
  const upcoming = annotated.filter(
    (x) => x.openMs > now && x.openMs - now <= 90_000 && now < x.closeMs,
  );
  if (upcoming.length) {
    upcoming.sort((a, b) => a.openMs - b.openMs);
    return upcoming[0]!.m;
  }

  return null;
}

export async function fetchSeriesMarkets(symbol: AssetSymbol): Promise<KalshiMarketQuote | null> {
  const seriesTicker = SERIES_BY_ASSET[symbol];
  // status=open is required — unfiltered results are dominated by future
  // `initialized` markets (often without floor_strike) and miss the live window.
  const url = `${KALSHI_REST_BASE}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=20`;

  let res: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (res.status !== 429) break;
    // Yield to the EOM trader on the shared read bucket.
    await new Promise((r) => setTimeout(r, REST_429_BASE_MS * (attempt + 1) ** 2));
  }
  if (!res || !res.ok) {
    throw new Error(`Kalshi markets ${symbol}: HTTP ${res?.status ?? "?"}`);
  }
  const data = (await res.json()) as { markets?: RawMarket[] };
  const picked = pickActiveMarket(data.markets ?? []);
  if (!picked) return null;

  // Alts often open with "Target price: TBD" and no floor_strike for seconds–minutes.
  // Still bind the live ticker so books/clock update; strike fills in on later refresh.
  const resolved = resolveFloorStrike(picked);
  const strikePending = resolved == null;

  return {
    symbol,
    seriesTicker,
    marketTicker: picked.ticker,
    eventTicker: picked.event_ticker,
    title: picked.title,
    strike: resolved ?? Number.NaN,
    strikePending,
    ...snapKalshiBook({
      askUp: parseDollars(picked.yes_ask_dollars),
      bidUp: parseDollars(picked.yes_bid_dollars),
      askDown: parseDollars(picked.no_ask_dollars),
      bidDown: parseDollars(picked.no_bid_dollars),
    }),
    openTimeMs: Date.parse(picked.open_time ?? ""),
    closeTimeMs: Date.parse(picked.close_time ?? ""),
    status: picked.status,
    exchangeIndex: Number.isInteger(picked.exchange_index)
      ? Number(picked.exchange_index)
      : -1,
  };
}

export async function fetchAllOpen15mMarkets(): Promise<KalshiMarketQuote[]> {
  // Stagger to reduce burst 429s under rollover pressure.
  const out: KalshiMarketQuote[] = [];
  for (const a of ASSETS) {
    try {
      const m = await fetchSeriesMarkets(a);
      if (m) out.push(m);
    } catch {
      /* per-asset failure — caller merges and retries */
    }
    await new Promise((r) => setTimeout(r, SERIES_STAGGER_MS));
  }
  return out;
}

/** Public REST orderbook BBO (yes/no bids only; asks derived). */
export async function fetchOrderbookBbo(marketTicker: string): Promise<{
  bidUp: number;
  askUp: number;
  bidDown: number;
  askDown: number;
} | null> {
  const url = `${KALSHI_REST_BASE}/markets/${encodeURIComponent(marketTicker)}/orderbook`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    orderbook_fp?: {
      yes_dollars?: [string, string][];
      no_dollars?: [string, string][];
    };
  };
  const yes = data.orderbook_fp?.yes_dollars ?? [];
  const no = data.orderbook_fp?.no_dollars ?? [];
  let bestYes = -Infinity;
  let bestNo = -Infinity;
  for (const row of yes) {
    const px = Number(row?.[0]);
    if (Number.isFinite(px) && px > bestYes) bestYes = px;
  }
  for (const row of no) {
    const px = Number(row?.[0]);
    if (Number.isFinite(px) && px > bestNo) bestNo = px;
  }
  if (bestYes === -Infinity || bestNo === -Infinity) return null;
  return snapKalshiBook({
    bidUp: bestYes,
    askUp: 1 - bestNo,
    bidDown: bestNo,
    askDown: 1 - bestYes,
  });
}

/** Fresh market BBO from GET /markets/{ticker} (matches Kalshi UI better than series list). */
export async function fetchMarketBbo(marketTicker: string): Promise<{
  bidUp: number;
  askUp: number;
  bidDown: number;
  askDown: number;
} | null> {
  const url = `${KALSHI_REST_BASE}/markets/${encodeURIComponent(marketTicker)}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    market?: {
      yes_bid_dollars?: string;
      yes_ask_dollars?: string;
      no_bid_dollars?: string;
      no_ask_dollars?: string;
    };
  };
  const m = data.market;
  if (!m) return null;
  const bidUp = parseDollars(m.yes_bid_dollars);
  const askUp = parseDollars(m.yes_ask_dollars);
  const bidDown = parseDollars(m.no_bid_dollars);
  const askDown = parseDollars(m.no_ask_dollars);
  if (!Number.isFinite(bidUp) || !Number.isFinite(askUp)) return null;
  return snapKalshiBook({ bidUp, askUp, bidDown, askDown });
}
