/**
 * Kalshi REST/WS pacing for bleepblorp 0.2.
 *
 * Defaults are companion-friendly: when sevenstreams 0.1 (or any live bot)
 * shares the same Kalshi API key on this host, 0.2 waits, polls slower, and
 * backs off longer on 429 so the live process keeps first claim on the wire.
 *
 * Standalone (Strategist laptops, solo VPS) works with the same defaults —
 * slightly gentler cadence, no companion required. Set BLEEPBLORP_STANDALONE=1
 * for snappier solo loops (zeros start delays, tighter discovery).
 */

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function standalone(): boolean {
  const v = process.env.BLEEPBLORP_STANDALONE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const solo = standalone();

/** Wait after boot before the first market-list cycle (live companion starts at 0). */
export const DISCOVERY_OFFSET_MS = envMs(
  "BLEEPBLORP_DISCOVERY_OFFSET_MS",
  solo ? 0 : 1_250,
);

/** Steady-state market discovery period. Live companion is typically ~2500ms. */
export const MARKET_DISCOVERY_MS = envMs(
  "BLEEPBLORP_DISCOVERY_MS",
  solo ? 2_500 : 4_000,
);

/** Rollover refresh floor. Live companion is typically ~2000ms. */
export const MARKET_ROLLOVER_MS = envMs(
  "BLEEPBLORP_ROLLOVER_MS",
  solo ? 2_000 : 3_500,
);

/** Gap between per-series GET /markets. Live companion is typically ~120ms. */
export const SERIES_STAGGER_MS = envMs(
  "BLEEPBLORP_SERIES_STAGGER_MS",
  solo ? 120 : 200,
);

/** Base for 429 backoff: base * (attempt+1)^2. Live companion is typically ~500ms. */
export const REST_429_BASE_MS = envMs(
  "BLEEPBLORP_REST_429_BASE_MS",
  solo ? 500 : 1_500,
);

/** Delay Kalshi WS connect so a co-located live bot can grab a slot first. */
export const WS_START_DELAY_MS = envMs(
  "BLEEPBLORP_WS_START_DELAY_MS",
  solo ? 0 : 1_500,
);

/** First WS reconnect delay (then doubles). Live companion is typically ~1000ms. */
export const WS_RECONNECT_BASE_MS = envMs(
  "BLEEPBLORP_WS_RECONNECT_BASE_MS",
  solo ? 1_000 : 4_000,
);

/** REST BBO backup. Live companion is typically ~1500ms. */
export const BOOK_RECONCILE_MS = envMs(
  "BLEEPBLORP_BOOK_RECONCILE_MS",
  solo ? 1_500 : 3_000,
);

/** Lifecycle-driven market refresh. Live companion is typically ~150ms. */
export const LIFECYCLE_REFRESH_MS = envMs(
  "BLEEPBLORP_LIFECYCLE_REFRESH_MS",
  solo ? 150 : 400,
);

/** Decision tick. Live companion is typically ~250ms — paper yields the core. */
export const TICK_MS = envMs("BLEEPBLORP_TICK_MS", solo ? 400 : 750);

/** Paper scorecard rebuild — keep heavy so HTTP/SSE stay responsive. */
export const SCORECARD_MS = envMs("BLEEPBLORP_SCORECARD_MS", 15_000);

/** True when defaults (or env) are tuned to share a Kalshi key politely. */
export const YIELDS_TO_COMPANION = !solo;
