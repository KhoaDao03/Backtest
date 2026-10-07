import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import type { PaperTicket } from "@/lib/performanceTypes";

const LOG_DIR = path.join(process.cwd(), "logs");
const SIGNAL_LOG = path.join(LOG_DIR, "signals.jsonl");
const OPEN_STATE = path.join(LOG_DIR, "open_tickets.json");

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

export function appendSignalEvent(event: Record<string, unknown>) {
  ensureLogDir();
  appendFileSync(SIGNAL_LOG, `${JSON.stringify({ ...event, loggedAtMs: Date.now() })}\n`, "utf8");
}

export function loadOpenTickets(): PaperTicket[] {
  ensureLogDir();
  if (!existsSync(OPEN_STATE)) return [];
  try {
    const raw = readFileSync(OPEN_STATE, "utf8");
    const parsed = JSON.parse(raw) as PaperTicket[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveOpenTickets(tickets: PaperTicket[]) {
  ensureLogDir();
  writeFileSync(OPEN_STATE, JSON.stringify(tickets, null, 2), "utf8");
}

export function loadSettledToday(dayKey: string): PaperTicket[] {
  return loadSettled({ dayKey });
}

/** All settled tickets in the journal (ongoing / lifetime scorecard). */
export function loadAllSettled(opts?: { pathMarks?: boolean }): PaperTicket[] {
  return loadSettled({ pathMarks: opts?.pathMarks });
}

function loadSettled(filter: {
  dayKey?: string;
  /** Keep entry→expiry marks (exit-opt). Scorecard hot path omits them. */
  pathMarks?: boolean;
}): PaperTicket[] {
  ensureLogDir();
  if (!existsSync(SIGNAL_LOG)) return [];
  const keepPath = Boolean(filter.pathMarks);
  const lines = readFileSync(SIGNAL_LOG, "utf8").split("\n").filter(Boolean);
  const out: PaperTicket[] = [];
  const idx = new Map<string, number>();
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        type?: string;
        ticket?: PaperTicket;
        dayKey?: string;
      };
      if (!row.ticket) continue;
      if (filter.dayKey != null && row.dayKey !== filter.dayKey) continue;
      if (row.type === "settle") {
        const id = row.ticket.id;
        const ticket = keepPath
          ? row.ticket
          : { ...row.ticket, pathMarks: undefined };
        const existing = idx.get(id);
        if (existing != null) out[existing] = ticket;
        else {
          idx.set(id, out.length);
          out.push(ticket);
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
          pathMarks: keepPath
            ? row.ticket.pathMarks ?? cur.pathMarks
            : undefined,
        };
      }
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

export function dayKeyFromMs(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const EARLY85_LOG = path.join(LOG_DIR, "early85.jsonl");

/** Human + JSON trail for the first-≥85%-before-8:00 paper path (not shown on the board). */
export function appendEarly85Log(event: {
  type: "open" | "settle";
  ticket: PaperTicket;
  allWins: number;
  allSettled: number;
  allPnlCents: number;
  openNow: number;
}) {
  ensureLogDir();
  appendFileSync(
    EARLY85_LOG,
    `${JSON.stringify({ ...event, loggedAtMs: Date.now() })}\n`,
    "utf8",
  );
  const t = event.ticket;
  const wr =
    event.allSettled > 0
      ? `${Math.round((event.allWins / event.allSettled) * 100)}%`
      : "—";
  const pnl = event.allPnlCents;
  const dol = `${pnl < 0 ? "-" : ""}$${(Math.abs(pnl) / 100).toFixed(2)}`;
  const ask = `${(t.entryAsk * 100).toFixed(1)}¢`;
  const line =
    event.type === "open"
      ? `EARLY85 OPEN ${t.symbol} ${t.side} @ ${ask} conf ${t.confAtOpen?.toFixed(0) ?? "?"} ${t.secondsLeftAtOpen}s | ALL ${event.allWins}/${event.allSettled} ${wr} ${dol} · ${event.openNow} open`
      : `EARLY85 SETTLE ${t.symbol} ${t.outcome} ${t.pnlCents ?? 0}¢ | ALL ${event.allWins}/${event.allSettled} ${wr} ${dol}`;
  process.stdout.write(`${line}\n`);
}

/** Wipe paper journal + open tickets + SL/TP + sit-out caches (scorecard starts fresh). */
export function clearPaperJournal() {
  ensureLogDir();
  writeFileSync(SIGNAL_LOG, "", "utf8");
  writeFileSync(OPEN_STATE, "[]\n", "utf8");
  const exitOpt = path.join(LOG_DIR, "trader", "exit-opt.json");
  if (existsSync(exitOpt)) unlinkSync(exitOpt);
  const sessionOpt = path.join(LOG_DIR, "trader", "session-opt.json");
  if (existsSync(sessionOpt)) unlinkSync(sessionOpt);
}
