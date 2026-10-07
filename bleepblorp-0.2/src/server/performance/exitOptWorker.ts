/**
 * Out-of-process SL/TP helper. Reads the full paper journal, searches every
 * SL×TP combo, writes logs/trader/exit-opt.json. Never import this onto the
 * live feed hot path — spawn it via exitOptScheduler or systemd.
 */
import { loadLocalEnv } from "@/lib/loadLocalEnv";
import {
  EXIT_OPT_CACHE_VERSION,
  writeExitOptCache,
  type ExitOptCacheFile,
} from "@/lib/exitOptStore";
import { buildPaperAllHistoryExitOpt } from "@/server/performance/exitOptBuild";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from "fs";
import path from "path";

loadLocalEnv();

/** Match exitOptScheduler — crashed workers must not block Rec forever. */
const STALE_LOCK_MS = 10 * 60 * 1000;

function lockPath(): string {
  return path.join(process.cwd(), "logs", "trader", "exit-opt.lock");
}

function tryLock(): number | null {
  const file = lockPath();
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    return openSync(file, "wx");
  } catch {
    try {
      const age = Date.now() - statSync(file).mtimeMs;
      if (age >= STALE_LOCK_MS) {
        unlinkSync(file);
        return openSync(file, "wx");
      }
    } catch {
      /* still held or raced */
    }
    return null;
  }
}

function unlock(fd: number) {
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lockPath());
  } catch {
    /* ignore */
  }
}

export async function runExitOptWorker(): Promise<ExitOptCacheFile> {
  const started = Date.now();
  const logDir = process.env.BLEEPBLORP_PAPER_LOG_DIR
    ? path.isAbsolute(process.env.BLEEPBLORP_PAPER_LOG_DIR)
      ? process.env.BLEEPBLORP_PAPER_LOG_DIR
      : path.join(process.cwd(), process.env.BLEEPBLORP_PAPER_LOG_DIR)
    : path.join(process.cwd(), "logs");

  const built = buildPaperAllHistoryExitOpt(logDir);
  const body: ExitOptCacheFile = {
    version: EXIT_OPT_CACHE_VERSION,
    builtAtMs: started,
    durationMs: Date.now() - started,
    live: {
      pathCompleteN: 0,
      fillCloseN: 0,
      gapN: 0,
      exitOpt: built.exitOpt,
    },
    paper: {
      logDir,
      pathCompleteN: built.pathCompleteN,
      fillCloseN: built.fillCloseN,
      gapN: built.gapN,
      exitOpt: built.exitOpt,
    },
  };
  writeExitOptCache(body);
  return body;
}

async function main() {
  const fd = tryLock();
  if (fd == null) {
    process.stdout.write("exit-opt skipped · lock held\n");
    return;
  }
  try {
    const body = await runExitOptWorker();
    const reason = process.env.BLEEPBLORP_EXIT_OPT_REASON || "manual";
    process.stdout.write(
      [
      `exit-opt built in ${body.durationMs}ms`,
      `scorecard-era fills=${body.paper?.fillCloseN ?? 0}`,
      `pathReady=${body.paper?.pathCompleteN ?? 0}`,
      `reason=${reason}`,
      ].join(" · ") + "\n",
    );
  } finally {
    unlock(fd);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  try {
    if (existsSync(lockPath())) unlinkSync(lockPath());
  } catch {
    /* ignore */
  }
  process.exit(1);
});
