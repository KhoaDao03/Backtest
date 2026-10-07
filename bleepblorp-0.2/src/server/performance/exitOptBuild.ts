/**
 * SL/TP optimizer helper — Rec sample = scorecard All window for each strategy
 * (same era reset as the board). Runs out-of-process so the live feed never
 * executes the grid search.
 *
 * After each path-complete market end:
 * 1. Load the full scorecard-era journal (entry→expiry marks past live stops).
 * 2. Search every SL×TP combo per coin and for All.
 * 3. Rec PnL = latest recommended pair replayed on that entire history.
 */
import type { ExitOptimization, PaperTicket } from "@/lib/performanceTypes";
import {
  buildExitOptimization,
  buildReplayCoverage,
  emptyExitOptimization,
} from "@/server/performance/exitOptimizer";
import { loadAllSettled } from "@/server/performance/journal";
import { isEpochVoidedTicket } from "@/server/performance/scorecardExclude";
import { existsSync, readFileSync } from "fs";
import path from "path";

/** Keep in sync with tracker.ts PAPER_PROTOCOL / MODE_B_LINEAGE_MIN. */
const PAPER_PROTOCOL = 37;
const MODE_B_LINEAGE_MIN = 37;

function ticketProtocol(t: PaperTicket): number {
  return (t as PaperTicket & { protocol?: number }).protocol ?? 0;
}

/** Same era cut as the scorecard All column. */
function isCurrentEra(t: PaperTicket): boolean {
  const p = ticketProtocol(t);
  return t.mode === "B" ? p >= MODE_B_LINEAGE_MIN : p === PAPER_PROTOCOL;
}

function isMomTicket(t: PaperTicket): boolean {
  return t.mode === "A" && t.source === "mom";
}

function isRevTicket(t: PaperTicket): boolean {
  return t.mode === "A" && t.source === "rev";
}

function isExcludedSource(t: PaperTicket): boolean {
  const src = t.source as string | undefined;
  return (
    src === "early85" ||
    src === "hold-paper" ||
    src === "hold-mom" ||
    src === "hold-rev"
  );
}

function isDecided(t: PaperTicket): boolean {
  return (
    t.outcome === "hit" ||
    t.outcome === "win" ||
    t.outcome === "miss" ||
    t.outcome === "loss"
  );
}

/**
 * Scorecard All sample for Rec — current era only (protocol reset), same
 * exclusions as getScorecard(). No prior-protocol fills.
 */
export function collectScorecardEraTickets(all: PaperTicket[]): PaperTicket[] {
  return all.filter(
    (t) =>
      isDecided(t) &&
      isCurrentEra(t) &&
      !isExcludedSource(t) &&
      !isEpochVoidedTicket(t),
  );
}

export function loadAllSettledFromDir(logDir: string): PaperTicket[] {
  const signalLog = path.join(logDir, "signals.jsonl");
  if (!existsSync(signalLog)) return [];
  const out: PaperTicket[] = [];
  const idx = new Map<string, number>();
  for (const line of readFileSync(signalLog, "utf8").split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(line) as { type?: string; ticket?: PaperTicket };
      if (!row.ticket) continue;
      if (row.type === "settle") {
        const id = row.ticket.id;
        const existing = idx.get(id);
        if (existing != null) out[existing] = row.ticket;
        else {
          idx.set(id, out.length);
          out.push(row.ticket);
        }
      } else if (row.type === "path") {
        const i = idx.get(row.ticket.id);
        if (i == null) continue;
        const cur = out[i]!;
        out[i] = {
          ...cur,
          maeCents: row.ticket.maeCents ?? cur.maeCents,
          mfeCents: row.ticket.mfeCents ?? cur.mfeCents,
          holdPnlCents: row.ticket.holdPnlCents ?? cur.holdPnlCents,
          pathComplete: row.ticket.pathComplete ?? cur.pathComplete,
          pathMarks: row.ticket.pathMarks ?? cur.pathMarks,
        };
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export function buildPaperAllHistoryExitOpt(logDir?: string): {
  exitOpt: ExitOptimization;
  fillCloseN: number;
  pathCompleteN: number;
  gapN: number;
} {
  const allSettled =
    !logDir || logDir === path.join(process.cwd(), "logs")
      ? loadAllSettled({ pathMarks: true })
      : loadAllSettledFromDir(logDir);
  const settled = collectScorecardEraTickets(allSettled);
  const modeB = settled.filter((t) => t.mode === "B");
  const modeAMom = settled.filter(isMomTicket);
  const modeARev = settled.filter(isRevTicket);
  const coverage = buildReplayCoverage(modeB);
  const opts = {
    liveOnly: true,
    minSamples: 1,
    minReady: 12,
    replayComplete: true,
    excludedN: 0,
  } as const;

  if (settled.length === 0) {
    return {
      fillCloseN: 0,
      pathCompleteN: 0,
      gapN: 0,
      exitOpt: {
        ...emptyExitOptimization("SL/TP collecting scorecard-era samples"),
        coverage,
      },
    };
  }

  const all = buildExitOptimization({
    currentSettled: settled,
    historicalSettled: [],
    options: opts,
  });
  const mom = buildExitOptimization({
    currentSettled: modeAMom,
    historicalSettled: [],
    options: opts,
  });
  const rev = buildExitOptimization({
    currentSettled: modeARev,
    historicalSettled: [],
    options: opts,
  });

  const note =
    `Rec = latest SL/TP on complete scorecard All · Mid-Market (mom) n=${modeAMom.length} · EOM n=${modeB.length}` +
    (coverage.replayReadyN > 0
      ? ` · path-ready ${coverage.replayReadyN}/${modeB.length}`
      : "");

  return {
    fillCloseN: settled.length,
    pathCompleteN: coverage.replayReadyN,
    gapN: coverage.gapN,
    exitOpt: {
      ...all,
      modeA: mom.modeA,
      modeAMom: mom.modeA,
      modeARev: rev.modeA,
      coverage,
      note,
    },
  };
}
