import { buildPaperSessionOptimization } from "@/server/performance/sessionOptBuild";
import {
  appendSessionOptHistory,
  writeSessionOptCache,
} from "@/server/performance/sessionOptStore";

/**
 * Out-of-process session sit-out helper. Builds Mid-Market + End-of-Market
 * weekly time-of-day sit recommendations from the paper journal.
 */
export async function runSessionOptWorker() {
  const { cache, histories, durationMs } = buildPaperSessionOptimization();
  writeSessionOptCache(cache);
  for (const h of histories) appendSessionOptHistory(h);
  const mid = cache.modeA?.sitOutSummary ?? "—";
  const eom = cache.modeB?.sitOutSummary ?? "—";
  process.stdout.write(
    `session-opt built in ${durationMs}ms midCloses=${cache.modeA?.closeCount ?? 0} eomCloses=${cache.modeB?.closeCount ?? 0} midLift=${((cache.modeA?.liftCents ?? 0) / 100).toFixed(2)} eomLift=${((cache.modeB?.liftCents ?? 0) / 100).toFixed(2)} · mid: ${mid} · eom: ${eom}\n`,
  );
  return cache;
}

async function main() {
  await runSessionOptWorker();
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
