/**
 * Debounced out-of-process SL/TP rebuild. Safe to call from settle handlers —
 * never runs the grid on the caller's event loop.
 *
 * After every path-complete market end the helper re-reads the full journal and
 * re-searches every SL×TP combo. If a worker is already running (or the lock is
 * sticky), we queue another pass so Rec is never left on a truncated path.
 */
import { spawn } from "child_process";
import { existsSync, statSync, unlinkSync } from "fs";
import path from "path";
import { skipExitOpt } from "@/lib/runtimeFlags";

const DEBOUNCE_MS = 1_500;
/** Skip immediate spawn if another worker finished within this window. */
const MIN_RESPAWN_GAP_MS = 3_000;
/** Stale lock from a crashed worker — steal after this age. */
const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_RETRY_MS = 2_500;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSpawnAtMs = 0;
/** Reason for a rebuild that must run once the lock / gap clears. */
let pendingReason: string | null = null;

function lockPath(): string {
  return path.join(process.cwd(), "logs", "trader", "exit-opt.lock");
}

function tsxBin(): string {
  const base = path.join(process.cwd(), "node_modules", ".bin");
  const win = path.join(base, "tsx.cmd");
  const nix = path.join(base, "tsx");
  if (process.platform === "win32" && existsSync(win)) return win;
  return nix;
}

function workerEntry(): string {
  return path.join(
    process.cwd(),
    "src",
    "server",
    "performance",
    "exitOptWorker.ts",
  );
}

/** True while a live worker holds the lock (not a stale crash leftover). */
function lockHeld(): boolean {
  const lock = lockPath();
  if (!existsSync(lock)) return false;
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age >= STALE_LOCK_MS) {
      try {
        unlinkSync(lock);
      } catch {
        /* another process may clear it */
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function queuePending(reason: string) {
  pendingReason = reason;
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const reasonNext = pendingReason;
    if (!reasonNext) return;
    if (lockHeld() || Date.now() - lastSpawnAtMs < MIN_RESPAWN_GAP_MS) {
      queuePending(reasonNext);
      return;
    }
    pendingReason = null;
    spawnWorker(reasonNext);
  }, LOCK_RETRY_MS);
}

function spawnWorker(reason: string) {
  if (skipExitOpt()) return;
  if (lockHeld()) {
    queuePending(reason);
    return;
  }
  const now = Date.now();
  if (now - lastSpawnAtMs < MIN_RESPAWN_GAP_MS) {
    queuePending(reason);
    return;
  }

  const entry = workerEntry();
  if (!existsSync(entry)) return;
  const bin = tsxBin();
  if (!existsSync(bin) && !existsSync(bin.replace(/\.cmd$/, ""))) return;

  lastSpawnAtMs = now;
  try {
    const child = spawn(bin, [entry], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        BLEEPBLORP_EXIT_OPT_REASON: reason,
      },
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* never break trading for helper spawn failures */
    queuePending(reason);
  }
}

/** Queue a scorecard All-era SL/TP rebuild after a path-complete settle. */
export function scheduleExitOptRebuild(reason = "settle"): void {
  if (skipExitOpt()) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    spawnWorker(reason);
  }, DEBOUNCE_MS);
}

/** Kick a rebuild shortly after boot so Rec is warm without blocking listen. */
export function scheduleExitOptBootRebuild(): void {
  if (skipExitOpt()) return;
  setTimeout(() => spawnWorker("boot"), 12_000);
}
