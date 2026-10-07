/**
 * Moving-barrier reach probability for mid-market scalps.
 *
 * A Kalshi 15m contract's price tracks Phi(cushion / sigma_T), where
 * sigma_T = atr1m * sqrt(T / 60). Two independent things push that price up:
 * spot moving toward/past the strike, and T shrinking so sigma_T collapses.
 * The second one needs no directional view at all — an in-the-money contract
 * melts toward 100c on its own if spot simply stays put.
 *
 * Asking "will the price reach entry + delta before the window closes" is
 * therefore a first-passage problem against a barrier that *moves*: expressed
 * in spot terms the barrier is strike + sigma_T(t) * zTarget, which descends
 * toward the strike as the clock runs out. Both mechanisms fall out of the
 * same calculation.
 *
 * Substituting u = elapsed fraction of the remaining window, the whole problem
 * collapses to a dimensionless one in units of sigma_T:
 *
 *   reach  <=>  exists u in (0,1] :  W(u) >= sqrt(1-u) * zTarget - zNow - mu*u
 *
 * so spot, strike, ATR and clock all drop out and only (zNow, zTarget, mu)
 * remain. That makes a memoized Monte Carlo cheap enough for the hot path.
 */

import { clip, normalCdf, normalInv } from "./math";

const STEPS = 24;
const PATHS = 512;

/** Deterministic PRNG so probabilities are reproducible across runs and replays. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormalPair(rand: () => number): [number, number] {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/**
 * Standard Brownian paths on [0,1], sampled at u_k = k/STEPS.
 * Antithetic pairs (each path mirrored) halve the variance for free.
 */
const PATH_GRID: Float64Array[] = (() => {
  const rand = mulberry32(0x9e3779b9);
  const dt = 1 / STEPS;
  const sq = Math.sqrt(dt);
  const grid: Float64Array[] = [];
  for (let i = 0; i < PATHS / 2; i++) {
    const a = new Float64Array(STEPS);
    const b = new Float64Array(STEPS);
    let wa = 0;
    let spare: number | null = null;
    for (let k = 0; k < STEPS; k++) {
      let z: number;
      if (spare !== null) {
        z = spare;
        spare = null;
      } else {
        const [z1, z2] = standardNormalPair(rand);
        z = z1;
        spare = z2;
      }
      wa += z * sq;
      a[k] = wa;
      b[k] = -wa;
    }
    grid.push(a, b);
  }
  return grid;
})();

/** u_k and sqrt(1-u_k) for each step, precomputed. */
const U = new Float64Array(STEPS);
const SQRT_1MU = new Float64Array(STEPS);
for (let k = 0; k < STEPS; k++) {
  const u = (k + 1) / STEPS;
  U[k] = u;
  SQRT_1MU[k] = Math.sqrt(Math.max(0, 1 - u));
}

const cache = new Map<string, number>();
const CACHE_CAP = 20_000;

/**
 * P(the moving barrier is touched before the window ends), in sigma units.
 *
 * @param zNow    signed cushion / sigma_T — how far spot already sits on our side
 * @param zTarget Phi^-1(target price) — the barrier height at full remaining vol
 * @param mu      total drift over the remaining window, in sigma units (0 = no view)
 */
export function barrierReachProb(zNow: number, zTarget: number, mu = 0): number {
  if (!Number.isFinite(zNow) || !Number.isFinite(zTarget)) return 0;
  // Already at or through the barrier.
  if (zNow >= zTarget) return 1;

  const kz = Math.round(clip(zNow, -6, 6) * 20) / 20;
  const kt = Math.round(clip(zTarget, -6, 6) * 20) / 20;
  const km = Math.round(clip(mu, -3, 3) * 10) / 10;
  const key = `${kz}|${kt}|${km}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let reached = 0;
  for (let i = 0; i < PATH_GRID.length; i++) {
    const w = PATH_GRID[i]!;
    for (let k = 0; k < STEPS; k++) {
      if (w[k]! + km * U[k]! >= SQRT_1MU[k]! * kt - kz) {
        reached++;
        break;
      }
    }
  }
  const p = reached / PATH_GRID.length;

  if (cache.size >= CACHE_CAP) cache.clear();
  cache.set(key, p);
  return p;
}

export interface ReachInput {
  /**
   * Current mid on the side being bought, 0–1 — the book's own probability.
   *
   * Starting from the mid rather than from Phi(cushion / sigma_T) is deliberate.
   * Our ATR estimate of where the contract *should* trade is regularly cents away
   * from where it does trade, and on the thin-ATR assets it can be tens of cents
   * out: an XRP down-contract quoted at 23¢ scored as 43¢ fair on the ATR model,
   * which reads as free money and is really just a bad volatility estimate.
   * Mode B already learned this and caps confidence near the book.
   *
   * So the market sets the level and the model only describes how that level
   * evolves as remaining volatility drains away. A useful side effect: the
   * calculation stops depending on our ATR at all, which is what makes this a
   * genuinely price-and-clock rule rather than a disguised volatility forecast.
   */
  midNow: number;
  /** What we pay, 0–1. */
  entryAsk: number;
  targetCents: number;
  /** Current ask − bid, 0–1. Charged so the exit marks the bid, not the mid. */
  spread: number;
  /** Optional directional view, in sigma units over the remaining window. */
  driftSigma?: number;
}

/** Highest mid we can model before the book runs out of room. */
const MAX_REACHABLE_MID = 0.985;

/**
 * P(bid reaches entryAsk + targetCents before the window closes).
 * driftSigma = 0 makes this a pure price/time calculation with no directional view.
 */
export function reachProbability(input: ReachInput): number {
  const { midNow, entryAsk, targetCents, spread } = input;
  if (!Number.isFinite(midNow) || midNow <= 0 || midNow >= 1) return 0;

  // We buy the ask and exit on the bid, so the mid has to travel the extra half-spread.
  const targetMid = entryAsk + targetCents / 100 + Math.max(spread, 0) / 2;
  if (targetMid >= MAX_REACHABLE_MID) return 0;
  if (targetMid <= midNow) return 1;

  const zNow = normalInv(clip(midNow, 0.001, 0.999));
  const zTarget = normalInv(clip(targetMid, 0.001, 0.999));
  return barrierReachProb(zNow, zTarget, input.driftSigma ?? 0);
}

/**
 * How far our ATR view sits from the book, in cents on this side.
 *
 * Not traded on — it's the quantity that made the naive model buy 23¢ XRP
 * contracts it thought were worth 43¢. Logged so two weeks of data can settle
 * whether a large disagreement ever predicts anything, or only ever means our
 * volatility estimate is off.
 */
export function modelBookGapCents(args: {
  cushion: number;
  atr1m: number;
  secondsLeft: number;
  midNow: number;
}): number | null {
  const { cushion, atr1m, secondsLeft, midNow } = args;
  if (atr1m <= 0 || secondsLeft <= 0) return null;
  const sigmaT = atr1m * Math.sqrt(Math.max(secondsLeft, 1) / 60);
  if (!Number.isFinite(sigmaT) || sigmaT <= 0) return null;
  const modelMid = normalCdf(cushion / sigmaT);
  return Math.round((modelMid - midNow) * 1000) / 10;
}

/**
 * Seconds until a motionless spot alone lifts the price to the target — the
 * point where sigma_T has shrunk enough that the current cushion clears the
 * barrier. null when convergence can never get there (wrong side, or a target
 * above the 50c line that needs spot to actually move).
 */
export function convergenceEtaSec(input: {
  /** Signed distance from strike toward our side, in price units. */
  cushion: number;
  atr1m: number;
  entryAsk: number;
  targetCents: number;
  spread: number;
}): number | null {
  const { cushion, atr1m, entryAsk, targetCents, spread } = input;
  if (cushion <= 0 || atr1m <= 0) return null;

  const targetMid = entryAsk + targetCents / 100 + Math.max(spread, 0) / 2;
  if (targetMid >= MAX_REACHABLE_MID) return null;

  const zTarget = normalInv(clip(targetMid, 0.001, 0.999));
  if (zTarget <= 0) return null;

  return 60 * Math.pow(cushion / (atr1m * zTarget), 2);
}
