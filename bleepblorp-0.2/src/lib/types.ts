/**
 * bleepblorp decision engine — locked v1 constants & types
 *
 * Mode A: single Mid-market book = momentum continuation (reversion parked);
 *         on-side 2–15 bps, Stoch confirming, entries only with ≥6:00 left;
 *         targets +10/+15/+20 (smallest first) when sizing on; no stop;
 *         floor 35¢; Wait when 1m ATR/spot asleep;
 * Mode B: paper buy when best bid 85–98¢ and finish conf ≥ 85% (window 8:00→end);
 *         all four coins use the same 85% bar; box highlights at ≥85% finish conf
 *         even before 8:00 / below 85¢ bid;
 *         confidence capped near Kalshi mid (market-respect); BTC/ETH tighter;
 *         bid > 98¢ with thesis intact → Hold (no new entry);
 *         no new entries in the final second (MODE_B_END_SEC); confidence updates until expiry;
 *         Wed 11:45p–Thu 2:00a PT weekly Kalshi crypto 15m gap
 * Prices: deci-cents only in 0–9.9¢ and 90.1–99.9¢; whole cents elsewhere.
 * Mode A only: Wait when T ≤ 180s (indicators still shown in UI)
 */

export const MODE_A_CUTOFF_SEC = 180; // Mode A stops at 3:00
export const MODE_B_START_SEC = 480; // Mode B entries from 8:00 left
/** No new Mode B entries at or below this (aligned with MODE_B_END_SEC). */
export const MODE_B_ENTRY_CUTOFF_SEC = 1;
/** Force-settle / sit out at the final second (was 15s — keep position active until then). */
export const MODE_B_END_SEC = 1;
/** Finish-confidence bar for end-of-market paper buys (all four coins). */
export const MODE_B_MIN_CONF = 0.85;
/** Same as MODE_B_MIN_CONF — kept so older call sites stay valid. */
export const MODE_B_MIN_CONF_MAJOR = MODE_B_MIN_CONF;
/** Box lights at this finish conf even before the entry window / ask band. */
export const MODE_B_HIGHLIGHT_CONF = 0.85;
/** Floor ask for end-of-market paper entries. */
export const MODE_B_MIN_ASK = 0.85;
/** Ceiling ask for end-of-market paper entries. */
export const MODE_B_MAX_ASK = 0.98;
/** Cap mid-market momentum entries — protocol-13 sweet spot. */
export const MODE_A_MAX_ASK = 0.52;
/** Floor for mid-market momentum entries. */
export const MODE_A_MIN_ASK = 0.45;
/**
 * Mean-reversion / BB-chop path: 35–55¢ band for midline fades and decay scalps.
 */
export const MODE_A_REV_MIN_ASK = 0.35;
export const MODE_A_REV_MAX_ASK = 0.55;
/** |lean| must clear this to fire Mode A (momentum / mixed). */
export const MODE_A_MIN_LEAN = 0.35;
/** Stronger lean required for the wider reversion ask band. */
export const MODE_A_REV_MIN_LEAN = 0.45;
export const MODE_A_SPREAD_BUFFER = 0.025;
/** Hit bar: min P(contract rises by target ¢) before a Mode A Buy. */
export const MODE_A_MIN_CONF = 80;
/**
 * Relative 1m ATR (atr/spot) below this → market "asleep".
 * Matches the engine ATR floor (~1.5 bps); mid-market Δ scalps need more path.
 */
export const MODE_A_ASLEEP_ATR_RATIO = 0.00022;
/** Upper 1m ATR/spot — above this chop fades sit out (trend blow-off). */
export const MODE_A_REV_MAX_ATR_RATIO = 0.0005;
/** Chop mean reversion: min strike crosses in the window. */
export const MODE_A_REV_MIN_CROSS_COUNT = 2;
/** Chop mean reversion: composite regime score floor (0–1). */
export const MODE_A_REV_MIN_CHOP_SCORE = 0.6;
/** Relative volume band for tradeable chop. */
export const MODE_A_REV_MIN_VOLUME = 0.8;
export const MODE_A_REV_MAX_VOLUME = 3.0;
/** Spot range (10×1m candles) sweet spot in bps. */
export const MODE_A_REV_RANGE_BPS_MIN = 15;
export const MODE_A_REV_RANGE_BPS_MAX = 80;
/** Chop reversion targets — smallest first (+10 workhorse in chop). */
export const MODE_A_REV_TARGETS: DeltaTarget[] = [10, 15, 20];
/** Min time left for live reversion entries (proto 29 — ≥8:00). */
export const MODE_A_REV_MIN_SEC = 480;
/** Min time left for decay (already on right side of strike). */
export const MODE_A_REV_DECAY_MIN_SEC = 600;
/** Hit bar for decay scalps (cushion toward side). */
export const MODE_A_REV_MIN_HIT_DECAY = 80;
/** Hit bar for chop-confirmed swing fades (wrong-side ok). */
export const MODE_A_REV_MIN_HIT_FADE = 85;
/** Stronger lean required for swing fades that need spot to cross back. */
export const MODE_A_REV_FADE_MIN_LEAN = 0.7;

/** Trend momentum continuation — run away from strike. */
export const MODE_A_MOM_MIN_ASK = 0.45;
export const MODE_A_MOM_BREAKOUT_MAX_ASK = 0.55;
export const MODE_A_MOM_RUN_MAX_ASK = 0.7;
export const MODE_A_MOM_EXPENSIVE_ASK = 0.65;
/** Fixed mid-market TP bank — always +20¢ (no sizing ladder). */
export const MODE_A_MOM_TARGETS: DeltaTarget[] = [20];
/** No momentum entries under six minutes (commodities mom 6–8m was +E). */
export const MODE_A_MOM_MIN_SEC = 360;
/** Breakout chase sweet spot upper bound (5–10m). */
export const MODE_A_MOM_BREAKOUT_MAX_SEC = 600;
/** Min cushion toward side (bps) — run must have started. */
export const MODE_A_MOM_MIN_CUSHION_BPS = 2;
/** Cap cushion (bps) — chasing 20+ bps runs was −11¢ on proto 28. */
export const MODE_A_MOM_MAX_CUSHION_BPS = 15;
/** Strong runaway continuation threshold (bps). */
export const MODE_A_MOM_STRONG_RUN_BPS = 10;
export const MODE_A_MOM_MAX_CROSS_COUNT = 1;
export const MODE_A_MOM_MAX_CHOP_SCORE = 0.4;
export const MODE_A_MOM_MIN_TREND_SCORE = 0.5;
export const MODE_A_MOM_MIN_VOLUME = 0.8;
export const MODE_A_MOM_MIN_HIT_RUNAWAY = 80;
export const MODE_A_MOM_MIN_HIT_BREAKOUT = 85;
export const MODE_A_MOM_MIN_HIT_EXPENSIVE = 90;
/**
 * A lit mid-market box stays Buy through Wait shorter than this, so a one-tick
 * dip under the reach bar does not end the rec and mint a new fill.
 */
export const MODE_A_UNLIT_DEBOUNCE_MS = 2_500;
export const MODE_B_SAFETY_FLOOR = 0.5;

/**
 * Explorer mode (protocol 18) — two-week data collection run.
 *
 * Mode A drops the 40–55¢ band entirely and takes anything it believes has a
 * high chance of gaining ≥10¢, at any price with room to run. Replay of the
 * Aug 17–18 board logs found the old band was the worst-performing zone on the
 * screen (−3.6¢/trade at 40–50¢) while 70–90¢ with under six minutes left was
 * the best (+3 to +11¢), so the price gate was removing the only profitable
 * setups. Selection is deliberately loose here: the run exists to map the
 * opportunity surface, not to earn.
 */
export const MODE_A_EXPLORER = true;
/**
 * Reach-probability bar for live mid-market recs (both lanes) and the
 * model-driven arms. Same 80% floor as MODE_A_MIN_CONF.
 */
export const MODE_A_MIN_REACH_PROB = 0.8;
/**
 * Softer hit bar while the mom clock is open — proto 28 fills clustered
 * at 80–85% conf; 75% lights more Buys where the edge lives.
 */
export const MODE_A_EARLY_REACH_PROB = 0.75;
/** Seconds left at/above which MODE_A_EARLY_REACH_PROB applies (matches mom ≥6:00). */
export const MODE_A_EARLY_SEC = 360;
/**
 * Live mid-market scalp sizes when sizing is on (unused while sizing is off).
 */
export const MODE_A_LIVE_TARGETS: DeltaTarget[] = [10, 15, 20];
/**
 * When false, always recommend MODE_A_FIXED_TP with no stop.
 * Protocol 36: fixed +20¢ TP (Rec / path history preferred this over +10).
 */
export const MODE_A_TP_SIZING_ENABLED = false;
/** Fixed mid-market take-profit (no stop). */
export const MODE_A_FIXED_TP: DeltaTarget = 20;
/**
 * Mean-reversion mid-market lane. Off — MMMR stayed negative across crypto
 * and commodities; board is a single Mid-market (momentum) book.
 */
export const MODE_A_REV_ENABLED = false;
/** Skip lottery tickets where a 10¢ gain is a multiple of the entry. */
export const MODE_A_EXPLORER_MIN_ASK = 0.05;
/**
 * Hard floor for Indicators and Wide. Control already uses this as its 0.1 band.
 * Sub-35¢ tickets were 32% / −3.0¢ over 250 protocol-20 fills; Stripped never
 * cleared 68% there, so this only stops the lean from manufacturing them.
 */
export const MODE_A_HARD_MIN_ASK = 0.35;
/** Widest ask − bid we'll pay through. */
export const MODE_A_EXPLORER_MAX_SPREAD = 0.1;
/** Entries allowed this late — the rich-and-late zone is where the edge lives. */
export const MODE_A_EXPLORER_MIN_SEC = 60;
/** Tickets per market per side, so entries spread across the window. */
export const MODE_A_EXPLORER_MAX_PER_SIDE = 2;
/** Minimum gap between entries on the same asset and side. */
export const MODE_A_EXPLORER_COOLDOWN_MS = 120_000;

/**
 * Competing selection rules graded on one shared tick stream.
 * S = price/time only · I = S plus Stoch RSI / Bollinger lean.
 *
 * C and P are baselines that trade themselves rather than scoring the scanner's
 * picks. C is protocol 13 (0.1), the version with a measured +1.29¢ over 992
 * trades. P is that identical rule with its price band and clock opened up,
 * which is the cheapest test of the thing actually blocking 0.1: its lean fires
 * on 73% of ticks but the 55¢ ceiling turns all but 35 of 4,026 into a pass.
 *
 * Protocol 17 is deliberately absent. It fired on 11 of those 4,026 ticks and
 * every one was a tick 0.1 also bought, so it could only ever have produced a
 * near-empty column restating 0.1.
 *
 * C keeps its letter even though it now means 0.1 rather than the 0.2 control it
 * originally referred to. Renaming it would orphan the tickets already on disk
 * that carry `arms: ["C"]`, and a mid-collection migration is a worse trade than
 * a letter that needs this comment.
 */
export type ModeALane = "mom" | "rev";
export type ArmId = "S" | "I" | "C" | "P";
export const ARM_IDS: ArmId[] = ["S", "I", "C", "P"];
export const ARM_LABELS: Record<ArmId, string> = {
  S: "Stripped",
  I: "Indicators",
  C: "0.1 Control",
  P: "0.1 Wide",
};
/** 0.2 experiments shown on Paper — 0.1 Control is scored under Mid-market 0.1, not here. */
export const POTENTIAL_02_ARMS: ArmId[] = ["S", "I", "P"];
/** Arms under test, which drive explorer entries. C and P trade their own paths. */
export const SCANNER_ARMS: ArmId[] = ["S", "I"];
/** Baselines that open their own tickets, each with the source tag it writes. */
export const BASELINE_ARMS: { arm: ArmId; source: BaselineSource }[] = [
  { arm: "P", source: "wide" },
];
export type BaselineSource = "control" | "wide";

export type Side = "up" | "down";
/** Mid-market scalp sizes — recommend largest with hit chance ≥ MODE_A_MIN_CONF. */
export type DeltaTarget = 10 | 15 | 20;

export const ASSET_SYMBOLS = ["BTC", "ETH", "SOL", "XRP"] as const;
export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];

/** BTC/ETH: jumpy vs 1m ATR-normal, so Mode B uses a tighter market-respect cap. */
export const MAJOR_ASSETS: ReadonlySet<AssetSymbol> = new Set(["BTC", "ETH"]);
export function isMajorAsset(symbol: AssetSymbol): boolean {
  return MAJOR_ASSETS.has(symbol);
}

/** Display decimals for spot/strike (sub-dollar coins need more). */
export function spotDecimals(symbol: AssetSymbol): number {
  switch (symbol) {
    case "XRP":
      return 4;
    case "SOL":
      return 3;
    default:
      return 2;
  }
}

/**
 * Mode B confidence may not run more than this far above the live
 * Kalshi mid on the chosen side. Specialized market makers/bots set that
 * price; a huge model-vs-book gap is treated as our miscalibration, not edge.
 * BTC/ETH use a tighter premium (jumpier vs 1m ATR-normal).
 */
export const MODE_B_MARKET_PREMIUM = 0.1;
export const MODE_B_MARKET_PREMIUM_MAJOR = 0.06;
/** Inflate remaining-path σ for majors so finish Φ(z) is less overconfident. */
export const MODE_B_SIGMA_MULT: Record<AssetSymbol, number> = {
  BTC: 1.35,
  ETH: 1.25,
  SOL: 1,
  XRP: 1,
};
export interface ChopRegime {
  crossCount: number;
  pctTimeNearStrike: number;
  rangeBps: number;
  relVolume: number;
  /** Composite 0–1 chop score. */
  score: number;
  confirmed: boolean;
}

export interface TrendRegime {
  crossCount: number;
  pctTimeNearStrike: number;
  rangeBps: number;
  relVolume: number;
  chopScore: number;
  /** Composite 0–1 trend score. */
  score: number;
  confirmed: boolean;
}

export interface MarketSnapshot {
  symbol: AssetSymbol;
  /** Spot / RTI */
  spot: number;
  /** Kalshi strike */
  strike: number;
  /** Seconds remaining in the 15m window */
  secondsLeft: number;
  askUp: number;
  bidUp: number;
  askDown: number;
  bidDown: number;
  /** ATR in price units (same as spot), 1m */
  atr1m: number;
  /** Stoch RSI %K 0–100 */
  stochK: number;
  stochKPrev: number;
  /** Bollinger 1m */
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  /** Chop regime — populated by the feed before decide(). */
  chop?: ChopRegime;
  /** Trend regime — populated by the feed before decide(). */
  trend?: TrendRegime;
}

export interface FactorNote {
  id: string;
  label: string;
  value: string;
  plainEnglish: string;
}

export interface ModeARecommendation {
  action: "wait" | "buy";
  side?: Side;
  /** Suggested entry (current ask) */
  entryAsk?: number;
  /** Profit target in cents */
  targetCents?: DeltaTarget;
  /** Expected Kalshi move in probability terms */
  expectedDelta?: number;
  confidence: number;
  reason: string;
  factors: FactorNote[];
  /** Explorer runs: which selection rules approved this entry. */
  arms?: ArmId[];
  /** Each arm's reach probability (0–1) for the chosen side and target. */
  armProbs?: Partial<Record<ArmId, number>>;
  /** Seconds until time decay alone would lift the price to target, if ever. */
  etaSec?: number | null;
  /** Chop reversion diagnostics when this rec is from the rev lane. */
  chopScore?: number;
  chopArchetype?: "decay" | "fade";
  /** Trend continuation diagnostics when this rec is from the mom lane. */
  trendScore?: number;
  momArchetype?: "runaway" | "breakout";
}

export interface ModeBRecommendation {
  /** buy = paper entry; hold = box lit (thesis / bid > 98¢) without new paper */
  action: "wait" | "buy" | "hold";
  side?: Side;
  /** Display pay band, e.g. 85–98¢ */
  bandLabel: string;
  confidence: number;
  finishProb?: number;
  safety?: number;
  reason: string;
  factors: FactorNote[];
}

export interface DecisionResult {
  /** Momentum-continuation mid-market rec (same object as modeAMom). */
  modeA: ModeARecommendation;
  /** Momentum continuation — own rec box, sticky, and paper book. */
  modeAMom: ModeARecommendation;
  /** Mean reversion — own rec box, sticky, and paper book. */
  modeARev: ModeARecommendation;
  modeB: ModeBRecommendation;
  /**
   * Shipped 0.1 Mode B, used only to veto mid-market the way the Strategist
   * viewer does. End-of-market boxes still show modeB (0.2).
   */
  modeB01?: ModeBRecommendation;
  /**
   * Explorer scanner rec. Opens Stripped/Indicators paper tickets only.
   * Rec boxes do not read this.
   */
  modeAExplorer?: ModeARecommendation;
  /**
   * Protocol 13 (bleepblorp 0.1) running as its own live benchmark arm. It opens
   * its own paper tickets rather than only tagging the explorer's, so the
   * comparison is same-market and same-minute instead of against an eight-day-old
   * number from a different week.
   */
  modeAControl?: ModeARecommendation;
  /**
   * Protocol 13's rule with a widened price band and clock, as its own live arm.
   *
   * Paired against modeAControl on the same ticks, the difference between these
   * two rows is attributable to the aperture and nothing else.
   */
  modeAWide?: ModeARecommendation;
  /** Always computed for UI */
  indicators: {
    z: number;
    sigmaT: number;
    pUp: number;
    lean: number;
    leanLabel: string;
    cushion: number;
    expectedMove: number;
  };
}
