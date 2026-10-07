/**
 * Debounced / hourly out-of-process session sit-out rebuild.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { skipSessionOpt } from "@/lib/runtimeFlags";
import { sessionOptCacheAgeMs } from "@/server/performance/sessionOptStore";

const DEBOUNCE_MS = 2_500;
const MIN_RESPAWN_GAP_MS = 30_000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSpawnAtMs = 0;
let hourTimer: ReturnType<typeof setTimeout> | null = null;
let hourInterval: ReturnType<typeof setInterval> | null = null;

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
    "sessionOptWorker.ts",
  );
}

function spawnWorker(reason: string) {
  if (skipSessionOpt()) return;
  const now = Date.now();
  if (now - lastSpawnAtMs < MIN_RESPAWN_GAP_MS) return;
  const age = sessionOptCacheAgeMs(now);
  if (age != null && age < 120_000 && reason !== "boot" && reason !== "reset") {
    return;
  }
  lastSpawnAtMs = now;

  const entry = workerEntry();
  if (!existsSync(entry)) return;
  const bin = tsxBin();
  if (!existsSync(bin) && !existsSync(bin.replace(/\.cmd$/, ""))) return;

  try {
    const child = spawn(bin, [entry], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        BLEEPBLORP_SESSION_OPT_REASON: reason,
      },
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* never break trading */
  }
}

export function scheduleSessionOptRebuild(reason = "settle"): void {
  if (skipSessionOpt()) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    spawnWorker(reason);
  }, DEBOUNCE_MS);
}

export function scheduleSessionOptBootRebuild(): void {
  if (skipSessionOpt()) return;
  setTimeout(() => spawnWorker("boot"), 18_000);

  const msToNextHour = () => {
    const d = new Date();
    return (
      (60 - d.getMinutes()) * 60_000 -
      d.getSeconds() * 1000 -
      d.getMilliseconds()
    );
  };
  if (hourTimer) clearTimeout(hourTimer);
  hourTimer = setTimeout(() => {
    spawnWorker("hour");
    if (hourInterval) clearInterval(hourInterval);
    hourInterval = setInterval(() => spawnWorker("hour"), 60 * 60 * 1000);
  }, Math.max(5_000, msToNextHour()));
}
