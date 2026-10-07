import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  type WriteStream,
} from "fs";
import path from "path";
import type { AssetSymbol, MarketSnapshot } from "@/lib/types";

/**
 * Unconditional tick recorder for the mid-market research run.
 *
 * This logs raw paths rather than graded trades, and it logs every asset on
 * every cadence regardless of what any strategy thinks. Both choices matter:
 *
 * - Recording outcomes can only answer the question you already asked. Recording
 *   the path lets a rule invented three weeks from now be tested against every
 *   window we ever saw, without collecting anything again.
 * - Recording only what a strategy selected means never observing the setups it
 *   passed on, which makes it impossible to show that strategy was wrong. The
 *   arms are scored against this stream afterwards, not used to filter it.
 *
 * Writes are buffered and flushed on a timer. The journal blocking the event
 * loop is what caused the Kalshi ping/pong drops we chased earlier, and this
 * file grows far faster than that one did.
 */

const RESEARCH_DIR = path.join(process.cwd(), "logs", "research");
const RUN_FILE = path.join(RESEARCH_DIR, "run.json");
/** Planned length of the collection run. */
const PLANNED_DAYS = 14;
/**
 * Final days reserved as a test set the fitting never sees.
 *
 * Protocols 15, 16 and 17 were each fit on recent data, each looked justified,
 * and each lost money live (+0.06¢, −1.96¢, −2.67¢ against 0.1's +1.29¢). Three
 * failures of the same loop is enough to make the holdout a file on disk rather
 * than an intention — the window is pinned when collection starts, before anyone
 * knows which dates would flatter a result.
 */
const HOLDOUT_DAYS = 4;

export interface ResearchRun {
  startedAtMs: number;
  startDay: string;
  plannedDays: number;
  holdoutDays: number;
  /** Rows on or after this day are the test set. */
  holdoutStartDay: string;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Read the pinned run window, if collection has started. */
export function readResearchRun(): ResearchRun | null {
  try {
    if (!existsSync(RUN_FILE)) return null;
    return JSON.parse(readFileSync(RUN_FILE, "utf8").replace(/^\uFEFF/, "")) as ResearchRun;
  } catch {
    return null;
  }
}
/** One row per asset per interval. */
const SAMPLE_MS = 5_000;
const FLUSH_MS = 5_000;
/** Hard cap so a stalled stream can't grow the buffer without bound. */
const MAX_BUFFER_ROWS = 5_000;

/** Compact schema — this file accumulates ~70k rows a day for two weeks. */
export interface PathRow {
  /** Timestamp, ms */
  t: number;
  sym: AssetSymbol;
  mkt: string;
  /** Seconds left in the window */
  sl: number;
  sp: number;
  stk: number;
  /** BBO in cents. Down-side quotes are logged rather than derived so that a
   *  crossed or one-sided book stays visible in the data instead of being
   *  silently reconstructed as if it were clean. */
  au: number;
  bu: number;
  ad: number;
  bd: number;
  atr: number;
  sk: number;
  skp: number;
  bbm: number;
  bbu: number;
  bbl: number;
  /** Where the book came from, so bad-quote periods can be filtered out later. */
  src?: string;
}

/** Keep precision meaningful across BTC (~63000) and XRP (~0.5) without bloating rows. */
function r(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n * 100) / 100;
  if (a >= 1) return Math.round(n * 10000) / 10000;
  return Math.round(n * 1e6) / 1e6;
}

function cents(prob: number): number {
  return Number.isFinite(prob) ? Math.round(prob * 1000) / 10 : 0;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

class PathRecorder {
  private stream: WriteStream | null = null;
  private streamDay = "";
  private buffer: string[] = [];
  private lastSampleMs = new Map<AssetSymbol, number>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private rowsWritten = 0;
  private dropped = 0;
  private lastError: string | null = null;
  private runPinned = false;

  /** Sample one asset. No-ops until SAMPLE_MS has passed for that symbol. */
  record(args: { snapshot: MarketSnapshot; marketTicker: string; bookSource?: string }) {
    const { snapshot: s, marketTicker, bookSource } = args;
    const now = Date.now();
    const last = this.lastSampleMs.get(s.symbol) ?? 0;
    if (now - last < SAMPLE_MS) return;
    this.lastSampleMs.set(s.symbol, now);
    this.pinRunWindow(now, new Date(now).toISOString().slice(0, 10));

    const row: PathRow = {
      t: now,
      sym: s.symbol,
      mkt: marketTicker,
      sl: s.secondsLeft,
      sp: r(s.spot),
      stk: r(s.strike),
      au: cents(s.askUp),
      bu: cents(s.bidUp),
      ad: cents(s.askDown),
      bd: cents(s.bidDown),
      atr: r(s.atr1m),
      sk: Math.round(s.stochK * 10) / 10,
      skp: Math.round(s.stochKPrev * 10) / 10,
      bbm: r(s.bbMid),
      bbu: r(s.bbUpper),
      bbl: r(s.bbLower),
      ...(bookSource ? { src: bookSource } : {}),
    };

    if (this.buffer.length >= MAX_BUFFER_ROWS) {
      this.dropped++;
      return;
    }
    this.buffer.push(JSON.stringify(row));
    this.ensureTimer();
  }

  stats() {
    return {
      rowsWritten: this.rowsWritten,
      buffered: this.buffer.length,
      dropped: this.dropped,
      file: this.streamDay ? `paths-${this.streamDay}.jsonl` : null,
      lastError: this.lastError,
    };
  }

  private ensureTimer() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    // Never hold the process open just to flush research rows.
    this.flushTimer.unref?.();
  }

  private ensureStream(now: number): WriteStream | null {
    const day = dayKey(now);
    if (this.stream && this.streamDay === day) return this.stream;
    try {
      if (!existsSync(RESEARCH_DIR)) mkdirSync(RESEARCH_DIR, { recursive: true });
      this.stream?.end();
      this.stream = createWriteStream(path.join(RESEARCH_DIR, `paths-${day}.jsonl`), {
        flags: "a",
        encoding: "utf8",
      });
      this.stream.on("error", (err) => {
        this.lastError = err.message;
        this.stream = null;
        this.streamDay = "";
      });
      this.streamDay = day;
      return this.stream;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * Written once, on the first row ever recorded, and never rewritten.
   *
   * Deliberately not tied to stream creation: the recorder is a singleton that
   * survives Next's hot reloads, so a mid-run edit would leave the window
   * unpinned until the next midnight rotation. The holdout has to exist from
   * the first tick or it isn't a commitment.
   */
  private pinRunWindow(now: number, day: string) {
    if (this.runPinned) return;
    this.runPinned = true;
    if (!existsSync(RESEARCH_DIR)) mkdirSync(RESEARCH_DIR, { recursive: true });
    if (existsSync(RUN_FILE)) return;
    const run: ResearchRun = {
      startedAtMs: now,
      startDay: day,
      plannedDays: PLANNED_DAYS,
      holdoutDays: HOLDOUT_DAYS,
      holdoutStartDay: addDays(day, PLANNED_DAYS - HOLDOUT_DAYS),
    };
    writeFileSync(RUN_FILE, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  private flush() {
    if (!this.buffer.length) return;
    const stream = this.ensureStream(Date.now());
    if (!stream) return;
    const chunk = `${this.buffer.join("\n")}\n`;
    const count = this.buffer.length;
    this.buffer = [];
    try {
      stream.write(chunk, (err) => {
        if (err) this.lastError = err.message;
      });
      this.rowsWritten += count;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}

const globalForRecorder = globalThis as unknown as {
  __bleepblorpRecorder?: PathRecorder;
};

export function getPathRecorder(): PathRecorder {
  globalForRecorder.__bleepblorpRecorder ??= new PathRecorder();
  return globalForRecorder.__bleepblorpRecorder;
}
