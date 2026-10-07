import type { ArmId, AssetSymbol, Side } from "@/lib/types";
import type { PaperSessionOptBundle } from "@/lib/sessionOptTypes";

export type PaperMode = "A" | "B";
export type PaperOutcome = "hit" | "miss" | "win" | "loss" | "void" | "open";

export interface PaperTicket {
  id: string;
  mode: PaperMode;
  symbol: AssetSymbol;
  marketTicker: string;
  side: Side;
  openedAtMs: number;
  entryAsk: number;
  /** Mode A only */
  targetCents?: number;
  /** Mode A hit-prob or Mode B finish conf at open (0–100) */
  confAtOpen?: number;
  spotAtOpen: number;
  strikeAtOpen: number;
  secondsLeftAtOpen: number;
  leanLabel?: string;
  stochK?: number;
  atr1m?: number;
  /** Max favorable excursion in cents (mark vs entry ask) */
  mfeCents: number;
  /** Max adverse excursion in cents */
  maeCents: number;
  lastMarkCents: number;
  outcome: PaperOutcome;
  settledAtMs?: number;
  pnlCents?: number;
  /** Live size; paper tickets omit this (treated as 1). */
  contracts?: number;
  settleReason?: string;
  /**
   * PnL if held to market determination (0 or 100), not the paper flatten.
   * SL/TP Rec uses this when the barrier never fires.
   */
  holdPnlCents?: number;
  /** Entry-to-expiry path is stored. */
  pathComplete?: boolean;
  /** Held-side marks in ¢ from fill to expiry, when recorded. */
  pathMarks?: number[];
  /** Which entry path opened this ticket; they gate independently. */
  /** Which entry path opened this ticket; they gate independently. */
  source?:
    | "explorer"
    | "control"
    | "wide"
    | "shipped"
    | "early85"
    | "mom"
    | "rev"
    | "hold-paper"
    | "hold-mom"
    | "hold-rev";
  /**
   * The full book, in cents, from the exact snapshot the entry was priced off.
   *
   * Without this an entry can only be checked against the research recorder,
   * which samples every 5s — and these contracts move 15–20¢ inside 5s at the
   * 99th percentile, so that comparison cannot distinguish a stale fill from a
   * fast market. Several control tickets hit their target within a second of
   * opening and the recorder could not settle whether that was real. Carrying
   * the book on the ticket makes every fill auditable against the quote it
   * actually claimed, with no sampling gap to argue about.
   */
  bookAtOpen?: { askUp: number; bidUp: number; askDown: number; bidDown: number };
  /** Explorer runs: which selection rules approved this entry. */
  arms?: ArmId[];
  /** Every arm's reach probability at open, including the ones that declined. */
  armProbs?: Partial<Record<ArmId, number>>;
  /** Seconds until time decay alone would have reached target, at open. */
  etaSecAtOpen?: number | null;
  /** Chop reversion regime score at open (0–1). */
  chopScoreAtOpen?: number;
  /** decay = on-side vol drain · fade = chop-confirmed swing. */
  chopArchetype?: "decay" | "fade";
  /** Trend continuation regime score at open (0–1). */
  trendScoreAtOpen?: number;
  /** runaway = strong on-side run · breakout = early chase. */
  momArchetype?: "runaway" | "breakout";
}

/**
 * PnL for All / 24h / 2h scorecard columns — always one contract, even when
 * live fills are sized >1. Dust lots (<1 contract) are already mark-scaled.
 */
export function scorecardPnlCents(
  t: Pick<PaperTicket, "pnlCents" | "contracts">,
): number {
  const pnl = t.pnlCents ?? 0;
  const n = t.contracts ?? 1;
  if (n < 1 - 1e-6) return Math.round(pnl * 10) / 10;
  return Math.round((pnl / n) * 10) / 10;
}

export interface ModeScorecard {
  opens: number;
  settled: number;
  hitsOrWins: number;
  missesOrLosses: number;
  voids: number;
  openNow: number;
  hitRate: number | null;
  expectancyCents: number | null;
  sumPnlCents: number;
}

export interface AssetModePair {
  modeA: ModeScorecard;
  modeB: ModeScorecard;
  /**
   * Momentum-continuation mid-market paper (source mom).
   */
  modeAMom?: ModeScorecard;
  /**
   * Mean-reversion mid-market paper (source rev).
   */
  modeARev?: ModeScorecard;
  /**
   * Shadow: first ≥85% finish conf before 8:00 left, all coins, hold to expiry.
   * Never sends a live order.
   */
  modeBEarly?: ModeScorecard;
}

export type ScoreWindowId = "all" | "24h" | "2h";

export interface ScoreWindowSlice {
  id: ScoreWindowId;
  label: string;
  /** Combined across all tracked 15m crypto series */
  all: AssetModePair;
  byAsset: Record<AssetSymbol, AssetModePair>;
  /**
   * Mode A split by which arm approved the ticket. A ticket backed by two arms
   * counts in both, which is what makes the comparison paired.
   */
  modeAArms: Record<ArmId, ModeScorecard>;
}

/** Current consecutive wins (hit/win) ending at the latest settle; 0 after a loss. */
export interface ModeStreaks {
  /** Across all assets for this mode, chronological. */
  all: number;
  byAsset: Record<AssetSymbol, number>;
}

/** Optimized stop / take-profit from paper MAE·MFE (display + research). */
export type TakeProfitKind = "hold" | "delta" | "mark" | "native";
export type StopLossKind = "pct" | "mark" | "none" | "delta" | "protocol";

export interface ExitOptCell {
  /**
   * pct = stop when mark ≤ this % of entry.
   * mark = stop when mark ≤ this many cents (absolute).
   * delta = stop when mark ≤ entry − this many cents.
   * protocol = live Mode B 49¢ floor (entries are ≥80¢).
   * none = no extra stop; remainder is window-end last mark (Mode A) or
   *        hold-to-expiry (Mode B), not the live flatten.
   */
  stopKind: StopLossKind | null;
  /**
   * Stop when mark ≤ this % of entry (e.g. 50 → stop at half what you paid).
   * Set when stopKind is pct.
   */
  stopAtEntryPct: number | null;
  /** Absolute stop mark in ¢. Set when stopKind is mark. */
  stopMarkCents: number | null;
  /** How take-profit is expressed for the viewer. */
  takeProfitKind: TakeProfitKind | null;
  /**
   * For kind=delta: ¢ above entry (Mode A scalp).
   * For kind=mark: absolute exit mark in ¢ (e.g. 99 or 99.1 — deci-cent books).
   * For kind=hold: null. Mode A = paper settle mark (including 0¢ wipes);
   * Mode B = 0/100 expiry.
   * For kind=native: each fill's own rec target (+15 / +20).
   */
  takeProfitValue: number | null;
  /** Counterfactual expectancy under this SL/TP pair. */
  expectancyCents: number | null;
  /**
   * Rec PnL: latest recommended SL/TP for this row, replayed across the row's
   * full settled history (same sample as All PnL).
   */
  counterfactualSumCents: number | null;
  /**
   * Rec PnL of the same SL/TP on the later 30% of fills (chronological).
   * Null when the sample is too small to split.
   */
  holdoutSumCents: number | null;
  /** Baseline expectancy (actual settled PnL) on the same sample. */
  baselineExpectancyCents: number | null;
  sampleSize: number;
  source: "current" | "historical" | "insufficient";
}

export interface ModeExitOpts {
  all: ExitOptCell;
  byAsset: Record<AssetSymbol, ExitOptCell>;
}

export interface ExitOptimization {
  modeA: ModeExitOpts;
  modeB: ModeExitOpts;
  /** Momentum continuation mid-market. */
  modeAMom?: ModeExitOpts;
  /** Mean reversion mid-market. */
  modeARev?: ModeExitOpts;
  note: string;
  /** Replay audit — Mode B Rec prefers path-complete fills (sevenstreams parity). */
  coverage?: ExitOptCoverage;
}

/** SL/TP grid replay coverage over settled fills. */
export interface ExitOptCoverage {
  fillCloseN: number;
  replayReadyN: number;
  gapN: number;
  /** True when at least one fill is replay-ready to optimize. */
  complete: boolean;
  /** Fills excluded from replay — listed for audit, not in Rec PnL. */
  gaps: ExitOptGap[];
  grid: ExitOptReplayGrid;
  gridCombos: number;
}

export interface ExitOptGap {
  marketTicker: string;
  symbol: AssetSymbol;
  reason: string;
}

export interface ExitOptReplayGrid {
  slMarks: number[];
  slPcts: number[];
  tpMarks: number[];
  tpDeltas: number[];
}

export interface DayScorecard {
  /** Scorecard window label — "lifetime" for ongoing cumulative stats. */
  dayKey: string;
  /** Lifetime Mode A (same as windows[all].all.modeA). */
  modeA: ModeScorecard;
  /** Lifetime Mode B (same as windows[all].all.modeB). */
  modeB: ModeScorecard;
  /** Lifetime early-85% shadow (same as windows[all].all.modeBEarly). */
  modeBEarly?: ModeScorecard;
  /** Lifetime Mode A per arm (same as windows[all].modeAArms). */
  modeAArms: Record<ArmId, ModeScorecard>;
  openTickets: number;
  /** Current win streaks for Mid-market (A) and End-of-market (B). */
  streaks: {
    modeA: ModeStreaks;
    modeB: ModeStreaks;
    modeAMom?: ModeStreaks;
    modeARev?: ModeStreaks;
    modeBEarly?: ModeStreaks;
  };
  /** Per-mode / per-asset stop-loss & take-profit optimization from paper paths. */
  exitOpt: ExitOptimization;
  /** Recommend-only weekly sit-out (modeA = Mid-Market, modeB = End-of-Market). */
  sessionOpt?: PaperSessionOptBundle | null;
  /** Ongoing + 24h + 2h, each with cumulative and per-asset breakdown. */
  windows: ScoreWindowSlice[];
}
