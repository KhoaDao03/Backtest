/**
 * Browser-local wall-clock helpers.
 * Sit-out analysis bins are America/Los_Angeles; UI converts for the viewer.
 */

export const SESSION_OPT_ANALYSIS_TZ = "America/Los_Angeles";
export const SESSION_OPT_SLOTS_PER_DAY = 96;

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function viewerTimeZone(): string {
  if (typeof Intl === "undefined") return SESSION_OPT_ANALYSIS_TZ;
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || SESSION_OPT_ANALYSIS_TZ
    );
  } catch {
    return SESSION_OPT_ANALYSIS_TZ;
  }
}

/** Short zone label for the viewer, e.g. PDT / PST / EST. */
export function timeZoneAbbr(
  timeZone: string = viewerTimeZone(),
  atMs: number = Date.now(),
): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date(atMs));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
};

function zonedParts(atMs: number, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(atMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")) || 1970,
    month: Number(get("month")) || 1,
    day: Number(get("day")) || 1,
    hour: Number(get("hour")) || 0,
    minute: Number(get("minute")) || 0,
    weekday: get("weekday"),
  };
}

/** Map Intl weekday short → Mon=0 … Sun=6. */
function weekdayIndex(short: string): number {
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return map[short] ?? 0;
}

/**
 * Interpret a wall clock in `timeZone` as a UTC instant.
 * Iteratively corrects for the zone offset (handles DST).
 */
export function zonedWallToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(utc, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const want = Date.UTC(year, month - 1, day, hour, minute, 0);
    const delta = want - asUtc;
    if (delta === 0) break;
    utc += delta;
  }
  return utc;
}

function dateForAnalysisWeekday(
  weekday: number,
  analysisTz: string,
  nearMs: number = Date.now(),
): { year: number; month: number; day: number } {
  // Walk from "today" so DST / abbr match the current season.
  let ms = nearMs;
  for (let i = 0; i < 10; i++) {
    const p = zonedParts(ms, analysisTz);
    if (weekdayIndex(p.weekday) === weekday) {
      return { year: p.year, month: p.month, day: p.day };
    }
    ms += 86_400_000;
  }
  const p = zonedParts(ms, analysisTz);
  return { year: p.year, month: p.month, day: p.day };
}

function slotToHourMinute(slot: number): { hour: number; minute: number } {
  const mins = Math.max(0, slot) * 15;
  return { hour: Math.floor(mins / 60) % 24, minute: mins % 60 };
}

/** 12h clock without zone, e.g. 2pm or 2:15pm. */
export function formatLocalClock(
  atMs: number,
  timeZone: string = viewerTimeZone(),
): string {
  const p = zonedParts(atMs, timeZone);
  const am = p.hour < 12;
  let h12 = p.hour % 12;
  if (h12 === 0) h12 = 12;
  const suffix = am ? "am" : "pm";
  if (p.minute === 0) return `${h12}${suffix}`;
  return `${h12}:${String(p.minute).padStart(2, "0")}${suffix}`;
}

/** Absolute local expiry for a market, e.g. "5:15pm PDT". */
export function formatLocalExpiry(
  secondsLeft: number,
  nowMs: number = Date.now(),
  timeZone: string = viewerTimeZone(),
): string {
  const at = nowMs + Math.max(0, secondsLeft) * 1000;
  return `${formatLocalClock(at, timeZone)} ${timeZoneAbbr(timeZone, at)}`;
}

export function formatSessionOptRangeLabel(
  range: {
    weekdays: number[];
    startSlot: number;
    endSlotExclusive: number;
  },
  displayTz: string = viewerTimeZone(),
  analysisTz: string = SESSION_OPT_ANALYSIS_TZ,
): string {
  const uniq = [...new Set(range.weekdays)].sort((a, b) => a - b);
  const wd = uniq[0] ?? 0;
  const day = dateForAnalysisWeekday(wd, analysisTz);
  const startHm = slotToHourMinute(range.startSlot);
  const startMs = zonedWallToUtcMs(
    day.year,
    day.month,
    day.day,
    startHm.hour,
    startHm.minute,
    analysisTz,
  );

  let endMs: number;
  if (range.endSlotExclusive >= SESSION_OPT_SLOTS_PER_DAY) {
    const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
    endMs = zonedWallToUtcMs(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
      analysisTz,
    );
  } else {
    const endHm = slotToHourMinute(range.endSlotExclusive);
    endMs = zonedWallToUtcMs(
      day.year,
      day.month,
      day.day,
      endHm.hour,
      endHm.minute,
      analysisTz,
    );
  }

  const clock = `${formatLocalClock(startMs, displayTz)}–${formatLocalClock(endMs, displayTz)}`;
  const abbr = timeZoneAbbr(displayTz, startMs);

  const isWeekdayBlock = uniq.length === 5 && uniq.every((d, i) => d === i);
  if (isWeekdayBlock) return `Weekday ${clock} ${abbr}`;
  if (uniq.length === 1) return `${DAY_NAMES[uniq[0]!]} ${clock} ${abbr}`;
  if (uniq.length === 2 && uniq[0] === 5 && uniq[1] === 6) {
    return `Weekend ${clock} ${abbr}`;
  }
  return `${uniq.map((d) => DAY_NAMES[d]).join("/")} ${clock} ${abbr}`;
}

export function formatSessionOptWindows(
  ranges: {
    weekdays: number[];
    startSlot: number;
    endSlotExclusive: number;
    label?: string;
    kind?: "day" | "weekdays" | "weekend";
  }[],
  fallbackSummary?: string | null,
  displayTz: string = viewerTimeZone(),
): string {
  if (ranges.length > 0) {
    // Prefer server labels (PT clocks / Weekdays·Weekend·day kinds from v5).
    const labeled = ranges
      .map((r) => r.label?.trim())
      .filter((s): s is string => Boolean(s));
    if (labeled.length === ranges.length) return labeled.join(" / ");
    return ranges
      .map((r) => r.label?.trim() || formatSessionOptRangeLabel(r, displayTz))
      .join(" / ");
  }
  const summary = fallbackSummary?.trim();
  if (!summary) return "none (insufficient history)";
  // Legacy string without zone — tag viewer abbr once.
  if (/\b(P[DS]T|ET|EST|EDT|CT|CST|CDT|MT|MST|MDT)\b/i.test(summary)) {
    return summary;
  }
  return `${summary} ${timeZoneAbbr(displayTz)}`;
}
