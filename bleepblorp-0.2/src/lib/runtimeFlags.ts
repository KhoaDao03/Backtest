import path from "path";

/** Emergency kill — scorecard shows empty exit-opt, no cache read. */
export function skipExitOpt(): boolean {
  const v = process.env.BLEEPBLORP_SKIP_EXIT_OPT;
  return v === "1" || v === "true";
}

/** Optional local exit-opt file path (not used for companion sharing). */
export function exitOptCachePath(): string {
  const raw = process.env.BLEEPBLORP_EXIT_OPT_CACHE;
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  return path.join(process.cwd(), "logs", "trader", "exit-opt.json");
}

/** Session sit-out summary cache written by sessionOptWorker. */
export function sessionOptCachePath(): string {
  const raw = process.env.BLEEPBLORP_SESSION_OPT_CACHE;
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  return path.join(process.cwd(), "logs", "trader", "session-opt.json");
}

export function sessionOptHistoryPath(): string {
  const raw = process.env.BLEEPBLORP_SESSION_OPT_HISTORY;
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  return path.join(process.cwd(), "logs", "trader", "session-opt-history.jsonl");
}

export function skipSessionOpt(): boolean {
  const v = process.env.BLEEPBLORP_SKIP_SESSION_OPT;
  return v === "1" || v === "true";
}
