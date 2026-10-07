/** Session sit-out optimizer — recommend-only weekly time-of-day report. */

export type SessionSlotAction = "sit" | "trade";

export type SessionOptLane = "mid" | "eom";

export interface SessionOptSlot {
  /** 0=Mon … 6=Sun (America/Los_Angeles). */
  weekday: number;
  /** 0–95: floor(minuteOfDay / 15). */
  slot: number;
  n: number;
  wins: number;
  /** Sum of per-contract PnL (¢) for closes in this slot. */
  pnlCents: number;
  /** Mean per-contract PnL (¢) for closes in this slot. */
  avgCents: number;
  action: SessionSlotAction;
}

export interface SessionOptRange {
  /** Display label, e.g. "Thu 1am–4am" or "Weekdays 5pm–9pm". */
  label: string;
  /** Mean per-contract PnL (¢) across closes in this range. */
  pnlCents: number;
  n: number;
  /** Weekdays covered (0–6, Mon=0). */
  weekdays: number[];
  /** Clock / local start slot (0–95). */
  startSlot: number;
  /** Clock / local end slot exclusive. */
  endSlotExclusive: number;
  /** Sunday-first week index of first slot (day-specific windows). */
  startSunIndex?: number;
  /** Day-specific window length in 15m slots. */
  slotCount?: number;
  /** day = one calendar stretch; weekdays/weekend = pooled same clock times. */
  kind?: "day" | "weekdays" | "weekend";
}

/** Slim payload for SSE / UI (one lane). */
export interface SessionOptSummary {
  lane: SessionOptLane;
  builtAtMs: number;
  closeCount: number;
  /** Human line, e.g. "Weekdays 5pm–9pm / Thu 1am–4am". */
  sitOutSummary: string;
  ranges: SessionOptRange[];
  allPnlCents: number;
  optPnlCents: number;
  liftCents: number;
}

/** Mid-Market + End-of-Market sit-out reports for the paper scorecard. */
export interface PaperSessionOptBundle {
  builtAtMs: number;
  modeA: SessionOptSummary | null;
  modeB: SessionOptSummary | null;
}

/** Full hourly dump for research (history jsonl). */
export interface SessionOptHistoryRecord extends SessionOptSummary {
  version: number;
  durationMs: number;
  slots: SessionOptSlot[];
  minN: number;
}
