import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import {
  sessionOptCachePath,
  sessionOptHistoryPath,
} from "@/lib/runtimeFlags";
import type {
  PaperSessionOptBundle,
  SessionOptHistoryRecord,
  SessionOptSummary,
} from "@/lib/sessionOptTypes";

/** v6: ignore leftover caches from prior installs / protocol epochs. */
export const SESSION_OPT_CACHE_VERSION = 6;

export interface SessionOptCacheFile extends PaperSessionOptBundle {
  version: typeof SESSION_OPT_CACHE_VERSION;
  durationMs: number;
  minN: number;
}

let cacheMtime = 0;
let cacheBody: SessionOptCacheFile | null = null;

function ensureParent(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
}

export function readSessionOptCache(force = false): SessionOptCacheFile | null {
  const file = sessionOptCachePath();
  if (!existsSync(file)) return null;
  try {
    const mtime = statSync(file).mtimeMs;
    if (!force && cacheBody && mtime === cacheMtime) return cacheBody;
    cacheBody = JSON.parse(readFileSync(file, "utf8")) as SessionOptCacheFile;
    cacheMtime = mtime;
    return cacheBody?.version === SESSION_OPT_CACHE_VERSION ? cacheBody : null;
  } catch {
    return null;
  }
}

export function readSessionOptBundle(): PaperSessionOptBundle | null {
  const cache = readSessionOptCache();
  if (!cache) return null;
  return {
    builtAtMs: cache.builtAtMs,
    modeA: cache.modeA,
    modeB: cache.modeB,
  };
}

export function readSessionOptSummary(
  lane: "mid" | "eom",
): SessionOptSummary | null {
  const bundle = readSessionOptBundle();
  if (!bundle) return null;
  return lane === "mid" ? bundle.modeA : bundle.modeB;
}

export function sessionOptCacheAgeMs(now = Date.now()): number | null {
  const cache = readSessionOptCache();
  if (!cache) return null;
  return Math.max(0, now - cache.builtAtMs);
}

export function writeSessionOptCache(body: SessionOptCacheFile) {
  const file = sessionOptCachePath();
  const tmp = `${file}.tmp`;
  ensureParent(file);
  writeFileSync(tmp, JSON.stringify(body), "utf8");
  renameSync(tmp, file);
  cacheBody = body;
  cacheMtime = statSync(file).mtimeMs;
}

export function appendSessionOptHistory(record: SessionOptHistoryRecord) {
  const file = sessionOptHistoryPath();
  ensureParent(file);
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

export function invalidateSessionOptCache() {
  cacheBody = null;
  cacheMtime = 0;
}
