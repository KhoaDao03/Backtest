/**
 * Kalshi weekly crypto 15m gap (Wed 11:45p–Thu 2:00a PT).
 *
 * Expectancy HOLD sit-outs removed for both end-of-market and mid-market —
 * scorecard lanes always take Buys when the rec fires.
 */

import type { AssetSymbol } from "@/lib/types";

/** @deprecated Expectancy HOLD removed. */
export const GATE_MIN_N = 6;
/** @deprecated Expectancy HOLD removed. */
export const GATE_PAUSE_AVG_CENTS = -2;
/** @deprecated Expectancy HOLD removed. */
export const GATE_RESUME_AVG_CENTS = 0.25;
/** @deprecated Expectancy HOLD removed. */
export const GATE_PAUSE_MS = 2 * 60 * 60 * 1000;
/** @deprecated Expectancy HOLD removed. */
export const GATE_RESUME_MS = 60 * 60 * 1000;
/** @deprecated Expectancy HOLD removed. */
export const MODE_A_GATE_PAUSE_MS = 60 * 60 * 1000;
/** @deprecated Expectancy HOLD removed. */
export const MODE_A_GATE_RESUME_MS = 30 * 60 * 1000;
/** Mid-market expectancy HOLD is off (kept false for any leftover checks). */
export const MODE_A_GATE_ENABLED = false;

/** Omitted from gate expectancy. Empty on 0.2 (no NEAR). */
export const GATE_EXCLUDE_SYMBOLS: ReadonlySet<AssetSymbol> = new Set();

/** @deprecated use GATE_PAUSE_MS */
export const TRAIL_WR_MS = GATE_PAUSE_MS;
/** @deprecated use GATE_MIN_N */
export const TRAIL_WR_MIN_N = GATE_MIN_N;
/** @deprecated use GATE_EXCLUDE_SYMBOLS */
export const TRAIL_WR_EXCLUDE_SYMBOLS = GATE_EXCLUDE_SYMBOLS;

export type TrailClose = { atMs: number; pnlCents: number };

/** Live gate figure shown on the dashboard (always computed, even off HOLD). */
export type TrailWrSnapshot = {
  pauseN: number;
  pauseAvgCents: number | null;
  pauseSumCents: number;
  resumeN: number;
  resumeAvgCents: number | null;
  resumeSumCents: number;
  liveN: number;
  paperN: number;
  exclude: AssetSymbol[];
  /** Defaults to "2h" in the scorecard label. */
  pauseWindow?: string;
  /** Defaults to "1h" in the scorecard label. */
  resumeWindow?: string;
};

export function trailExpectancy(
  closes: TrailClose[],
  windowMs: number,
  now = Date.now(),
): { n: number; sumCents: number; avgCents: number | null } {
  const window = closes.filter(
    (c) => now - c.atMs >= 0 && now - c.atMs <= windowMs,
  );
  const n = window.length;
  const sumCents = window.reduce((s, c) => s + c.pnlCents, 0);
  return {
    n,
    sumCents: Math.round(sumCents * 10) / 10,
    avgCents: n ? Math.round((sumCents / n) * 10) / 10 : null,
  };
}

/** n below min → never enter HOLD; while HOLD, stay until resume window qualifies. */
export function nextGateHold(
  paused: boolean,
  pause: { n: number; avgCents: number | null },
  resume: { n: number; avgCents: number | null },
): boolean {
  const pauseBad =
    pause.n >= GATE_MIN_N &&
    pause.avgCents != null &&
    pause.avgCents < GATE_PAUSE_AVG_CENTS;
  const resumeOk =
    resume.n >= GATE_MIN_N &&
    resume.avgCents != null &&
    resume.avgCents >= GATE_RESUME_AVG_CENTS;

  if (!paused) {
    if (pauseBad && !resumeOk) return true;
    return false;
  }
  if (resumeOk) return false;
  return true;
}

export function pacificClock(nowMs = Date.now()): {
  weekday: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/**
 * Last 15m crypto print is 11:45p PT Wednesday; Kalshi skips 11:45p–midnight
 * and weekly maintenance runs until 2:00a PT Thursday.
 */
export function isWeeklyCryptoMaintenance(nowMs = Date.now()): boolean {
  const { weekday, hour, minute } = pacificClock(nowMs);
  if (weekday === "Wed" && hour === 23 && minute >= 45) return true;
  if (weekday === "Thu" && hour < 2) return true;
  return false;
}
