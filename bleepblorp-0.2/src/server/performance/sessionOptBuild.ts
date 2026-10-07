/**
 * Weekly session sit-out report (15m slots, America/Los_Angeles).
 * Same algorithm as sevenstreams 0.1 — applied per paper lane:
 * Mid-Market (mom) and End-of-Market (Mode B), using the scorecard All sample.
 *
 * Each close is one observation (per-contract PnL). Stats cover all 7×96 slots.
 * Recommendations search the full week and mix day-specific windows with
 * Weekdays/Weekend pooled same-clock patterns.
 * Weekday session = Sun 6:00pm–Fri 5:00pm PT.
 * Recommend-only — does not change live entry logic.
 */
import {
  scorecardPnlCents,
  type PaperTicket,
} from "@/lib/performanceTypes";
import type {
  SessionOptHistoryRecord,
  SessionOptLane,
  SessionOptRange,
  SessionOptSlot,
  SessionOptSummary,
} from "@/lib/sessionOptTypes";
import {
  SESSION_OPT_CACHE_VERSION,
  type SessionOptCacheFile,
} from "@/server/performance/sessionOptStore";
import { collectScorecardEraTickets } from "@/server/performance/exitOptBuild";
import { loadAllSettled } from "@/server/performance/journal";

export const SESSION_OPT_MIN_N = 8;
export const SESSION_OPT_SLOTS_PER_DAY = 96;
export const SESSION_OPT_WEEK_SLOTS = 7 * SESSION_OPT_SLOTS_PER_DAY; /* 672 */

/** Friday 5:00pm PT = first weekend slot (weekdays end here). */
export const WEEKDAY_END_SLOT_FRI = 68; /* 17:00 */
/** Sunday 6:00pm PT = first weekday-session slot after the weekend. */
export const WEEKDAY_START_SLOT_SUN = 72; /* 18:00 */

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Same Mid-Market row as the scorecard (momentum only, current protocol). */
function isMidTicket(t: PaperTicket): boolean {
  return t.mode === "A" && t.source === "mom";
}

/** Same End-of-Market row as the scorecard (Mode B, era + shadow exclusions). */
function isEomTicket(t: PaperTicket): boolean {
  return t.mode === "B";
}

function closeAtMs(t: PaperTicket): number {
  return t.settledAtMs ?? t.openedAtMs ?? 0;
}

function ptParts(atMs: number): { weekday: number; slot: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(atMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const wdMap: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const weekday = wdMap[get("weekday")] ?? 0;
  const hour = Number(get("hour")) || 0;
  const minute = Number(get("minute")) || 0;
  const slot = Math.min(
    SESSION_OPT_SLOTS_PER_DAY - 1,
    Math.floor((hour * 60 + minute) / 15),
  );
  return { weekday, slot };
}

/** Mon=0…Sun=6 → Sunday-first week index 0…671. */
export function toSunWeekIndex(weekdayMon0: number, slot: number): number {
  const wdSun0 = (weekdayMon0 + 1) % 7;
  return wdSun0 * SESSION_OPT_SLOTS_PER_DAY + slot;
}

export function fromSunWeekIndex(index: number): {
  weekday: number;
  slot: number;
} {
  const i =
    ((index % SESSION_OPT_WEEK_SLOTS) + SESSION_OPT_WEEK_SLOTS) %
    SESSION_OPT_WEEK_SLOTS;
  const wdSun0 = Math.floor(i / SESSION_OPT_SLOTS_PER_DAY);
  const slot = i % SESSION_OPT_SLOTS_PER_DAY;
  const weekday = (wdSun0 + 6) % 7;
  return { weekday, slot };
}

/**
 * Weekday session: Sunday 6:00pm PT through Friday 5:00pm PT (exclusive of Fri 5pm).
 * Weekend session: Friday 5:00pm PT through Sunday 6:00pm PT (exclusive of Sun 6pm).
 */
export function isWeekdaySession(weekdayMon0: number, slot: number): boolean {
  if (weekdayMon0 === 6) return slot >= WEEKDAY_START_SLOT_SUN;
  if (weekdayMon0 >= 0 && weekdayMon0 <= 3) return true;
  if (weekdayMon0 === 4) return slot < WEEKDAY_END_SLOT_FRI;
  return false;
}

function fmtSlotClock(slot: number): string {
  const mins = slot * 15;
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const am = h24 < 12;
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const suffix = am ? "am" : "pm";
  if (m === 0) return `${h12}${suffix}`;
  return `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function fmtWeeklyWindowLabel(startSunIndex: number, slotCount: number): string {
  const start = fromSunWeekIndex(startSunIndex);
  const end = fromSunWeekIndex(startSunIndex + slotCount); // exclusive
  const startClock = fmtSlotClock(start.slot);
  const endClock = fmtSlotClock(end.slot);
  if (start.weekday === end.weekday && slotCount <= SESSION_OPT_SLOTS_PER_DAY) {
    const startIdxInDay = start.slot;
    if (startIdxInDay + slotCount <= SESSION_OPT_SLOTS_PER_DAY) {
      return `${DAY_NAMES[start.weekday]} ${startClock}–${endClock}`;
    }
  }
  if (start.weekday === end.weekday && slotCount < SESSION_OPT_SLOTS_PER_DAY) {
    return `${DAY_NAMES[start.weekday]} ${startClock}–${endClock}`;
  }
  return `${DAY_NAMES[start.weekday]} ${startClock}–${DAY_NAMES[end.weekday]} ${endClock}`;
}

function weekdaysTouched(startSunIndex: number, slotCount: number): number[] {
  const set = new Set<number>();
  for (let i = 0; i < slotCount; i++) {
    set.add(fromSunWeekIndex(startSunIndex + i).weekday);
  }
  return [...set].sort((a, b) => a - b);
}

function fmtClockRange(startSlot: number, endEx: number): string {
  return `${fmtSlotClock(startSlot)}–${fmtSlotClock(endEx % SESSION_OPT_SLOTS_PER_DAY)}`;
}

type SitKind = "day" | "weekdays" | "weekend";

type SitCand = SessionOptRange & {
  avgCents: number;
  occupied: number[];
  kind: SitKind;
};

function occupancyOverlap(a: number[], b: number[]): boolean {
  const hit = new Set(a);
  for (const x of b) if (hit.has(x)) return true;
  return false;
}

function dayOccupancy(startSunIndex: number, slotCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < slotCount; i++) {
    out.push((startSunIndex + i) % SESSION_OPT_WEEK_SLOTS);
  }
  return out;
}

function sessionClockOccupancy(
  startSlot: number,
  endEx: number,
  session: "weekdays" | "weekend",
): number[] {
  const out: number[] = [];
  const wantWeekday = session === "weekdays";
  for (let wd = 0; wd < 7; wd++) {
    for (let slot = startSlot; slot < endEx; slot++) {
      if (isWeekdaySession(wd, slot) === wantWeekday) {
        out.push(toSunWeekIndex(wd, slot));
      }
    }
  }
  return out;
}

function sumSlots(
  slotsByMon: SessionOptSlot[],
  pred: (s: SessionOptSlot) => boolean,
): { sum: number; n: number; weekdays: number[] } {
  let sum = 0;
  let n = 0;
  const wds = new Set<number>();
  for (const s of slotsByMon) {
    if (!pred(s)) continue;
    sum += s.pnlCents;
    n += s.n;
    if (s.n > 0) wds.add(s.weekday);
  }
  return { sum, n, weekdays: [...wds].sort((a, b) => a - b) };
}

/** Day-specific contiguous windows on the circular week. */
function daySpecificCandidates(slotsByMon: SessionOptSlot[]): SitCand[] {
  const pnlAt = new Array<number>(SESSION_OPT_WEEK_SLOTS).fill(0);
  const nAt = new Array<number>(SESSION_OPT_WEEK_SLOTS).fill(0);
  for (const s of slotsByMon) {
    const idx = toSunWeekIndex(s.weekday, s.slot);
    pnlAt[idx] = s.pnlCents;
    nAt[idx] = s.n;
  }
  const pnl2 = [...pnlAt, ...pnlAt];
  const n2 = [...nAt, ...nAt];
  const prefixPnl = [0];
  const prefixN = [0];
  for (let i = 0; i < pnl2.length; i++) {
    prefixPnl.push(prefixPnl[i]! + (pnl2[i] ?? 0));
    prefixN.push(prefixN[i]! + (n2[i] ?? 0));
  }

  const minSlots = 5;
  const maxSlots = 32;
  const cands: SitCand[] = [];
  for (let start = 0; start < SESSION_OPT_WEEK_SLOTS; start++) {
    for (let len = minSlots; len <= maxSlots; len++) {
      const end = start + len;
      const sum = prefixPnl[end]! - prefixPnl[start]!;
      const n = prefixN[end]! - prefixN[start]!;
      if (n < SESSION_OPT_MIN_N) continue;
      const avg = sum / n;
      if (!(avg < 0)) continue;
      const startParts = fromSunWeekIndex(start);
      cands.push({
        label: fmtWeeklyWindowLabel(start, len),
        pnlCents: Math.round(avg * 10) / 10,
        n,
        weekdays: weekdaysTouched(start, len),
        startSlot: startParts.slot,
        endSlotExclusive:
          startParts.slot + len <= SESSION_OPT_SLOTS_PER_DAY
            ? startParts.slot + len
            : SESSION_OPT_SLOTS_PER_DAY,
        startSunIndex: start,
        slotCount: len,
        kind: "day",
        avgCents: avg,
        occupied: dayOccupancy(start, len),
      });
    }
  }
  return cands;
}

/**
 * Same clock-of-day window pooled across the weekday or weekend session.
 * e.g. Weekdays 5pm–9pm, Weekend 1am–4am.
 */
function pooledSessionCandidates(
  slotsByMon: SessionOptSlot[],
  session: "weekdays" | "weekend",
): SitCand[] {
  const minSlots = 5;
  const maxSlots = 32;
  const cands: SitCand[] = [];
  const labelPrefix = session === "weekdays" ? "Weekdays" : "Weekend";
  const wantWeekday = session === "weekdays";

  for (let start = 0; start < SESSION_OPT_SLOTS_PER_DAY; start++) {
    for (
      let end = start + minSlots;
      end <= Math.min(start + maxSlots, SESSION_OPT_SLOTS_PER_DAY);
      end++
    ) {
      const { sum, n, weekdays } = sumSlots(slotsByMon, (s) => {
        if (s.slot < start || s.slot >= end) return false;
        return isWeekdaySession(s.weekday, s.slot) === wantWeekday;
      });
      if (n < SESSION_OPT_MIN_N) continue;
      // Need the pattern on more than one calendar day to call it Weekdays/Weekend.
      if (weekdays.length < 2) continue;
      const avg = sum / n;
      if (!(avg < 0)) continue;
      cands.push({
        label: `${labelPrefix} ${fmtClockRange(start, end)}`,
        pnlCents: Math.round(avg * 10) / 10,
        n,
        weekdays,
        startSlot: start,
        endSlotExclusive: end,
        kind: session,
        avgCents: avg,
        occupied: sessionClockOccupancy(start, end, session),
      });
    }
  }
  return cands;
}

/**
 * Mix day-specific windows with Weekdays/Weekend pooled clock patterns.
 * Prefer pooled multi-day patterns first, then fill with single-day sits.
 */
function bestSitWindows(
  slotsByMon: SessionOptSlot[],
  count = 4,
): SessionOptRange[] {
  const dayCands = daySpecificCandidates(slotsByMon);
  const pooledCands = [
    ...pooledSessionCandidates(slotsByMon, "weekdays"),
    ...pooledSessionCandidates(slotsByMon, "weekend"),
  ];

  const byWorst = (a: SitCand, b: SitCand) =>
    a.avgCents - b.avgCents || b.n - a.n;

  pooledCands.sort(byWorst);
  dayCands.sort(byWorst);

  const picked: SitCand[] = [];
  const maxPooled = Math.min(2, count);

  for (const c of pooledCands) {
    if (picked.some((p) => occupancyOverlap(p.occupied, c.occupied))) continue;
    picked.push(c);
    if (picked.length >= maxPooled) break;
  }

  for (const c of dayCands) {
    if (picked.length >= count) break;
    if (picked.some((p) => occupancyOverlap(p.occupied, c.occupied))) continue;
    picked.push(c);
  }

  picked.sort((a, b) => {
    const aKey =
      a.kind === "day"
        ? (a.startSunIndex ?? 0)
        : a.startSlot + (a.kind === "weekend" ? 1000 : 0);
    const bKey =
      b.kind === "day"
        ? (b.startSunIndex ?? 0)
        : b.startSlot + (b.kind === "weekend" ? 1000 : 0);
    return aKey - bKey;
  });

  return picked.map((c) => ({
    label: c.label,
    pnlCents: c.pnlCents,
    n: c.n,
    weekdays: c.weekdays,
    startSlot: c.startSlot,
    endSlotExclusive: c.endSlotExclusive,
    startSunIndex: c.startSunIndex,
    slotCount: c.slotCount,
    kind: c.kind,
  }));
}

function buildSitOccupied(ranges: SessionOptRange[]): Set<number> {
  const sit = new Set<number>();
  for (const r of ranges) {
    let occ: number[] = [];
    if (r.kind === "weekdays" || r.kind === "weekend") {
      occ = sessionClockOccupancy(r.startSlot, r.endSlotExclusive, r.kind);
    } else if (r.startSunIndex != null && r.slotCount != null) {
      occ = dayOccupancy(r.startSunIndex, r.slotCount);
    }
    for (const idx of occ) sit.add(idx);
  }
  return sit;
}

function buildSitOutSummary(ranges: SessionOptRange[]): string {
  if (ranges.length === 0) return "none (insufficient history)";
  return ranges.map((r) => r.label).join(" / ");
}

function buildLaneOptimization(
  lane: SessionOptLane,
  tickets: PaperTicket[],
  minN: number,
  builtAtMs: number,
): { summary: SessionOptSummary; history: SessionOptHistoryRecord; durationMs: number } {
  const started = Date.now();
  type Acc = { n: number; wins: number; pnl: number };
  const grid = new Map<string, Acc>();
  const key = (wd: number, slot: number) => `${wd}:${slot}`;

  let allPnl = 0;
  let closeCount = 0;
  for (const t of tickets) {
    const at = closeAtMs(t);
    if (!at) continue;
    const pnl = scorecardPnlCents(t);
    allPnl += pnl;
    closeCount += 1;
    const { weekday, slot } = ptParts(at);
    const k = key(weekday, slot);
    const cur = grid.get(k) ?? { n: 0, wins: 0, pnl: 0 };
    cur.n += 1;
    if (pnl > 0) cur.wins += 1;
    cur.pnl += pnl;
    grid.set(k, cur);
  }

  const slots: SessionOptSlot[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let slot = 0; slot < SESSION_OPT_SLOTS_PER_DAY; slot++) {
      const cur = grid.get(key(weekday, slot)) ?? { n: 0, wins: 0, pnl: 0 };
      const avg = cur.n > 0 ? cur.pnl / cur.n : 0;
      const action =
        cur.n >= minN && avg < 0 ? ("sit" as const) : ("trade" as const);
      slots.push({
        weekday,
        slot,
        n: cur.n,
        wins: cur.wins,
        pnlCents: Math.round(cur.pnl * 10) / 10,
        avgCents: Math.round(avg * 10) / 10,
        action,
      });
    }
  }

  const ranges = bestSitWindows(slots, 4);
  const sitOccupied = buildSitOccupied(ranges);

  let optPnl = 0;
  for (const s of slots) {
    const idx = toSunWeekIndex(s.weekday, s.slot);
    if (!sitOccupied.has(idx)) optPnl += s.pnlCents;
  }

  const durationMs = Date.now() - started;
  const liftCents = Math.round((optPnl - allPnl) * 10) / 10;
  const summary: SessionOptSummary = {
    lane,
    builtAtMs,
    closeCount,
    sitOutSummary: buildSitOutSummary(ranges),
    ranges,
    allPnlCents: Math.round(allPnl * 10) / 10,
    optPnlCents: Math.round(optPnl * 10) / 10,
    liftCents,
  };

  const history: SessionOptHistoryRecord = {
    version: SESSION_OPT_CACHE_VERSION,
    durationMs,
    minN,
    slots,
    ...summary,
  };

  return { summary, history, durationMs };
}

export function buildPaperSessionOptimization(opts?: {
  minN?: number;
}): {
  cache: SessionOptCacheFile;
  histories: SessionOptHistoryRecord[];
  durationMs: number;
} {
  const started = Date.now();
  const minN = opts?.minN ?? SESSION_OPT_MIN_N;
  // Same journal + era cut as scorecard All / exit-opt Rec (no archives).
  const scorecard = collectScorecardEraTickets(loadAllSettled());
  const mid = scorecard.filter(isMidTicket);
  const eom = scorecard.filter(isEomTicket);

  const midBuilt = buildLaneOptimization("mid", mid, minN, started);
  const eomBuilt = buildLaneOptimization("eom", eom, minN, started);

  const cache: SessionOptCacheFile = {
    version: SESSION_OPT_CACHE_VERSION,
    durationMs: Date.now() - started,
    minN,
    builtAtMs: started,
    modeA: midBuilt.summary.closeCount > 0 ? midBuilt.summary : null,
    modeB: eomBuilt.summary.closeCount > 0 ? eomBuilt.summary : null,
  };

  return {
    cache,
    histories: [midBuilt.history, eomBuilt.history],
    durationMs: cache.durationMs,
  };
}
