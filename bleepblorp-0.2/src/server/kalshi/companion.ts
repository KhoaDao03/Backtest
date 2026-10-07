/**
 * Optional live companion on the same host (sevenstreams 0.1 / former EOM trader).
 *
 * Detection is informational only — 0.2 never requires the companion to be up.
 * Defaults already yield Kalshi REST/WS so a shared API key stays healthy either way.
 */

import http from "http";

const HEALTH_URL =
  process.env.BLEEPBLORP_COMPANION_HEALTH_URL?.trim() ||
  "http://127.0.0.1:8788/health";

const PROBE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 400;

export type CompanionLiveBot = {
  detected: boolean;
  detail: string;
  healthUrl: string;
};

let cached: { atMs: number; snap: CompanionLiveBot } | null = null;
let inflight: Promise<CompanionLiveBot> | null = null;

function empty(detail: string): CompanionLiveBot {
  return { detected: false, detail, healthUrl: HEALTH_URL };
}

function probeOnce(): Promise<CompanionLiveBot> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (snap: CompanionLiveBot) => {
      if (settled) return;
      settled = true;
      resolve(snap);
    };

    try {
      const req = http.get(HEALTH_URL, { timeout: PROBE_TIMEOUT_MS }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          done({
            detected: true,
            detail: "Companion live bot health OK (sevenstreams / former EOM trader)",
            healthUrl: HEALTH_URL,
          });
        } else {
          done(empty(`Companion health HTTP ${res.statusCode ?? "?"}`));
        }
      });
      req.on("timeout", () => {
        req.destroy();
        done(empty("No companion on health port (standalone OK)"));
      });
      req.on("error", () => {
        done(empty("No companion on health port (standalone OK)"));
      });
    } catch {
      done(empty("No companion on health port (standalone OK)"));
    }
  });
}

/** Cached, non-blocking companion probe for status / pulse. */
export async function getCompanionLiveBot(): Promise<CompanionLiveBot> {
  const now = Date.now();
  if (cached && now - cached.atMs < PROBE_TTL_MS) return cached.snap;
  if (inflight) return inflight;

  inflight = probeOnce().then((snap) => {
    cached = { atMs: Date.now(), snap };
    inflight = null;
    return snap;
  });
  return inflight;
}

/** Sync peek of last probe (or "unknown" if never probed). */
export function peekCompanionLiveBot(): CompanionLiveBot {
  return (
    cached?.snap ??
    empty("Companion not probed yet")
  );
}
