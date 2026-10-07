import type {
  ExitOptCell,
  ExitOptCoverage,
  ExitOptGap,
  ExitOptReplayGrid,
  ExitOptimization,
  ModeExitOpts,
  PaperTicket,
  TakeProfitKind,
} from "@/lib/performanceTypes";
import type { AssetSymbol } from "@/lib/types";
import { formatCentValue, snapKalshiCents } from "@/lib/math";
import { ASSET_ORDER } from "@/lib/demoMarkets";

/** Minimum decided tickets before we treat an opt as ready (not provisional). */
export const EXIT_OPT_MIN_READY = 20;
/** Soft floor — below this we show "—" (not enough path data). */
export const EXIT_OPT_MIN_SAMPLES = 12;
type TpSpec =
  | { kind: "hold" }
  | { kind: "delta"; cents: number }
  | { kind: "mark"; markCents: number }
  | { kind: "native" };

type SlSpec =
  | { kind: "none" }
  | { kind: "pct"; pct: number }
  | { kind: "mark"; cents: number }
  | { kind: "delta"; cents: number }
  /** Live Mode B stop — keep in sync with tracker.stopMarkCents Mode B. */
  | { kind: "protocol" };

type Remainder = "expiry" | "window";

/** Path-only default: no extra stop, hold to the fill's recorded outcome. */
const NO_STOP: SlSpec = { kind: "none" };
const PROTOCOL_STOP: SlSpec = { kind: "protocol" };
const HOLD_TP: TpSpec = { kind: "hold" };

/**
 * Absolute mark SL/TP grid knots (full search — no coverage shorthand).
 */
const MODE_B_SL_MARKS = [49, 55, 60, 65, 70, 75, 80, 85];
const MODE_B_SL_PCTS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 92, 94];
const MODE_B_TP_MARKS = [95, 96, 97, 98, 99, 99.2, 99.5, 99.8];
const MODE_B_TP_DELTAS = [1, 2, 3, 4, 5, 6];

/** Full Mode B SL/TP search space (before per-coin coverage filter). */
export const MODE_B_REPLAY_GRID: ExitOptReplayGrid = {
  slMarks: [...MODE_B_SL_MARKS],
  slPcts: [...MODE_B_SL_PCTS],
  tpMarks: [...MODE_B_TP_MARKS],
  tpDeltas: [...MODE_B_TP_DELTAS],
};

/** Ticket has entry→expiry marks + hold outcome for grid replay. */
export function ticketReplayReady(t: PaperTicket): { ready: boolean; reason?: string } {
  if (t.holdPnlCents == null) return { ready: false, reason: "missing hold-to-expiry PnL" };
  const marks = t.pathMarks;
  if (!marks || marks.length < 2) return { ready: false, reason: "missing mark path" };
  const entry = snapKalshiCents(t.entryAsk * 100);
  const minMark = Math.min(...marks);
  const maxMark = Math.max(...marks);
  const mfe = t.mfeCents ?? 0;
  const mae = t.maeCents ?? 0;
  if (mfe > 0.05) {
    const peak = entry + mfe;
    if (maxMark + 0.5 < peak - 1e-6) {
      return { ready: false, reason: "path not replay-ready" };
    }
  }
  if (mae < -0.05) {
    const trough = entry + mae;
    if (trough >= 2 && minMark > trough + 0.5 + 1e-6) {
      return { ready: false, reason: "path not replay-ready" };
    }
  }
  return { ready: true };
}

export function partitionReplayTickets(tickets: PaperTicket[]): {
  ready: PaperTicket[];
  gaps: ExitOptGap[];
} {
  const ready: PaperTicket[] = [];
  const gaps: ExitOptGap[] = [];
  for (const t of tickets) {
    const check = ticketReplayReady(t);
    if (check.ready) ready.push(t);
    else {
      gaps.push({
        marketTicker: t.marketTicker,
        symbol: t.symbol,
        reason: check.reason ?? "not replay-ready",
      });
    }
  }
  return { ready, gaps };
}

export function buildReplayCoverage(tickets: PaperTicket[]): ExitOptCoverage {
  const { ready, gaps } = partitionReplayTickets(tickets);
  const combos = modeBSlGrid().length * modeBTpGrid().length;
  return {
    fillCloseN: tickets.length,
    replayReadyN: ready.length,
    gapN: gaps.length,
    complete: ready.length > 0,
    gaps: gaps.slice(0, 48),
    grid: MODE_B_REPLAY_GRID,
    gridCombos: combos,
  };
}

function emptyCell(): ExitOptCell {
  return {
    stopKind: null,
    stopAtEntryPct: null,
    stopMarkCents: null,
    takeProfitKind: null,
    takeProfitValue: null,
    expectancyCents: null,
    counterfactualSumCents: null,
    holdoutSumCents: null,
    baselineExpectancyCents: null,
    sampleSize: 0,
    source: "insufficient",
  };
}

/** Empty SL/TP board — used when paused or cache is missing. */
export function emptyExitOptimization(note: string): ExitOptimization {
  const cell = emptyCell();
  const byAsset = Object.fromEntries(
    ASSET_ORDER.map((s) => [s, cell]),
  ) as Record<AssetSymbol, ExitOptCell>;
  const mode = { all: cell, byAsset };
  return { modeA: mode, modeB: mode, modeAMom: mode, modeARev: mode, note };
}

function decided(tickets: PaperTicket[]): PaperTicket[] {
  return tickets.filter(
    (t) =>
      t.outcome === "hit" ||
      t.outcome === "win" ||
      t.outcome === "miss" ||
      t.outcome === "loss",
  );
}

function baselineE(tickets: PaperTicket[]): number | null {
  if (!tickets.length) return null;
  const sum = tickets.reduce((s, t) => s + (t.pnlCents ?? 0), 0);
  return sum / tickets.length;
}

function cellToTp(cell: ExitOptCell): TpSpec | null {
  if (cell.takeProfitKind === "hold") return { kind: "hold" };
  if (cell.takeProfitKind === "native") return { kind: "native" };
  if (cell.takeProfitKind === "delta" && cell.takeProfitValue != null) {
    return { kind: "delta", cents: cell.takeProfitValue };
  }
  if (cell.takeProfitKind === "mark" && cell.takeProfitValue != null) {
    return { kind: "mark", markCents: cell.takeProfitValue };
  }
  return null;
}

function slFromCell(cell: ExitOptCell): SlSpec | null {
  if (cell.stopKind === "none") return { kind: "none" };
  if (cell.stopKind === "protocol") return { kind: "protocol" };
  if (cell.stopKind === "mark" && cell.stopMarkCents != null) {
    return { kind: "mark", cents: cell.stopMarkCents };
  }
  if (cell.stopKind === "delta" && cell.stopMarkCents != null) {
    return { kind: "delta", cents: cell.stopMarkCents };
  }
  if (cell.stopAtEntryPct != null) {
    return { kind: "pct", pct: cell.stopAtEntryPct };
  }
  return null;
}

function slToCell(sl: SlSpec): Pick<
  ExitOptCell,
  "stopKind" | "stopAtEntryPct" | "stopMarkCents"
> {
  if (sl.kind === "none") {
    return { stopKind: "none", stopAtEntryPct: null, stopMarkCents: null };
  }
  if (sl.kind === "protocol") {
    return { stopKind: "protocol", stopAtEntryPct: null, stopMarkCents: null };
  }
  if (sl.kind === "pct") {
    return { stopKind: "pct", stopAtEntryPct: sl.pct, stopMarkCents: null };
  }
  if (sl.kind === "delta") {
    return { stopKind: "delta", stopAtEntryPct: null, stopMarkCents: sl.cents };
  }
  return { stopKind: "mark", stopAtEntryPct: null, stopMarkCents: sl.cents };
}

/**
 * Dead 15m books print ~0¢ on rollover. That writes MAE = −entry on tickets
 * that later settled as wins, so every stop on the grid "hits" a winner.
 * Ignore sub-1¢ adverse prints unless we actually stopped.
 */
function usableMaeCents(t: PaperTicket): number {
  const mae = t.maeCents ?? 0;
  const entry = snapKalshiCents(t.entryAsk * 100);
  const worst = entry + mae;
  const stopped = t.settleReason === "stop_loss";
  if (!stopped && worst <= 1) return 0;
  return mae;
}

/** A stop has to be at least this far below entry. 97.6¢ on a 90¢ fill is not a stop. */
const MIN_STOP_CENTS = 2;

/**
 * Live Mode B stop mark in ¢. Keep in sync with tracker.stopMarkCents("B").
 * entry ≥ 80¢ → 49¢ floor; else 50% of entry.
 */
function modeBProtocolStopMark(entryCents: number): number {
  if (entryCents >= 80) return 49;
  return snapKalshiCents(entryCents * 0.5);
}

function stopMarkFor(entry: number, sl: SlSpec): number | null {
  if (sl.kind === "none") return null;
  if (sl.kind === "protocol") return modeBProtocolStopMark(entry);
  if (sl.kind === "pct") {
    if (sl.pct <= 0 || sl.pct >= 100) return null;
    return snapKalshiCents((entry * sl.pct) / 100);
  }
  if (sl.kind === "delta") {
    return snapKalshiCents(entry - sl.cents);
  }
  return sl.cents;
}

function stopHit(
  entry: number,
  mae: number,
  sl: SlSpec,
): { hit: boolean; loss: number } {
  const stopMark = stopMarkFor(entry, sl);
  if (stopMark == null) return { hit: false, loss: 0 };
  const loss = Math.round((entry - stopMark) * 10) / 10;
  // Stop at or above entry (e.g. ALL 97.6¢ vs an 88¢ SOL fill) is a fake TP.
  if (loss < MIN_STOP_CENTS) return { hit: false, loss: 0 };
  return { hit: entry + mae <= stopMark + 1e-6, loss };
}

function holdPnlCents(t: PaperTicket): number {
  return t.holdPnlCents ?? t.pnlCents ?? 0;
}

/** True when stored marks actually contain the ticket's recorded peak. */
function pathMarksCoverMfe(t: PaperTicket, entry: number): boolean {
  const marks = t.pathMarks;
  if (!marks || marks.length < 2) return false;
  const mfe = t.mfeCents ?? 0;
  if (mfe <= 0.05) return true;
  const peak = entry + mfe;
  // 0.5¢ slack — coarsened paths often miss the exact peak by a tick.
  return marks.some((m) => m + 1e-6 >= peak - 0.5);
}

function tpBarrier(
  entry: number,
  tp: TpSpec,
  t: PaperTicket,
): { mark: number | null; pnl: number } {
  if (tp.kind === "native") {
    const cents = t.targetCents;
    if (cents == null || cents <= 0) return { mark: null, pnl: 0 };
    return tpBarrier(entry, { kind: "delta", cents }, t);
  }
  if (tp.kind === "delta") {
    const room = Math.round((100 - entry) * 10) / 10;
    if (tp.cents > 0 && tp.cents < room) {
      return { mark: snapKalshiCents(entry + tp.cents), pnl: tp.cents };
    }
    return { mark: null, pnl: 0 };
  }
  if (tp.kind === "mark") {
    const need = Math.round((tp.markCents - entry) * 10) / 10;
    if (need > 0) return { mark: snapKalshiCents(tp.markCents), pnl: need };
  }
  return { mark: null, pnl: 0 };
}

/**
 * Mode A remainder: the paper settle mark, including 0¢ wipes.
 * pathMarks drop prints under 2¢ and coarsen min/max, so using the last
 * stored sample treated a full ask wipe as a small scratch.
 */
function windowRemainderPnl(t: PaperTicket, entry: number): number {
  if (t.lastMarkCents != null && Number.isFinite(t.lastMarkCents)) {
    return Math.round((t.lastMarkCents - entry) * 10) / 10;
  }
  return t.pnlCents ?? 0;
}

/**
 * Replay one ticket under SL + TP.
 * Prefer stored entry→expiry marks (first touch; stop wins on the same print).
 * Else MAE·MFE.
 * remainder=expiry: Mode B — 0/100 if neither barrier fires.
 * remainder=window: Mode A scalp — paper settle mark (including 0¢ wipes).
 */
function simulatePnl(
  t: PaperTicket,
  sl: SlSpec,
  tp: TpSpec,
  sized = false,
  remainder: Remainder = "expiry",
): number {
  const n = sized ? Math.max(t.contracts ?? 1, 0.01) : 1;
  const entry = snapKalshiCents(t.entryAsk * 100);
  const holdPer = holdPnlCents(t) / n;
  const useExpiry = remainder === "expiry";
  const mfe = useExpiry
    ? Math.max(t.mfeCents ?? 0, holdPer > 0 ? Math.round(holdPer * 10) / 10 : 0)
    : Math.max(t.mfeCents ?? 0, 0);
  const mae = useExpiry
    ? Math.min(usableMaeCents(t), holdPer < 0 ? Math.round(holdPer * 10) / 10 : 0)
    : usableMaeCents(t);
  const { loss: stopLoss } = stopHit(entry, mae, sl);
  const tpBar = tpBarrier(entry, tp, t);
  const stopMark = stopMarkFor(entry, sl);
  const canStop = stopMark != null && stopLoss >= MIN_STOP_CENTS - 1e-6;
  const noBarrier = () =>
    (useExpiry ? holdPnlCents(t) : windowRemainderPnl(t, entry) * n);

  // Live Mode B + hold: realized pnlCents already applied the protocol stop.
  // Prefer that over path replay — coarsened paths often omit the 49¢ trough
  // (or jump 60→0 while skipping marks <2¢), which made 49¢ look catastrophic
  // and let weaker uniform SLs win with Rec < All PnL.
  if (sl.kind === "protocol" && tp.kind === "hold") {
    return (t.pnlCents ?? 0) * n;
  }

  // Walk tick/candle marks only when they include the recorded peak.
  // Backfilled settles stored [entry] only — walking that would skip +1¢ TP
  // on winners (keep full expiry PnL) while still taking +1¢ on reconstructed
  // stop paths. Rec then looks like $13 on a +1¢ policy.
  if (pathMarksCoverMfe(t, entry)) {
    for (const mark of t.pathMarks!) {
      if (mark < 2) continue;
      const hitS = canStop && mark <= stopMark! + 1e-6;
      const hitT = tpBar.mark != null && mark + 1e-6 >= tpBar.mark;
      if (hitS && hitT) return -stopLoss * n;
      if (hitS) return -stopLoss * n;
      if (hitT) return tpBar.pnl * n;
    }
    // Path may omit troughs (coarsen / 48-cap). Fall through to MAE·MFE so a
    // recorded dip through the stop still counts.
  }

  const { hit: maeStop } = stopHit(entry, mae, sl);
  const hitTp =
    tpBar.mark != null &&
    mfe + 1e-6 >= Math.round((tpBar.mark - entry) * 10) / 10;
  if (maeStop && hitTp) return -stopLoss * n;
  if (maeStop) return -stopLoss * n;
  if (hitTp) return tpBar.pnl * n;
  return noBarrier();
}

/** Dollar-total replay of current tickets under a recommended SL/TP cell. */
export function replaySumCents(
  tickets: PaperTicket[],
  cell: ExitOptCell,
  remainder: Remainder = "expiry",
): number | null {
  const tp = cellToTp(cell);
  const sl = slFromCell(cell);
  if (tp == null || sl == null) return null;
  const sum = tickets.reduce(
    (s, t) => s + simulatePnl(t, sl, tp, true, remainder),
    0,
  );
  return Math.round(sum * 10) / 10;
}

function sumUnder(
  tickets: PaperTicket[],
  sl: SlSpec,
  tp: TpSpec,
  remainder: Remainder,
): number {
  return tickets.reduce(
    (s, t) => s + simulatePnl(t, sl, tp, true, remainder),
    0,
  );
}

/**
 * Mode B SL: every candidate in the search space (no coverage shorthand).
 */
function modeBSlGrid(_tickets?: PaperTicket[]): SlSpec[] {
  return [
    PROTOCOL_STOP,
    NO_STOP,
    ...MODE_B_SL_MARKS.map((cents) => ({ kind: "mark" as const, cents })),
    ...MODE_B_SL_PCTS.map((pct) => ({ kind: "pct" as const, pct })),
  ];
}

/**
 * Mode B TP: every candidate in the search space (no coverage shorthand).
 */
function modeBTpGrid(_tickets?: PaperTicket[]): TpSpec[] {
  return [
    { kind: "hold" },
    ...MODE_B_TP_DELTAS.map((cents) => ({ kind: "delta" as const, cents })),
    ...MODE_B_TP_MARKS.map((markCents) => ({ kind: "mark" as const, markCents })),
  ];
}

/** Live mid-market paper has no stop — Rec SL stays off so the column matches. */
function modeASlGrid(_tickets?: PaperTicket[]): SlSpec[] {
  return [NO_STOP];
}

/** Protocol 36: mid-market is fixed +20¢ TP only (no stop, no sizing bank). */
function modeATpGrid(_tickets?: PaperTicket[]): TpSpec[] {
  return [{ kind: "delta", cents: 20 }];
}

function tpToCell(tp: TpSpec): {
  takeProfitKind: TakeProfitKind;
  takeProfitValue: number | null;
} {
  if (tp.kind === "hold") return { takeProfitKind: "hold", takeProfitValue: null };
  if (tp.kind === "native") return { takeProfitKind: "native", takeProfitValue: null };
  if (tp.kind === "delta")
    return { takeProfitKind: "delta", takeProfitValue: tp.cents };
  return { takeProfitKind: "mark", takeProfitValue: tp.markCents };
}

function bySettleTime(tickets: PaperTicket[]): PaperTicket[] {
  return [...tickets].sort(
    (a, b) => (a.settledAtMs ?? a.openedAtMs) - (b.settledAtMs ?? b.openedAtMs),
  );
}

/** Later 30% of fills, if both sides are large enough to mean anything. */
function splitHoldout(
  tickets: PaperTicket[],
): { train: PaperTicket[]; test: PaperTicket[] } | null {
  const ordered = bySettleTime(tickets);
  if (ordered.length < 20) return null;
  const cut = Math.floor(ordered.length * 0.7);
  const test = ordered.slice(cut);
  if (test.length < 8) return null;
  return { train: ordered.slice(0, cut), test };
}

/** Prefer protocol / no-stop / hold when Rec PnL is tied. */
function simplerExit(sl: SlSpec, tp: TpSpec): number {
  const tpSimple = tp.kind === "hold" || tp.kind === "native" ? 0 : 1;
  const slSimple =
    sl.kind === "none" || sl.kind === "protocol" ? 0 : 1;
  return slSimple + tpSimple;
}

function argmaxRecPnl(
  tickets: PaperTicket[],
  slGrid: SlSpec[],
  tpGrid: TpSpec[],
  remainder: Remainder,
): { sl: SlSpec; tp: TpSpec; sum: number } {
  let bestSl: SlSpec = slGrid[0] ?? NO_STOP;
  let bestTp: TpSpec = tpGrid[0] ?? HOLD_TP;
  let bestSum = sumUnder(tickets, bestSl, bestTp, remainder);
  for (const sl of slGrid) {
    for (const tp of tpGrid) {
      const sum = sumUnder(tickets, sl, tp, remainder);
      if (sum > bestSum + 1e-6) {
        bestSum = sum;
        bestSl = sl;
        bestTp = tp;
      } else if (
        Math.abs(sum - bestSum) <= 1e-6 &&
        simplerExit(sl, tp) < simplerExit(bestSl, bestTp)
      ) {
        bestSl = sl;
        bestTp = tp;
      }
    }
  }
  return { sl: bestSl, tp: bestTp, sum: bestSum };
}

function searchBest(
  tickets: PaperTicket[],
  mode: "A" | "B",
  minReady = EXIT_OPT_MIN_READY,
): Pick<
  ExitOptCell,
  | "stopKind"
  | "stopAtEntryPct"
  | "stopMarkCents"
  | "takeProfitKind"
  | "takeProfitValue"
  | "expectancyCents"
  | "counterfactualSumCents"
  | "holdoutSumCents"
> {
  if (mode === "A") {
    const picked = argmaxRecPnl(
      tickets,
      modeASlGrid(tickets),
      modeATpGrid(tickets),
      "window",
    );
    return {
      ...slToCell(picked.sl),
      ...tpToCell(picked.tp),
      expectancyCents: tickets.length ? picked.sum / tickets.length : null,
      counterfactualSumCents: Math.round(picked.sum * 10) / 10,
      holdoutSumCents: null,
    };
  }

  /**
   * Mode B:
   * - Search every SL×TP on replay-ready fills (entry→expiry paths that continue
   *   past the live 49¢ stop so counterfactuals are observable).
   * - Pick the pair that maximizes replayed PnL on that path sample.
   * - Rec PnL = that same pair applied to the complete bucket history.
   * - Until enough path-ready fills exist, keep the live protocol (49¢ / hold).
   */
  const slGrid = modeBSlGrid(tickets);
  const tpGrid = modeBTpGrid(tickets);
  const protocolSumAll = sumUnder(tickets, PROTOCOL_STOP, HOLD_TP, "expiry");
  let bestSl: SlSpec = PROTOCOL_STOP;
  let bestTp: TpSpec = HOLD_TP;
  let bestSum = protocolSumAll;

  const { ready } = partitionReplayTickets(tickets);
  if (ready.length >= minReady) {
    const picked = argmaxRecPnl(ready, slGrid, tpGrid, "expiry");
    bestSl = picked.sl;
    bestTp = picked.tp;
    // Entire history under the recommended pair (same sample as All PnL).
    bestSum = sumUnder(tickets, bestSl, bestTp, "expiry");
  }

  const holdout = splitHoldout(tickets);
  const holdoutSum = holdout
    ? Math.round(sumUnder(holdout.test, bestSl, bestTp, "expiry") * 10) / 10
    : null;
  return {
    ...slToCell(bestSl),
    ...tpToCell(bestTp),
    expectancyCents: tickets.length ? bestSum / tickets.length : null,
    counterfactualSumCents: Math.round(bestSum * 10) / 10,
    holdoutSumCents: holdoutSum,
  };
}

export interface ExitOptOptions {
  minSamples?: number;
  minReady?: number;
  /** When set, do not fall back to `historicalSettled` (used for live / current-era paper). */
  liveOnly?: boolean;
  /** Full-history replay on the included sample (excluded fills omitted). */
  replayComplete?: boolean;
  /** Fills dropped from replay (no path) — surfaced in the optimizer note. */
  excludedN?: number;
}

function optimizeBucket(
  current: PaperTicket[],
  historical: PaperTicket[],
  mode: "A" | "B",
  opts: ExitOptOptions = {},
): ExitOptCell {
  const minReady = opts.minReady ?? EXIT_OPT_MIN_READY;
  const minSamples = opts.minSamples ?? EXIT_OPT_MIN_SAMPLES;
  const cur = decided(current);
  const hist = opts.liveOnly ? [] : decided(historical);

  let sample: PaperTicket[];
  let source: ExitOptCell["source"];

  if (cur.length >= minReady) {
    sample = cur;
    source = "current";
  } else if (!opts.liveOnly && hist.length >= minSamples) {
    sample = hist;
    source = "historical";
  } else if (cur.length >= minSamples) {
    sample = cur;
    // Live fills with a thin sample still count as current so the board is not
    // greyed out as "prior paper paths".
    source = opts.liveOnly ? "current" : "historical";
  } else {
    return {
      ...emptyCell(),
      sampleSize: Math.max(cur.length, hist.length),
      baselineExpectancyCents: baselineE(cur.length ? cur : hist),
      source: "insufficient",
    };
  }

  const best = searchBest(sample, mode, minReady);
  return {
    ...emptyCell(),
    ...best,
    baselineExpectancyCents: baselineE(sample),
    sampleSize: sample.length,
    source,
  };
}

/**
 * Optimize stop-loss / take-profit per mode × asset from entry→expiry paths.
 * Mode B grid includes the live protocol stop (49¢ / 50%) as one candidate;
 * Rec is the argmax pair replayed on the full bucket history.
 */
export function buildExitOptimization(args: {
  currentSettled: PaperTicket[];
  historicalSettled: PaperTicket[];
  options?: ExitOptOptions;
}): ExitOptimization {
  const { currentSettled, historicalSettled, options } = args;

  function forMode(mode: "A" | "B"): ModeExitOpts {
    const curMode = currentSettled.filter((t) => t.mode === mode);
    const histMode = historicalSettled.filter((t) => t.mode === mode);
    const byAsset = {} as Record<AssetSymbol, ExitOptCell>;
    for (const symbol of ASSET_ORDER) {
      const coinTickets = decided(curMode.filter((t) => t.symbol === symbol));
      const cell = optimizeBucket(
        curMode.filter((t) => t.symbol === symbol),
        histMode.filter((t) => t.symbol === symbol),
        mode,
        options,
      );
      byAsset[symbol] = {
        ...cell,
        counterfactualSumCents: replaySumCents(
          coinTickets,
          cell,
          mode === "A" ? "window" : "expiry",
        ),
      };
    }
    const allTickets = decided(curMode);
    const all = optimizeBucket(curMode, histMode, mode, options);
    return {
      all: {
        ...all,
        counterfactualSumCents: replaySumCents(
          allTickets,
          all,
          mode === "A" ? "window" : "expiry",
        ),
      },
      byAsset,
    };
  }

  const modeA = forMode("A");
  const modeB = forMode("B");

  const anyHist =
    modeA.all.source === "historical" ||
    modeB.all.source === "historical" ||
    ASSET_ORDER.some(
      (s) =>
        modeA.byAsset[s]!.source === "historical" ||
        modeB.byAsset[s]!.source === "historical",
    );
  const anyThin =
    modeA.all.source === "insufficient" ||
    modeB.all.source === "insufficient";

  let note = "SL/TP = scorecard All-era policy that maximizes replayed PnL";
  if (options?.liveOnly) {
    const nB = currentSettled.filter((t) => t.mode === "B").length;
    const nA = currentSettled.filter((t) => t.mode === "A").length;
    const combos = modeBSlGrid().length * modeBTpGrid().length;
    note =
      `Rec PnL = complete All-era history · best of ${combos} Mode B combos` +
      (nA > 0 ? ` · Mode A on ${nA} fills` : "") +
      ` · EOM n=${nB}`;
  } else if (anyHist) note = "SL/TP provisional (prior paths) · Rec PnL of displayed pair";
  if (anyThin && !anyHist && !options?.liveOnly) note = "SL/TP collecting samples";

  return { modeA, modeB, note };
}

function labelSlTp(sl: SlSpec, tp: TpSpec): { sl: string; tp: string; pair: string } {
  const cell = { ...emptyCell(), ...slToCell(sl), ...tpToCell(tp), source: "current" as const };
  const pair = formatExitOpt(cell);
  const [slLabel, tpLabel] = pair.split("/");
  return { sl: slLabel ?? "—", tp: tpLabel ?? "—", pair };
}

export interface ModeBExitIdealRow {
  key: string;
  n: number;
  sl: string;
  tp: string;
  pair: string;
  recPnlCents: number;
  /** Realized PnL under live 49¢ protocol on the same fills. */
  protocolPnlCents: number;
  /** Rec − protocol on this sample. */
  edgeCents: number;
}

/**
 * Research: raw SL×TP argmax on replay-ready Mode B fills only (full exit-range
 * paths). No shipping gate — reports the grid winner per coin and ALL.
 */
export function researchModeBExitIdeals(
  modeBTickets: PaperTicket[],
): {
  readyN: number;
  eraN: number;
  gridCombos: number;
  rows: ModeBExitIdealRow[];
} {
  const era = modeBTickets.filter((t) => t.mode === "B");
  const { ready } = partitionReplayTickets(era);
  const slGrid = modeBSlGrid();
  const tpGrid = modeBTpGrid();
  const gridCombos = slGrid.length * tpGrid.length;

  function row(key: string, tickets: PaperTicket[]): ModeBExitIdealRow | null {
    if (!tickets.length) return null;
    const picked = argmaxRecPnl(tickets, slGrid, tpGrid, "expiry");
    const protocolSum = sumUnder(tickets, PROTOCOL_STOP, HOLD_TP, "expiry");
    const labels = labelSlTp(picked.sl, picked.tp);
    return {
      key,
      n: tickets.length,
      sl: labels.sl,
      tp: labels.tp,
      pair: labels.pair,
      recPnlCents: Math.round(picked.sum * 10) / 10,
      protocolPnlCents: Math.round(protocolSum * 10) / 10,
      edgeCents: Math.round((picked.sum - protocolSum) * 10) / 10,
    };
  }

  const rows: ModeBExitIdealRow[] = [];
  const allRow = row("ALL", ready);
  if (allRow) rows.push(allRow);
  for (const symbol of ASSET_ORDER) {
    const coin = row(symbol, ready.filter((t) => t.symbol === symbol));
    if (coin) rows.push(coin);
  }

  return { readyN: ready.length, eraN: era.length, gridCombos, rows };
}

/** Compact display helper for logs / tooltips. */
export function formatExitOpt(cell: ExitOptCell): string {
  if (cell.source === "insufficient") return "—";
  let sl = "—";
  if (cell.stopKind === "none") sl = "off";
  else if (cell.stopKind === "protocol") sl = "49¢";
  else if (cell.stopKind === "delta" && cell.stopMarkCents != null)
    sl = `-${formatCentValue(cell.stopMarkCents)}¢`;
  else if (cell.stopKind === "mark" && cell.stopMarkCents != null)
    sl = `${formatCentValue(cell.stopMarkCents)}¢`;
  else if (cell.stopAtEntryPct != null) sl = `${cell.stopAtEntryPct}%`;
  else return "—";
  let tp = "hold";
  if (cell.takeProfitKind === "native") tp = "tgt";
  else if (cell.takeProfitKind === "delta" && cell.takeProfitValue != null)
    tp = `+${cell.takeProfitValue}¢`;
  else if (cell.takeProfitKind === "mark" && cell.takeProfitValue != null)
    tp = `${formatCentValue(cell.takeProfitValue)}¢`;
  return `${sl}/${tp}`;
}

/**
 * Live exit marks from an exit-opt cell. `null` stop/TP means that barrier is off.
 * Returns null when the cell is missing / insufficient (caller keeps protocol default).
 */
export function liveExitMarksFromCell(
  entryAsk: number,
  cell: ExitOptCell | null | undefined,
): { stopMarkCents: number | null; takeProfitMarkCents: number | null; label: string } | null {
  if (!cell || cell.source === "insufficient") return null;
  const entry = snapKalshiCents(entryAsk * 100);
  const sl = slFromCell(cell);
  const tp = cellToTp(cell);
  if (sl == null || tp == null) return null;

  let stopMarkCents: number | null = null;
  if (sl.kind !== "none") {
    const mark = stopMarkFor(entry, sl);
    if (mark != null) {
      const loss = Math.round((entry - mark) * 10) / 10;
      if (loss >= MIN_STOP_CENTS) stopMarkCents = mark;
    }
  }

  let takeProfitMarkCents: number | null = null;
  if (tp.kind === "delta" && tp.cents > 0 && entry + tp.cents < 100) {
    takeProfitMarkCents = snapKalshiCents(entry + tp.cents);
  } else if (tp.kind === "mark" && tp.markCents > entry) {
    takeProfitMarkCents = snapKalshiCents(tp.markCents);
  }

  return {
    stopMarkCents,
    takeProfitMarkCents,
    label: formatExitOpt(cell),
  };
}
