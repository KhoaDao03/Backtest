import type { AssetSymbol, DecisionResult, MarketSnapshot, Side } from "@/lib/types";
import type { TrailWrSnapshot } from "@/lib/kalshiHold";
import type { DayScorecard } from "@/lib/performanceTypes";

export type { TrailWrSnapshot };

/** Live (or paper-preview) order progress for the per-coin trade box. */
export type LiveTradePhase =
  | "bidding"
  | "open"
  | "selling"
  | "stopped"
  | "settled"
  | "unfilled"
  | "error";

export interface LiveAssetTrade {
  phase: LiveTradePhase;
  side?: Side;
  contracts?: number;
  /** Limit / fill price of the Up or Down contract (0–1). */
  entryPrice?: number;
  lastMarkCents?: number;
  /** Open position PnL in cents (all contracts). */
  unrealizedCents?: number;
  /** Last close PnL for this ticker, in cents. */
  realizedCents?: number;
  lastDetail?: string;
}

export interface LiveAssetPnl {
  allCents: number;
  h24Cents: number;
  allN: number;
  h24N: number;
}

/** Realized live fills: rolling 24h + all-time. */
export interface LivePnlSummary {
  allCents: number;
  h24Cents: number;
  allN: number;
  h24N: number;
  byAsset: Record<AssetSymbol, LiveAssetPnl>;
}

export interface LiveAssetState {
  snapshot: MarketSnapshot;
  marketTicker: string;
  /** Kalshi matching shard for this ticker. -1 = auto-route. */
  exchangeIndex?: number;
  spotSource: "cfbenchmarks" | "fallback" | "unknown";
  spotSourcesDetail?: string[];
  /** Where the current bid/ask came from (orderbook WS, ticker, or REST reconcile). */
  bookSource?: string;
  updatedAtMs: number;
  /** Server-side decision (includes Mode A sticky hold). */
  decision: DecisionResult;
  /** Live order / position for this market, if the trader has one. */
  trade?: LiveAssetTrade;
}

export interface LiveFeedPayload {
  tsMs: number;
  kalshiWs: { connected: boolean; detail: string };
  credentialsConfigured: boolean;
  /** Trader process mode. Absent on a UI-only preview. */
  traderMode?: "paper" | "live";
  assets: LiveAssetState[];
  errors: string[];
  scorecard?: DayScorecard;
  /** Live realized PnL. Absent in paper / preview — use scorecard sums there. */
  livePnl?: LivePnlSummary;
  /** End-of-market recs on sit-out (2h/−2¢ · 1h/+0.25¢ HOLD). */
  hold?: string | null;
  /** 2h / 1h Mode B expectancy used for HOLD (matches scorecard 2h column). */
  trailWr?: TrailWrSnapshot | null;
  /** Mid-market mean-reversion sit-out (1h/−2¢ · 30m/+0.25¢). */
  holdRev?: string | null;
  trailWrRev?: TrailWrSnapshot | null;
  /** Mid-market momentum sit-out (1h/−2¢ · 30m/+0.25¢). */
  holdMom?: string | null;
  trailWrMom?: TrailWrSnapshot | null;
}

export type { AssetSymbol };
