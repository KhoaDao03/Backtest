import {
  scorecardPnlCents,
  type AssetModePair,
  type DayScorecard,
  type ModeScorecard,
  type ModeStreaks,
  type PaperTicket,
  type ScoreWindowSlice,
} from "@/lib/performanceTypes";
import type {
  ArmId,
  AssetSymbol,
  DecisionResult,
  MarketSnapshot,
  ModeALane,
  ModeARecommendation,
  Side,
} from "@/lib/types";
import {
  ARM_IDS,
  MODE_A_REV_ENABLED,
  MODE_B_END_SEC,
  MODE_B_HIGHLIGHT_CONF,
  MODE_B_START_SEC,
} from "@/lib/types";
import { snapKalshiCents, snapKalshiPrice } from "@/lib/math";
import { ASSET_ORDER } from "@/lib/demoMarkets";
import {
  appendSignalEvent,
  appendEarly85Log,
  dayKeyFromMs,
  loadAllSettled,
  loadOpenTickets,
  saveOpenTickets,
} from "@/server/performance/journal";
import { isEpochVoidedTicket } from "@/server/performance/scorecardExclude";
import { emptyExitOptimization } from "@/server/performance/exitOptimizer";
import { skipExitOpt, skipSessionOpt } from "@/lib/runtimeFlags";
import { invalidateExitOptCache, readExitOptSlice } from "@/lib/exitOptStore";
import { scheduleExitOptRebuild } from "@/server/performance/exitOptScheduler";
import {
  invalidateSessionOptCache,
  readSessionOptBundle,
} from "@/server/performance/sessionOptStore";
import { scheduleSessionOptRebuild } from "@/server/performance/sessionOptScheduler";
import type { ExitOptimization } from "@/lib/performanceTypes";
import type { PaperSessionOptBundle } from "@/lib/sessionOptTypes";

/**
 * Protocol 37 — EOM entries 8:00→end (was closed at 2:00). Mid still +20¢ / no stop.
 */
export const PAPER_PROTOCOL = 37;

/**
 * Oldest protocol whose Mode B tickets still describe today's Mode B.
 * Matches PAPER_PROTOCOL on a full-board epoch reset.
 */
export const MODE_B_LINEAGE_MIN = 37;

const MS_2H = 2 * 60 * 60 * 1000;
const MS_24H = 24 * 60 * 60 * 1000;

/** Does this settled ticket still describe the logic running today? */
function isCurrentEra(t: PaperTicket): boolean {
  const p = (t as PaperTicket & { protocol?: number }).protocol ?? 0;
  return t.mode === "B" ? p >= MODE_B_LINEAGE_MIN : p === PAPER_PROTOCOL;
}

function isMomTicket(t: PaperTicket): boolean {
  return t.mode === "A" && t.source === "mom";
}

function isRevTicket(t: PaperTicket): boolean {
  return t.mode === "A" && t.source === "rev";
}

/**
 * Exit mark (¢) for paper stop-loss, or null when that mode has no stop.
 *
 * Mid-market (Mode A) holds through the window: target hit or last mark at
 * expiry. End-of-market (Mode B) keeps the 49¢ floor on entries ≥80¢.
 */
export function stopMarkCents(entryAsk: number, mode: "A" | "B"): number | null {
  if (mode === "A") return null;
  const entry = entryAsk * 100;
  if (entry >= 80) return 49;
  return snapKalshiCents(entry * 0.5);
}

function ticketProtocol(t: PaperTicket): number {
  return (t as PaperTicket & { protocol?: number }).protocol ?? PAPER_PROTOCOL;
}

/** The book as the entry saw it, in cents, so fills can be audited later. */
/** Tickets written before `source` existed were all explorer entries. */
function isEarly85Ticket(t: PaperTicket): boolean {
  return t.source === "early85";
}

function isHoldPaperTicket(t: PaperTicket): boolean {
  return t.source === "hold-paper";
}

function isHoldMomTicket(t: PaperTicket): boolean {
  return t.source === "hold-mom";
}

function isHoldRevTicket(t: PaperTicket): boolean {
  return t.source === "hold-rev";
}

function isModeAHoldTicket(t: PaperTicket): boolean {
  return isHoldMomTicket(t) || isHoldRevTicket(t);
}

function episodeLane(source: PaperTicket["source"] | undefined): ModeALane | null {
  if (source === "mom" || source === "hold-mom") return "mom";
  if (source === "rev" || source === "hold-rev") return "rev";
  return null;
}

/** Scorecard Mode B — excludes early-85 and HOLD-gate shadow paper. */
function isModeBLiveLineage(t: PaperTicket): boolean {
  return t.mode === "B" && !isEarly85Ticket(t) && !isHoldPaperTicket(t);
}

function bookOf(snap: MarketSnapshot) {
  return {
    askUp: snapKalshiCents(snap.askUp * 100),
    bidUp: snapKalshiCents(snap.bidUp * 100),
    askDown: snapKalshiCents(snap.askDown * 100),
    bidDown: snapKalshiCents(snap.bidDown * 100),
  };
}

function markCents(side: Side, snap: MarketSnapshot): number {
  const bid = side === "up" ? snap.bidUp : snap.bidDown;
  return snapKalshiCents(bid * 100);
}

function emptyMode(): ModeScorecard {
  return {
    opens: 0,
    settled: 0,
    hitsOrWins: 0,
    missesOrLosses: 0,
    voids: 0,
    openNow: 0,
    hitRate: null,
    expectancyCents: null,
    sumPnlCents: 0,
  };
}

function scoreMode(tickets: PaperTicket[], openNow: number): ModeScorecard {
  const s = emptyMode();
  s.openNow = openNow;
  s.opens = tickets.length + openNow;
  for (const t of tickets) {
    if (t.outcome === "open") continue;
    if (t.outcome === "void") {
      s.voids += 1;
      continue;
    }
    s.settled += 1;
    if (t.outcome === "hit" || t.outcome === "win") s.hitsOrWins += 1;
    else if (t.outcome === "miss" || t.outcome === "loss") s.missesOrLosses += 1;
    s.sumPnlCents += scorecardPnlCents(t);
  }
  const decided = s.hitsOrWins + s.missesOrLosses;
  s.hitRate = decided > 0 ? s.hitsOrWins / decided : null;
  s.expectancyCents = decided > 0 ? s.sumPnlCents / decided : null;
  return s;
}

function buildWindowSlice(args: {
  id: ScoreWindowSlice["id"];
  label: string;
  settled: PaperTicket[];
  settledMom: PaperTicket[];
  settledRev: PaperTicket[];
  openA: PaperTicket[];
  openB: PaperTicket[];
  openMom: PaperTicket[];
  openRev: PaperTicket[];
  openEarly85: PaperTicket[];
  /** null = all time; else only tickets settled on/after this ms */
  sinceMs: number | null;
}): ScoreWindowSlice {
  const {
    id,
    label,
    settled,
    settledMom,
    settledRev,
    openA,
    openB,
    openMom,
    openRev,
    openEarly85,
    sinceMs,
  } = args;
  const inWindow =
    sinceMs == null
      ? settled
      : settled.filter((t) => (t.settledAtMs ?? t.openedAtMs) >= sinceMs);
  const inWindowMom =
    sinceMs == null
      ? settledMom
      : settledMom.filter((t) => (t.settledAtMs ?? t.openedAtMs) >= sinceMs);
  const inWindowRev =
    sinceMs == null
      ? settledRev
      : settledRev.filter((t) => (t.settledAtMs ?? t.openedAtMs) >= sinceMs);
  const includeOpen = sinceMs == null;

  const all: AssetModePair = {
    modeA: scoreMode(
      MODE_A_REV_ENABLED
        ? inWindow.filter((t) => t.mode === "A")
        : inWindowMom,
      includeOpen
        ? MODE_A_REV_ENABLED
          ? openA.filter((t) => t.source === "mom" || t.source === "rev").length
          : openMom.length
        : 0,
    ),
    modeB: scoreMode(
      inWindow.filter((t) => isModeBLiveLineage(t)),
      includeOpen ? openB.length : 0,
    ),
    modeAMom: scoreMode(inWindowMom, includeOpen ? openMom.length : 0),
    modeARev: scoreMode(inWindowRev, includeOpen ? openRev.length : 0),
    modeBEarly: scoreMode(
      inWindow.filter((t) => isEarly85Ticket(t)),
      includeOpen ? openEarly85.length : 0,
    ),
  };

  const byAsset = {} as ScoreWindowSlice["byAsset"];
  for (const symbol of ASSET_ORDER) {
    byAsset[symbol] = {
      modeA: scoreMode(
        inWindow.filter((t) => t.mode === "A" && t.symbol === symbol),
        includeOpen
          ? openA.filter(
              (t) =>
                t.symbol === symbol && (t.source === "mom" || t.source === "rev"),
            ).length
          : 0,
      ),
      modeB: scoreMode(
        inWindow.filter((t) => isModeBLiveLineage(t) && t.symbol === symbol),
        includeOpen ? openB.filter((t) => t.symbol === symbol).length : 0,
      ),
      modeAMom: scoreMode(
        inWindowMom.filter((t) => t.symbol === symbol),
        includeOpen ? openMom.filter((t) => t.symbol === symbol).length : 0,
      ),
      modeARev: scoreMode(
        inWindowRev.filter((t) => t.symbol === symbol),
        includeOpen ? openRev.filter((t) => t.symbol === symbol).length : 0,
      ),
      modeBEarly: scoreMode(
        inWindow.filter((t) => isEarly85Ticket(t) && t.symbol === symbol),
        includeOpen
          ? openEarly85.filter((t) => t.symbol === symbol).length
          : 0,
      ),
    };
  }

  const modeAArms = {} as Record<ArmId, ModeScorecard>;
  const inWindowA = inWindow.filter((t) => t.mode === "A");
  for (const arm of ARM_IDS) {
    const armSettled = inWindowA.filter((t) => t.arms?.includes(arm));
    const armOpen = openA.filter((t) => t.arms?.includes(arm));
    modeAArms[arm] = scoreMode(
      armSettled,
      includeOpen ? armOpen.length : 0,
    );
  }

  return { id, label, all, byAsset, modeAArms };
}

/** Count consecutive wins from the most recent decided settle backward. */
function currentWinStreak(tickets: PaperTicket[]): number {
  const decided = tickets
    .filter(
      (t) =>
        t.outcome === "hit" ||
        t.outcome === "win" ||
        t.outcome === "miss" ||
        t.outcome === "loss",
    )
    .sort(
      (a, b) =>
        (a.settledAtMs ?? a.openedAtMs) - (b.settledAtMs ?? b.openedAtMs),
    );
  let streak = 0;
  for (let i = decided.length - 1; i >= 0; i--) {
    const o = decided[i]!.outcome;
    if (o === "hit" || o === "win") streak += 1;
    else break;
  }
  return streak;
}

function buildModeStreaks(settled: PaperTicket[], mode: "A" | "B"): ModeStreaks {
  const forMode = settled.filter((t) => t.mode === mode);
  const byAsset = {} as Record<AssetSymbol, number>;
  for (const symbol of ASSET_ORDER) {
    byAsset[symbol] = currentWinStreak(
      forMode.filter((t) => t.symbol === symbol),
    );
  }
  return { all: currentWinStreak(forMode), byAsset };
}

export class PerformanceTracker {
  private openA: PaperTicket[] = [];
  private openB: PaperTicket[] = [];
  private openEarly85: PaperTicket[] = [];
  /** Market tickers that already claimed their single Mode B paper entry. */
  private modeBClaimedMarkets = new Set<string>();
  /** HOLD-gate shadow paper — separate from scorecard claimed so live can resume. */
  private holdPaperClaimedMarkets = new Set<string>();
  private early85ClaimedMarkets = new Set<string>();
  /** Mode B markets stop-settled this window — suppress highlight as open position. */
  private modeBStoppedMarkets = new Set<string>();
  /** Mode A symbols stopped this tick — engine clears that lane's sticky. */
  private stoppedModeALanes: { symbol: AssetSymbol; lane: ModeALane }[] = [];
  /**
   * Cadence state for the baseline arms, keyed by source so the explorer and the
   * two protocols never gate each other. Sharing these maps would let whichever
   * arm ticked first suppress the others' entries and quietly turn independent
   * benchmarks into a single interleaved one.
   */
  private baselineState = new Map<
    string,
    {
      lastAction: Map<AssetSymbol, "wait" | "buy">;
      lastSide: Map<AssetSymbol, Side | null>;
      waitSince: Map<AssetSymbol, number>;
    }
  >();
  /**
   * Lit mid-market episode per lane. Paper opens once on light-up; a Wait
   * (box unlit) clears this so the next Buy is a new ticket.
   */
  private laneEpisode = new Map<string, { ticker: string; side: Side }>();
  /** In-memory settled journal — avoids re-reading signals.jsonl on every publish. */
  private settledCache: PaperTicket[] | null = null;
  private lastPersistOpenMs = 0;
  private persistOpenDirty = false;
  /**
   * Paper already flattened (stop or Mode A target) but still recording
   * entry→expiry marks so Rec is not truncated at 49¢ / 50%.
   */
  private pathFollow: PaperTicket[] = [];

  constructor(private opts: { skipModeA?: boolean; skipModeB?: boolean } = {}) {
    const cached = this.getSettledCached();
    for (const t of loadOpenTickets()) {
      if (t.outcome !== "open" && !t.pathComplete) {
        const rec = cached.find((s) => s.id === t.id) ?? t;
        if (!this.pathFollow.some((p) => p.id === rec.id)) this.pathFollow.push(rec);
        continue;
      }
      if (t.outcome !== "open") continue;
      if (t.mode === "A") {
        if (!isCurrentEra(t)) continue;
        this.openA.push(t);
      } else if (isEarly85Ticket(t)) {
        this.openEarly85.push(t);
        this.early85ClaimedMarkets.add(t.marketTicker);
      } else {
        this.openB.push(t);
        if (isHoldPaperTicket(t)) this.holdPaperClaimedMarkets.add(t.marketTicker);
        else this.modeBClaimedMarkets.add(t.marketTicker);
      }
    }
    for (const t of this.openA) {
      const lane = episodeLane(t.source);
      if (!lane) continue;
      this.laneEpisode.set(`${t.symbol}:${lane}`, {
        ticker: t.marketTicker,
        side: t.side,
      });
    }
  }

  private getSettledCached(): PaperTicket[] {
    if (!this.settledCache) this.settledCache = loadAllSettled();
    return this.settledCache;
  }

  private rememberSettled(ticket: PaperTicket) {
    // Scorecard memory does not need entry→expiry mark arrays (journal keeps them).
    const slim =
      ticket.pathMarks && ticket.pathMarks.length
        ? { ...ticket, pathMarks: undefined }
        : ticket;
    const cache = this.getSettledCached();
    const i = cache.findIndex((t) => t.id === slim.id);
    if (i >= 0) cache[i] = slim;
    else cache.push(slim);
    // Session sit-out can use the settle row immediately.
    scheduleSessionOptRebuild("settle");
    // SL/TP Rec needs entry→expiry marks beyond the live stop/TP. Rebuild only
    // once pathFollow has finished (or the settle already held to determination).
    if (ticket.pathComplete) {
      scheduleExitOptRebuild("path-complete");
    }
  }

  /** Lanes that hit stop-loss for this symbol during the last onTick. */
  wasModeALaneStopped(symbol: AssetSymbol): ModeALane[] {
    return this.stoppedModeALanes
      .filter((s) => s.symbol === symbol)
      .map((s) => s.lane);
  }

  /**
   * Rec boxes follow mom/rev paper. A stop on that lane clears its sticky.
   */
  private noteDisplayedModeAStop(ticket: PaperTicket) {
    if (ticket.mode !== "A") return;
    if (ticket.source === "mom" || ticket.source === "rev") {
      this.stoppedModeALanes.push({ symbol: ticket.symbol, lane: ticket.source });
    }
  }

  /** Clear the per-tick Mode A stop list (call once after processing all assets). */
  drainStoppedModeA(): ModeALane[] {
    this.stoppedModeALanes = [];
    return [];
  }

  /** True if Mode B paper already stopped out on this market ticker. */
  isModeBStopped(marketTicker: string): boolean {
    return this.modeBStoppedMarkets.has(marketTicker);
  }

  /** True if an open Mode B paper ticket exists for this exact market. */
  hasOpenModeB(marketTicker: string): boolean {
    return this.openB.some((t) => t.marketTicker === marketTicker);
  }

  /**
   * Open Mode B scorecard ticket for this market entered in the live entry window.
   */
  getOpenModeBEnteredInWindow(marketTicker: string) {
    return this.openB.find(
      (t) =>
        !isHoldPaperTicket(t) &&
        t.marketTicker === marketTicker &&
        t.secondsLeftAtOpen > MODE_B_END_SEC,
    );
  }

  onTick(args: {
    marketTicker: string;
    snapshot: MarketSnapshot;
    decision: DecisionResult;
    leanLabel: string;
  }) {
    const { marketTicker, snapshot, decision, leanLabel } = args;
    const symbol = snapshot.symbol;

    this.advancePathFollow(symbol, marketTicker, snapshot);

    // Market rollover — settle old ticker tickets using current spot/strike of new window
    // (for Mode B, prefer last known relationship; rollover uses new strike — better settle
    // before strike flips). We settle when ticker changes; spot vs new strike is imperfect
    // so we use spot vs the ticket's strikeAtOpen for Mode B.
    this.openA = this.openA.filter((t) => {
      if (t.symbol === symbol && t.marketTicker !== marketTicker) {
        this.settleA(t, snapshot, "market_rollover");
        return false;
      }
      return true;
    });
    this.openB = this.openB.filter((t) => {
      if (t.symbol === symbol && t.marketTicker !== marketTicker) {
        this.settleB(t, snapshot, "market_rollover");
        this.modeBClaimedMarkets.delete(t.marketTicker);
        this.holdPaperClaimedMarkets.delete(t.marketTicker);
        this.modeBStoppedMarkets.delete(t.marketTicker);
        return false;
      }
      return true;
    });
    this.openEarly85 = this.openEarly85.filter((t) => {
      if (t.symbol === symbol && t.marketTicker !== marketTicker) {
        this.settleEarly85(t, snapshot, "market_rollover");
        this.early85ClaimedMarkets.delete(t.marketTicker);
        return false;
      }
      return true;
    });

    if (!this.opts.skipModeA) {
      this.handleModeA(marketTicker, snapshot, decision, leanLabel);
    }
    if (!this.opts.skipModeB) {
      this.handleModeB(marketTicker, snapshot, decision, leanLabel);
    }
    this.handleEarly85(marketTicker, snapshot, decision, leanLabel);

    // End of window — grade any remaining open A/B tickets (Mode A may still be
    // working a Δ after the 3:00 *entry* cutoff; we do not force-lose at 3:00.)
    if (snapshot.secondsLeft <= MODE_B_END_SEC) {
      this.openA = this.openA.filter((t) => {
        if (t.symbol === symbol) {
          this.settleA(t, snapshot, "window_end");
          return false;
        }
        return true;
      });
      this.openB = this.openB.filter((t) => {
        if (t.symbol === symbol) {
          this.settleB(t, snapshot, "window_end");
          // Keep claimed so we don't reopen in the final seconds if Buy flickers
          return false;
        }
        return true;
      });
      this.openEarly85 = this.openEarly85.filter((t) => {
        if (t.symbol === symbol) {
          this.settleEarly85(t, snapshot, "window_end");
          return false;
        }
        return true;
      });
    }

    this.persistOpen(false);
  }

  getScorecard(): DayScorecard {
    const now = Date.now();
    const allSettled = this.getSettledCached();
    const settled = allSettled.filter(
      (t) =>
        isCurrentEra(t) &&
        !isEpochVoidedTicket(t) &&
        !isEarly85Ticket(t) &&
        !isHoldPaperTicket(t) &&
        !isModeAHoldTicket(t),
    );
    const settledMom = settled.filter(isMomTicket);
    const settledRev = settled.filter(isRevTicket);
    const settledEarly = allSettled.filter(
      (t) => isEarly85Ticket(t) && !isEpochVoidedTicket(t),
    );
    const openMom = this.openA.filter(isMomTicket);
    const openRev = this.openA.filter(isRevTicket);
    // Prior eras (≥13) feed SL/TP search while the live protocol is still thin.
    const historicalSettled = allSettled.filter((t) => {
      const p = (t as PaperTicket & { protocol?: number }).protocol ?? 0;
      return (
        p >= 13 &&
        !isCurrentEra(t) &&
        !isEarly85Ticket(t) &&
        !isHoldPaperTicket(t) &&
        !isModeAHoldTicket(t)
      );
    });

    const windowArgs = {
      settled: [...settled, ...settledEarly],
      settledMom,
      settledRev,
      openA: this.openA,
      openB: this.openB.filter((t) => !isHoldPaperTicket(t)),
      openMom,
      openRev,
      openEarly85: this.openEarly85,
    };

    const windows: ScoreWindowSlice[] = [
      buildWindowSlice({
        id: "all",
        label: "All",
        ...windowArgs,
        sinceMs: null,
      }),
      buildWindowSlice({
        id: "24h",
        label: "24h",
        ...windowArgs,
        sinceMs: now - MS_24H,
      }),
      buildWindowSlice({
        id: "2h",
        label: "2h",
        ...windowArgs,
        sinceMs: now - MS_2H,
      }),
    ];

    const lifetime = windows[0]!.all;
    return {
      dayKey: "lifetime",
      modeA: lifetime.modeA,
      modeB: lifetime.modeB,
      modeBEarly: lifetime.modeBEarly,
      modeAArms: windows[0]!.modeAArms,
      openTickets:
        this.openA.filter((t) => !isModeAHoldTicket(t)).length +
        this.openB.filter((t) => !isHoldPaperTicket(t)).length +
        this.openEarly85.length,
      streaks: {
        modeA: buildModeStreaks(settled.filter((t) => t.mode === "A"), "A"),
        modeB: buildModeStreaks(settled, "B"),
        modeAMom: buildModeStreaks(settledMom, "A"),
        modeARev: buildModeStreaks(settledRev, "A"),
        modeBEarly: buildModeStreaks(settledEarly, "B"),
      },
      exitOpt: this.buildPaperExitOpt(settled, historicalSettled),
      sessionOpt: this.buildPaperSessionOpt(),
      windows,
    };
  }

  /**
   * SL/TP Rec comes only from the exit-opt helper cache (scorecard All-era grid).
   * Never run the combo search on the scorecard / feed hot path.
   */
  private buildPaperExitOpt(
    _settled: PaperTicket[],
    _historicalSettled: PaperTicket[],
  ): ExitOptimization {
    if (skipExitOpt()) {
      return emptyExitOptimization("SL/TP paused");
    }
    const cached = readExitOptSlice("paper") ?? readExitOptSlice("live");
    if (cached) return cached;
    invalidateExitOptCache();
    scheduleExitOptRebuild("cache-miss");
    return emptyExitOptimization("SL/TP helper pending — rebuilding scorecard era");
  }

  /** Sit-out report from session-opt helper cache — never search on the hot path. */
  private buildPaperSessionOpt(): PaperSessionOptBundle | null {
    if (skipSessionOpt()) return null;
    const cached = readSessionOptBundle();
    if (cached) return cached;
    invalidateSessionOptCache();
    scheduleSessionOptRebuild("cache-miss");
    return null;
  }

  /** Drop open tickets and forget Mode B claims (caller clears the journal files). */
  reset() {
    this.openA = [];
    this.openB = [];
    this.openEarly85 = [];
    this.pathFollow = [];
    this.modeBClaimedMarkets.clear();
    this.holdPaperClaimedMarkets.clear();
    this.early85ClaimedMarkets.clear();
    this.modeBStoppedMarkets.clear();
    this.stoppedModeALanes = [];
    this.baselineState.clear();
    this.laneEpisode.clear();
    this.settledCache = null;
    this.persistOpen(true);
  }

  /**
   * Mid-market scorecard wipe only — drop open Mode A / path-follow for A,
   * keep Mode B journal and opens. New Mode A fills use PAPER_PROTOCOL.
   */
  resetModeA() {
    this.pathFollow = this.pathFollow.filter((t) => t.mode !== "A");
    this.openA = [];
    this.stoppedModeALanes = [];
    this.baselineState.clear();
    this.laneEpisode.clear();
    this.settledCache = null;
    this.persistOpen(true);
  }

  private handleModeA(
    marketTicker: string,
    snapshot: MarketSnapshot,
    decision: DecisionResult,
    leanLabel: string,
  ) {
    this.openA = this.openA.filter((t) => {
      if (t.symbol !== snapshot.symbol) return true;
      this.updateExcursion(t, snapshot);
      if (this.hitStop(t)) {
        this.settleStop(t);
        this.noteDisplayedModeAStop(t);
        return false;
      }
      if (t.mfeCents >= (t.targetCents ?? 0)) {
        this.settleA(t, snapshot, "delta_achieved");
        return false;
      }
      return true;
    });

    this.tryOpenLane(
      marketTicker,
      snapshot,
      decision.modeAMom,
      leanLabel,
      "mom",
    );
    if (MODE_A_REV_ENABLED) {
      this.tryOpenLane(
        marketTicker,
        snapshot,
        decision.modeARev,
        leanLabel,
        "rev",
      );
    }
  }

  private tryOpenLane(
    marketTicker: string,
    snapshot: MarketSnapshot,
    rec: ModeARecommendation | undefined,
    leanLabel: string,
    lane: ModeALane,
  ) {
    const key = `${snapshot.symbol}:${lane}`;
    if (
      rec?.action !== "buy" ||
      !rec.side ||
      rec.entryAsk == null ||
      rec.targetCents == null
    ) {
      this.laneEpisode.delete(key);
      return;
    }
    const ep = this.laneEpisode.get(key);
    if (ep && ep.ticker === marketTicker && ep.side === rec.side) return;
    this.laneEpisode.set(key, { ticker: marketTicker, side: rec.side });
    this.openTicket({
      mode: "A",
      symbol: snapshot.symbol,
      marketTicker,
      side: rec.side,
      entryAsk: rec.entryAsk,
      targetCents: rec.targetCents,
      confAtOpen: rec.confidence,
      spotAtOpen: snapshot.spot,
      strikeAtOpen: snapshot.strike,
      secondsLeftAtOpen: snapshot.secondsLeft,
      leanLabel,
      stochK: snapshot.stochK,
      atr1m: snapshot.atr1m,
      arms: rec.arms ?? ["I"],
      armProbs: rec.armProbs,
      etaSecAtOpen: rec.etaSec,
      chopScoreAtOpen: rec.chopScore,
      chopArchetype: rec.chopArchetype,
      trendScoreAtOpen: rec.trendScore,
      momArchetype: rec.momArchetype,
      source: lane,
      bookAtOpen: bookOf(snapshot),
    });
  }

  private stateFor(source: string) {
    let s = this.baselineState.get(source);
    if (!s) {
      s = { lastAction: new Map(), lastSide: new Map(), waitSince: new Map() };
      this.baselineState.set(source, s);
    }
    return s;
  }

  /**
   * A baseline protocol running as its own arm. Entry cadence is copied from the
   * original — one open ticket per asset, re-entry only after a sustained wait or
   * a side flip — because a benchmark that trades at a different frequency than
   * the version it represents isn't that version.
   */
  private handleModeABaseline(
    marketTicker: string,
    snapshot: MarketSnapshot,
    rec: ModeARecommendation,
    leanLabel: string,
    arm: ArmId,
    source: "wide" | "shipped",
  ) {
    const symbol = snapshot.symbol;
    const state = this.stateFor(source);
    const prev = state.lastAction.get(symbol) ?? "wait";
    const action: "wait" | "buy" = rec.action === "buy" ? "buy" : "wait";

    if (action !== "buy" || !rec.side || rec.entryAsk == null || rec.targetCents == null) {
      if (prev === "buy") state.waitSince.set(symbol, Date.now());
      state.lastAction.set(symbol, "wait");
      return;
    }

    const prevSide = state.lastSide.get(symbol);
    const waitStarted = state.waitSince.get(symbol);
    const waitedMs = waitStarted != null ? Date.now() - waitStarted : null;
    const afterSustainedWait = waitedMs == null || waitedMs >= 8_000;
    const isNew = (prev !== "buy" && afterSustainedWait) || prevSide !== rec.side;
    const alreadyOpen = this.openA.some(
      (t) => t.symbol === symbol && t.source === source,
    );

    state.waitSince.delete(symbol);
    if (isNew && !alreadyOpen) {
      this.openTicket({
        mode: "A",
        symbol,
        marketTicker,
        side: rec.side,
        entryAsk: rec.entryAsk,
        targetCents: rec.targetCents,
        confAtOpen: rec.confidence,
        spotAtOpen: snapshot.spot,
        strikeAtOpen: snapshot.strike,
        secondsLeftAtOpen: snapshot.secondsLeft,
        leanLabel,
        stochK: snapshot.stochK,
        atr1m: snapshot.atr1m,
        arms: source === "shipped" ? undefined : [arm],
        source,
        bookAtOpen: bookOf(snapshot),
      });
    }
    state.lastSide.set(symbol, rec.side);
    state.lastAction.set(symbol, "buy");
  }

  /**
   * Shadow: first time capped finish conf ≥ 85% before 8:00 left, any coin.
   * Hold to expiry (no 49¢ stop). Never a live order.
   */
  private handleEarly85(
    marketTicker: string,
    snapshot: MarketSnapshot,
    decision: DecisionResult,
    leanLabel: string,
  ) {
    const rec = decision.modeB;
    this.openEarly85 = this.openEarly85.filter((t) => {
      if (t.symbol !== snapshot.symbol) return true;
      this.updateExcursion(t, snapshot);
      return true;
    });

    if (snapshot.secondsLeft <= MODE_B_START_SEC) return;
    if (!rec.side) return;
    if (rec.confidence < MODE_B_HIGHLIGHT_CONF * 100 - 1e-6) return;
    if (this.early85ClaimedMarkets.has(marketTicker)) return;

    const entryAsk = rec.side === "up" ? snapshot.askUp : snapshot.askDown;
    if (!Number.isFinite(entryAsk) || entryAsk < 0.02 || entryAsk >= 0.995) {
      return;
    }

    this.early85ClaimedMarkets.add(marketTicker);
    this.openTicket({
      mode: "B",
      symbol: snapshot.symbol,
      marketTicker,
      side: rec.side,
      entryAsk,
      confAtOpen: rec.confidence,
      spotAtOpen: snapshot.spot,
      strikeAtOpen: snapshot.strike,
      secondsLeftAtOpen: snapshot.secondsLeft,
      leanLabel,
      stochK: snapshot.stochK,
      atr1m: snapshot.atr1m,
      bookAtOpen: bookOf(snapshot),
      source: "early85",
    });
    const opened = this.openEarly85[this.openEarly85.length - 1];
    if (opened) this.logEarly85("open", opened);
  }

  private handleModeB(
    marketTicker: string,
    snapshot: MarketSnapshot,
    decision: DecisionResult,
    leanLabel: string,
  ) {
    const rec = decision.modeB;
    // Hold is display-only — not a new entry for paper
    const action: "wait" | "buy" | "hold" =
      rec.action === "buy" ? "buy" : rec.action === "hold" ? "hold" : "wait";

    this.openB = this.openB.filter((t) => {
      if (t.symbol !== snapshot.symbol) return true;
      this.updateExcursion(t, snapshot);
      if (this.hitStop(t)) {
        this.settleStop(t);
        if (!isHoldPaperTicket(t)) this.modeBStoppedMarkets.add(t.marketTicker);
        return false;
      }
      return true;
    });

    if (action === "buy" && rec.side) {
      const entryAsk = rec.side === "up" ? snapshot.askUp : snapshot.askDown;
      if (snapshot.secondsLeft <= MODE_B_END_SEC) {
        return;
      }
      // One open ticket per market (legacy hold-paper still rides to settle).
      if (this.openB.some((t) => t.marketTicker === marketTicker)) return;

      // Scorecard Mode B — one live opportunity per market.
      if (!this.modeBClaimedMarkets.has(marketTicker)) {
        this.modeBClaimedMarkets.add(marketTicker);
        this.openTicket({
          mode: "B",
          symbol: snapshot.symbol,
          marketTicker,
          side: rec.side,
          entryAsk,
          confAtOpen: rec.confidence,
          spotAtOpen: snapshot.spot,
          strikeAtOpen: snapshot.strike,
          secondsLeftAtOpen: snapshot.secondsLeft,
          leanLabel,
          stochK: snapshot.stochK,
          atr1m: snapshot.atr1m,
          bookAtOpen: bookOf(snapshot),
        });
      }
    }
  }
  private openTicket(input: {
    mode: "A" | "B";
    symbol: AssetSymbol;
    marketTicker: string;
    side: Side;
    entryAsk: number;
    targetCents?: number;
    confAtOpen?: number;
    spotAtOpen: number;
    strikeAtOpen: number;
    secondsLeftAtOpen: number;
    leanLabel: string;
    stochK: number;
    atr1m: number;
    arms?: ArmId[];
    armProbs?: Partial<Record<ArmId, number>>;
    etaSecAtOpen?: number | null;
    chopScoreAtOpen?: number;
    chopArchetype?: "decay" | "fade";
    trendScoreAtOpen?: number;
    momArchetype?: "runaway" | "breakout";
    source?: PaperTicket["source"];
    bookAtOpen?: { askUp: number; bidUp: number; askDown: number; bidDown: number };
  }) {
    const ticket: PaperTicket & { protocol: number } = {
      id: `${input.mode}-${input.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      mode: input.mode,
      symbol: input.symbol,
      marketTicker: input.marketTicker,
      side: input.side,
      openedAtMs: Date.now(),
      entryAsk: snapKalshiPrice(input.entryAsk),
      targetCents: input.targetCents,
      confAtOpen: input.confAtOpen,
      spotAtOpen: input.spotAtOpen,
      strikeAtOpen: input.strikeAtOpen,
      secondsLeftAtOpen: input.secondsLeftAtOpen,
      leanLabel: input.leanLabel,
      stochK: input.stochK,
      atr1m: input.atr1m,
      mfeCents: 0,
      maeCents: 0,
      lastMarkCents: snapKalshiCents(input.entryAsk * 100),
      pathMarks: [snapKalshiCents(input.entryAsk * 100)],
      outcome: "open",
      source: input.source ?? (input.mode === "A" ? "explorer" : undefined),
      bookAtOpen: input.bookAtOpen,
      arms: input.arms,
      armProbs: input.armProbs,
      etaSecAtOpen: input.etaSecAtOpen,
      chopScoreAtOpen: input.chopScoreAtOpen,
      chopArchetype: input.chopArchetype,
      trendScoreAtOpen: input.trendScoreAtOpen,
      momArchetype: input.momArchetype,
      protocol: PAPER_PROTOCOL,
    };
    if (input.mode === "A") this.openA.push(ticket);
    else if (input.source === "early85") this.openEarly85.push(ticket);
    else this.openB.push(ticket);
    appendSignalEvent({
      type: "open",
      dayKey: dayKeyFromMs(),
      protocol: PAPER_PROTOCOL,
      ticket,
    });
  }

  private updateExcursion(ticket: PaperTicket, snapshot: MarketSnapshot) {
    const mark = markCents(ticket.side, snapshot);
    const entry = snapKalshiCents(ticket.entryAsk * 100);
    const pnl = Math.round((mark - entry) * 10) / 10;
    ticket.lastMarkCents = mark;
    ticket.mfeCents = Math.max(ticket.mfeCents, pnl);
    ticket.maeCents = Math.min(ticket.maeCents, pnl);
    this.recordPathMark(ticket, mark);
  }

  private recordPathMark(ticket: PaperTicket, mark: number) {
    if (!(mark >= 0) || mark > 100) return;
    const marks = ticket.pathMarks ?? (ticket.pathMarks = []);
    const last = marks[marks.length - 1];
    // Ignore sub-half-cent flicker — uncapped paths hit 300+ samples/window and
    // stalled settle / scorecard / exit-opt IO on the event loop.
    if (last != null && Math.abs(last - mark) < 0.5) return;
    marks.push(mark);
    const MAX = 96;
    if (marks.length <= MAX) return;
    let lo = marks[0]!;
    let hi = marks[0]!;
    for (const m of marks) {
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    const out: number[] = [marks[0]!];
    const stride = Math.ceil((marks.length - 2) / Math.max(1, MAX - 4));
    for (let i = stride; i < marks.length - 1; i += stride) {
      out.push(marks[i]!);
    }
    out.push(marks[marks.length - 1]!);
    if (!out.some((m) => Math.abs(m - lo) < 1e-6)) out.push(lo);
    if (!out.some((m) => Math.abs(m - hi) < 1e-6)) out.push(hi);
    ticket.pathMarks = out.slice(0, MAX);
  }

  private holdToExpiryCents(ticket: PaperTicket, snapshot: MarketSnapshot): number {
    const entry = snapKalshiCents(ticket.entryAsk * 100);
    const upWins = snapshot.spot >= ticket.strikeAtOpen;
    const won = ticket.side === "up" ? upWins : !upWins;
    return Math.round((won ? 100 - entry : 0 - entry) * 10) / 10;
  }

  /** Keep recording marks after paper flatten until the market determines. */
  private beginPathFollow(ticket: PaperTicket) {
    if (ticket.pathComplete) return;
    if (this.pathFollow.some((t) => t.id === ticket.id)) return;
    this.pathFollow.push(ticket);
  }

  private advancePathFollow(
    symbol: AssetSymbol,
    marketTicker: string,
    snapshot: MarketSnapshot,
  ) {
    this.pathFollow = this.pathFollow.filter((t) => {
      if (t.symbol !== symbol) return true;
      if (t.marketTicker !== marketTicker) {
        this.completePath(t, snapshot);
        return false;
      }
      this.updateExcursion(t, snapshot);
      if (snapshot.secondsLeft <= MODE_B_END_SEC) {
        this.completePath(t, snapshot);
        return false;
      }
      return true;
    });
  }

  private completePath(ticket: PaperTicket, snapshot: MarketSnapshot) {
    this.updateExcursion(ticket, snapshot);
    const entry = snapKalshiCents(ticket.entryAsk * 100);
    if ((ticket.maeCents ?? 0) < -0.05) {
      this.recordPathMark(ticket, snapKalshiCents(entry + ticket.maeCents));
    }
    if ((ticket.mfeCents ?? 0) > 0.05) {
      this.recordPathMark(ticket, snapKalshiCents(entry + ticket.mfeCents));
    }
    ticket.holdPnlCents = this.holdToExpiryCents(ticket, snapshot);
    ticket.pathComplete = true;
    appendSignalEvent({
      type: "path",
      dayKey: dayKeyFromMs(),
      protocol: PAPER_PROTOCOL,
      ticket,
    });
    // Same object is usually already in the settled cache; upsert so Rec sees
    // holdPnl + full path even if the settle row was a copy.
    this.rememberSettled(ticket);
  }

  private hitStop(ticket: PaperTicket): boolean {
    const stop = stopMarkCents(ticket.entryAsk, ticket.mode);
    if (stop == null) return false;
    // Deci-cent books: treat mark ≤ stop (within 0.05¢) as stopped.
    return ticket.lastMarkCents <= stop + 1e-6;
  }

  private settleStop(ticket: PaperTicket) {
    const entry = snapKalshiCents(ticket.entryAsk * 100);
    const stop = stopMarkCents(ticket.entryAsk, ticket.mode);
    if (stop == null) return;
    ticket.lastMarkCents = stop;
    ticket.outcome = ticket.mode === "A" ? "miss" : "loss";
    ticket.pnlCents = Math.round((stop - entry) * 10) / 10;
    ticket.settleReason = "stop_loss";
    ticket.settledAtMs = Date.now();
    appendSignalEvent({
      type: "settle",
      dayKey: dayKeyFromMs(),
      protocol: ticketProtocol(ticket),
      ticket,
    });
    this.rememberSettled(ticket);
    this.beginPathFollow(ticket);
  }

  private settleA(ticket: PaperTicket, snapshot: MarketSnapshot, reason: string) {
    this.updateExcursion(ticket, snapshot);
    if (this.hitStop(ticket)) {
      this.settleStop(ticket);
      this.noteDisplayedModeAStop(ticket);
      return;
    }
    const entry = snapKalshiCents(ticket.entryAsk * 100);
    const target = ticket.targetCents ?? 0;
    if (ticket.mfeCents >= target) {
      ticket.outcome = "hit";
      ticket.pnlCents = target;
      ticket.settleReason = "delta_achieved";
      ticket.settledAtMs = Date.now();
      appendSignalEvent({
        type: "settle",
        dayKey: dayKeyFromMs(),
        protocol: ticketProtocol(ticket),
        ticket,
      });
      this.rememberSettled(ticket);
      this.beginPathFollow(ticket);
      return;
    }
    ticket.outcome = "miss";
    ticket.pnlCents = Math.round((ticket.lastMarkCents - entry) * 10) / 10;
    ticket.settleReason = reason;
    ticket.holdPnlCents = this.holdToExpiryCents(ticket, snapshot);
    ticket.pathComplete = true;
    ticket.settledAtMs = Date.now();
    appendSignalEvent({
      type: "settle",
      dayKey: dayKeyFromMs(),
      protocol: ticketProtocol(ticket),
      ticket,
    });
    this.rememberSettled(ticket);
  }

  /** Grade early-85% vs strike at open. No stop — that is the counterfactual. */
  private settleEarly85(
    ticket: PaperTicket,
    snapshot: MarketSnapshot,
    reason: string,
  ) {
    this.updateExcursion(ticket, snapshot);
    const entry = snapKalshiCents(ticket.entryAsk * 100);
    const upWins = snapshot.spot >= ticket.strikeAtOpen;
    const won = ticket.side === "up" ? upWins : !upWins;
    ticket.outcome = won ? "win" : "loss";
    ticket.pnlCents = Math.round((won ? 100 - entry : 0 - entry) * 10) / 10;
    ticket.holdPnlCents = ticket.pnlCents;
    ticket.pathComplete = true;
    ticket.settledAtMs = Date.now();
    ticket.settleReason = reason;
    appendSignalEvent({
      type: "settle",
      dayKey: dayKeyFromMs(),
      protocol: ticketProtocol(ticket),
      ticket,
    });
    this.rememberSettled(ticket);
    this.logEarly85("settle", ticket);
  }

  private logEarly85(type: "open" | "settle", ticket: PaperTicket) {
    const settled = this.getSettledCached().filter(isEarly85Ticket);
    const allWins = settled.filter((t) => t.outcome === "win").length;
    const allPnlCents = settled.reduce((s, t) => s + (t.pnlCents ?? 0), 0);
    appendEarly85Log({
      type,
      ticket,
      allWins,
      allSettled: settled.length,
      allPnlCents: Math.round(allPnlCents * 10) / 10,
      openNow: this.openEarly85.length,
    });
  }

  private settleB(ticket: PaperTicket, snapshot: MarketSnapshot, reason: string) {
    this.updateExcursion(ticket, snapshot);
    if (this.hitStop(ticket)) {
      this.settleStop(ticket);
      this.modeBStoppedMarkets.add(ticket.marketTicker);
      return;
    }
    const entry = snapKalshiCents(ticket.entryAsk * 100);
    // Grade vs the strike locked at recommendation time (not the next window's strike)
    const upWins = snapshot.spot >= ticket.strikeAtOpen;
    const won = ticket.side === "up" ? upWins : !upWins;
    ticket.outcome = won ? "win" : "loss";
    ticket.pnlCents = Math.round((won ? 100 - entry : 0 - entry) * 10) / 10;
    ticket.holdPnlCents = ticket.pnlCents;
    ticket.pathComplete = true;
    ticket.settledAtMs = Date.now();
    ticket.settleReason = reason;
    appendSignalEvent({
      type: "settle",
      dayKey: dayKeyFromMs(),
      protocol: ticketProtocol(ticket),
      ticket,
    });
    this.rememberSettled(ticket);
  }

  /** Persist open tickets; throttle routine writes so we don't block the event loop. */
  private persistOpen(force = false) {
    this.persistOpenDirty = true;
    const now = Date.now();
    if (!force && now - this.lastPersistOpenMs < 2_000) return;
    this.lastPersistOpenMs = now;
    this.persistOpenDirty = false;
    saveOpenTickets([...this.openA, ...this.openB, ...this.openEarly85, ...this.pathFollow]);
  }
}
