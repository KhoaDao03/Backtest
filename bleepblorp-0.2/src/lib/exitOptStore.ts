import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import type { ExitOptimization } from "@/lib/performanceTypes";
import { exitOptCachePath } from "@/lib/runtimeFlags";

/**
 * Local SL/TP helper cache (`npm run exit-opt` / exit-opt.timer).
 * Written only by exitOptWorker — scorecard reads, never searches.
 */
export const EXIT_OPT_CACHE_VERSION = 2;

export interface ExitOptSlice {
  pathCompleteN: number;
  fillCloseN: number;
  gapN?: number;
  exitOpt: ExitOptimization;
}

export interface ExitOptCacheFile {
  version: typeof EXIT_OPT_CACHE_VERSION;
  builtAtMs: number;
  durationMs: number;
  live: ExitOptSlice;
  paper?: ExitOptSlice & { logDir: string };
}

let cacheMtime = 0;
let cacheBody: ExitOptCacheFile | null = null;

function ensureParent(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
}

export function readExitOptCache(
  force = false,
): ExitOptCacheFile | null {
  const file = exitOptCachePath();
  if (!existsSync(file)) return null;
  try {
    const mtime = statSync(file).mtimeMs;
    if (!force && cacheBody && mtime === cacheMtime) return cacheBody;
    cacheBody = JSON.parse(readFileSync(file, "utf8")) as ExitOptCacheFile;
    cacheMtime = mtime;
    return cacheBody?.version === EXIT_OPT_CACHE_VERSION ? cacheBody : null;
  } catch {
    return null;
  }
}

export function readExitOptSlice(
  kind: "live" | "paper",
): ExitOptimization | null {
  const cache = readExitOptCache();
  if (!cache) return null;
  const slice = kind === "live" ? cache.live : cache.paper;
  return slice?.exitOpt ?? null;
}

export function exitOptCacheAgeMs(now = Date.now()): number | null {
  const cache = readExitOptCache();
  if (!cache) return null;
  return Math.max(0, now - cache.builtAtMs);
}

export function writeExitOptCache(body: ExitOptCacheFile) {
  const file = exitOptCachePath();
  const tmp = `${file}.tmp`;
  ensureParent(file);
  writeFileSync(tmp, JSON.stringify(body), "utf8");
  renameSync(tmp, file);
  cacheBody = body;
  cacheMtime = statSync(file).mtimeMs;
}

export function invalidateExitOptCache() {
  cacheBody = null;
  cacheMtime = 0;
}
