/**
 * Per-arm shadow cuts on live fills. These do not open tickets or change entries.
 *
 * Each arm has its own three isolated cuts plus the stack. Scoring is a filter
 * and/or a stop replay on the parent arm's existing paper path.
 *
 * "wait 10:00" is a filter on when the live arm actually filled, not a delayed
 * re-entry. If the live arm fired at 14:00, that row does not invent a 10:00
 * fill at a different price.
 */
import { snapKalshiCents } from "./math";
import { ARM_IDS, type ArmId } from "./types";
import type { ModeScorecard, PaperTicket } from "./performanceTypes";

export const VARIANT_LATE_MAX_SEC = 600;

export interface ArmVariantDef {
  id: string;
  label: string;
  blurb: string;
  qualifies: (t: PaperTicket) => boolean;
  /** If set, replay PnL at this % of entry instead of the live 50% stop. */
  stopAtEntryPct?: number;
}

export function ticketLeanIsMomentum(t: PaperTicket): boolean {
  return (t.leanLabel ?? "").includes("Momentum continuation");
}

export function ticketIsLateEntry(t: PaperTicket): boolean {
  return (t.secondsLeftAtOpen || 0) <= VARIANT_LATE_MAX_SEC;
}

export function ticketIsTp20(t: PaperTicket): boolean {
  return t.targetCents === 20;
}

/** Matches proto13 `ask > maxAsk` wait: 50.00¢ is kept, 50.1¢+ is dropped. */
export function ticketAskAtMost50(t: PaperTicket): boolean {
  return t.entryAsk * 100 <= 50 + 1e-6;
}

/** Matches proto13 cutoffSec=300: no new entries at 5:00 or less. */
export function ticketCutoff5Min(t: PaperTicket): boolean {
  return (t.secondsLeftAtOpen || 0) > 300;
}

const INDICATORS_CUTS: ArmVariantDef[] = [
  {
    id: "base",
    label: "",
    blurb: "Live arm, unchanged.",
    qualifies: () => true,
  },
  {
    id: "stop70",
    label: "+70% SL",
    blurb:
      "Same fills, replayed with a tighter stop: exit when the mark hits 70% of entry instead of 50%. Hit rate falls; losses shrink. If the path tagged both the stop and the target, the stop counts (conservative).",
    qualifies: () => true,
    stopAtEntryPct: 70,
  },
  {
    id: "mom",
    label: "+momentum",
    blurb:
      "Same fills, keeping only tickets whose stored lean was Momentum continuation. Mean-reversion and “no clear lean” are dropped. Does not open replacement trades.",
    qualifies: ticketLeanIsMomentum,
  },
  {
    id: "late",
    label: "+wait 10:00",
    blurb:
      "Same fills that already opened with ≤10:00 left. Does not wait on an early live fill and re-enter later at a different price.",
    qualifies: ticketIsLateEntry,
  },
  {
    id: "top3",
    label: "+top 3",
    blurb:
      "Momentum continuation, ≤10:00 left at open, and the 70% stop — the three Indicators cuts stacked.",
    qualifies: (t) => ticketLeanIsMomentum(t) && ticketIsLateEntry(t),
    stopAtEntryPct: 70,
  },
];

const STRIPPED_CUTS: ArmVariantDef[] = [
  {
    id: "base",
    label: "",
    blurb: "Live arm, unchanged.",
    qualifies: () => true,
  },
  {
    id: "stop75",
    label: "+75% SL",
    blurb:
      "Same fills, replayed with a tighter stop: exit when the mark hits 75% of entry instead of 50%. Stripped's average miss is ~32¢ because it sits richer than Indicators; a 50% stop on an 80¢ fill risks 40¢ to make 10–20¢. If the path tagged both the stop and the target, the stop counts (conservative).",
    qualifies: () => true,
    stopAtEntryPct: 75,
  },
  {
    id: "tp20",
    label: "+20¢ only",
    blurb:
      "Same fills, keeping only tickets whose target was +20¢. +10 and +15 are the consolation rungs — Stripped already failed 68% on +20 — and they lose ~2.3–2.8¢ each.",
    qualifies: ticketIsTp20,
  },
  {
    id: "late",
    label: "+wait 10:00",
    blurb:
      "Same fills that already opened with ≤10:00 left. The first five minutes of the window are where Stripped's 50% stop gets run over. Does not invent a later fill if the live arm fired early.",
    qualifies: ticketIsLateEntry,
  },
  {
    id: "top3",
    label: "+top 3",
    blurb:
      "+20¢ target, ≤10:00 left at open, and the 75% stop — the three Stripped cuts stacked.",
    qualifies: (t) => ticketIsTp20(t) && ticketIsLateEntry(t),
    stopAtEntryPct: 75,
  },
];

const CONTROL_CUTS: ArmVariantDef[] = [
  {
    id: "base",
    label: "",
    blurb: "Live arm, unchanged.",
    qualifies: () => true,
  },
  {
    id: "stop75",
    label: "+75% SL",
    blurb:
      "Same fills, replayed with a tighter stop: exit when the mark hits 75% of entry instead of 50%. 0.1's average miss is ~23¢ on a ~48¢ fill — more than a +10¢ target can pay. If the path tagged both the stop and the target, the stop counts (conservative).",
    qualifies: () => true,
    stopAtEntryPct: 75,
  },
  {
    id: "max50",
    label: "+max 50¢",
    blurb:
      "Same fills, dropping asks above 50¢. The live 50–55¢ slice is 52% and −6.6¢, and it lost every Pacific day. Original 0.1 allowed up to 55¢; this row tests lowering that ceiling.",
    qualifies: ticketAskAtMost50,
  },
  {
    id: "cutoff5",
    label: "+cutoff 5:00",
    blurb:
      "Same fills that already opened with more than 5:00 left. Live 0.1 keeps entering down to 3:00; the 3–5m bucket is −4.9¢. This is an earlier cutoff, not a late-entry wait.",
    qualifies: ticketCutoff5Min,
  },
  {
    id: "top3",
    label: "+top 3",
    blurb:
      "Ask ≤50¢, more than 5:00 left at open, and the 75% stop — the three 0.1 Control cuts stacked.",
    qualifies: (t) => ticketAskAtMost50(t) && ticketCutoff5Min(t),
    stopAtEntryPct: 75,
  },
];

const WIDE_CUTS: ArmVariantDef[] = [
  {
    id: "base",
    label: "",
    blurb: "Live arm, unchanged.",
    qualifies: () => true,
  },
  {
    id: "stop75",
    label: "+75% SL",
    blurb:
      "Same fills, replayed with a tighter stop: exit when the mark hits 75% of entry instead of 50%. Wide's average miss is ~26¢ against an ~12¢ win — the 50% stop on 75–85¢ fills is the aperture experiment eating itself. If the path tagged both the stop and the target, the stop counts (conservative).",
    qualifies: () => true,
    stopAtEntryPct: 75,
  },
  {
    id: "tp20",
    label: "+20¢ only",
    blurb:
      "Same fills, keeping only tickets whose target was +20¢. Wide's 60% bar lets +10 fire constantly (1,239 of 1,825 fills, −1.71¢). +20 is the only green target rung on live paper, and forcing it on the path recorder is the selection cut that actually flips Wide green once the stop is tightened.",
    qualifies: ticketIsTp20,
  },
  {
    id: "late",
    label: "+wait 10:00",
    blurb:
      "Same fills that already opened with ≤10:00 left. The first five minutes are −1.75¢ on 1,049 tickets. Unlike Control, waiting here is additive with +20 and the 75% stop on the tick paths. Does not invent a later fill if the live arm fired early.",
    qualifies: ticketIsLateEntry,
  },
  {
    id: "top3",
    label: "+top 3",
    blurb:
      "+20¢ target, ≤10:00 left at open, and the 75% stop — the three 0.1 Wide cuts stacked.",
    qualifies: (t) => ticketIsTp20(t) && ticketIsLateEntry(t),
    stopAtEntryPct: 75,
  },
];

/**
 * Shadow rows under each live arm. Each of S / I / C / P has its own cuts.
 */
export const ARM_VARIANT_DEFS: Record<ArmId, ArmVariantDef[]> = {
  S: STRIPPED_CUTS,
  I: INDICATORS_CUTS,
  C: CONTROL_CUTS,
  P: WIDE_CUTS,
};

export function variantDef(arm: ArmId, id: string): ArmVariantDef | undefined {
  return ARM_VARIANT_DEFS[arm].find((d) => d.id === id);
}

export function emptyModeScorecard(): ModeScorecard {
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

export function emptyArmVariantScorecards(): Record<ArmId, Record<string, ModeScorecard>> {
  return Object.fromEntries(
    ARM_IDS.map((arm) => [
      arm,
      Object.fromEntries(
        ARM_VARIANT_DEFS[arm].map((d) => [d.id, emptyModeScorecard()]),
      ),
    ]),
  ) as Record<ArmId, Record<string, ModeScorecard>>;
}

export function replayStopPnl(
  t: PaperTicket,
  stopAtEntryPct: number,
): { hitStop: boolean; hitTp: boolean; pnl: number } {
  const entry = snapKalshiCents(t.entryAsk * 100);
  const stopMark = snapKalshiCents((entry * stopAtEntryPct) / 100);
  const stopLoss = Math.round((entry - stopMark) * 10) / 10;
  const mae = t.maeCents ?? 0;
  const mfe = t.mfeCents ?? 0;
  const hitStop = mae <= -stopLoss + 1e-6;
  const target = t.targetCents ?? 0;
  const hitTp = target > 0 && mfe >= target;
  if (hitStop) return { hitStop: true, hitTp, pnl: -stopLoss };
  if (hitTp) return { hitStop: false, hitTp: true, pnl: target };
  return { hitStop: false, hitTp: false, pnl: t.pnlCents ?? 0 };
}

function liveIsDecided(t: PaperTicket): boolean {
  return (
    t.outcome === "hit" ||
    t.outcome === "win" ||
    t.outcome === "miss" ||
    t.outcome === "loss"
  );
}

function applyDecided(s: ModeScorecard, hit: boolean, pnl: number) {
  s.settled += 1;
  if (hit) s.hitsOrWins += 1;
  else s.missesOrLosses += 1;
  s.sumPnlCents += pnl;
}

function finalize(s: ModeScorecard, openNow: number): ModeScorecard {
  s.openNow = openNow;
  const decided = s.hitsOrWins + s.missesOrLosses;
  s.opens = s.settled + s.voids + openNow;
  s.hitRate = decided > 0 ? s.hitsOrWins / decided : null;
  s.expectancyCents = decided > 0 ? s.sumPnlCents / decided : null;
  return s;
}

export function scoreArmVariant(args: {
  tickets: PaperTicket[];
  open: PaperTicket[];
  includeOpen: boolean;
  def: ArmVariantDef;
}): ModeScorecard {
  const { tickets, open, includeOpen, def } = args;
  const s = emptyModeScorecard();
  let openNow = 0;
  const altStop = def.stopAtEntryPct;

  for (const t of tickets) {
    if (t.mode !== "A" || t.outcome === "open") continue;
    if (!def.qualifies(t)) continue;
    if (t.outcome === "void") {
      s.voids += 1;
      continue;
    }
    if (!liveIsDecided(t)) continue;
    if (altStop != null) {
      const r = replayStopPnl(t, altStop);
      if (r.hitStop) applyDecided(s, false, r.pnl);
      else if (r.hitTp) applyDecided(s, true, r.pnl);
      else
        applyDecided(
          s,
          t.outcome === "hit" || t.outcome === "win",
          r.pnl,
        );
    } else {
      applyDecided(
        s,
        t.outcome === "hit" || t.outcome === "win",
        t.pnlCents ?? 0,
      );
    }
  }

  for (const t of open) {
    if (t.mode !== "A" || t.outcome !== "open") continue;
    if (!def.qualifies(t)) continue;
    if (altStop != null) {
      const r = replayStopPnl(t, altStop);
      if (r.hitStop || r.hitTp) {
        applyDecided(s, r.hitTp && !r.hitStop, r.pnl);
        continue;
      }
    }
    if (includeOpen) openNow += 1;
  }

  return finalize(s, includeOpen ? openNow : 0);
}
