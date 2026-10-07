/**
 * Protocol 13 — bleepblorp 0.1 mid-market, preserved verbatim as the benchmark.
 *
 * This is the only mid-market rule with a convincing track record: 992 settled
 * paper trades over 8.2 days at 68.8% and +1.29¢ expectancy. Everything since
 * has been a tightening of it, and every tightening lost money — protocol 15
 * fell to +0.06¢, 16 to −1.96¢, 17 to −2.67¢. Whatever replaces it has to beat
 * it, so it runs live as its own arm rather than sitting in a report as an
 * eight-day-old number from a different week.
 *
 * Reconstructed from the shipped 0.1 archive (bleepblorp-viewer-2026-08-11.zip),
 * which the journal confirms was PAPER_PROTOCOL 13. The lean function is copied
 * in rather than imported: the shared one in indicators.ts was retuned for chop
 * afterwards, and importing today's version would quietly benchmark against a
 * strategy that never actually traded.
 *
 * Do not "improve" anything in this file. Its only job is to be the thing 0.1 was.
 *
 * The gates are lifted into P13Params so the same rule can also run with a wider
 * aperture as a separate arm. P13_DEFAULTS holds the 0.1 values exactly, and the
 * no-argument call path is unchanged — the parameters exist to be varied by a
 * second caller, never to retune this one.
 */

import { baseFinishProb, sigmaT } from "../indicators";
import { clip, formatCents, formatClock, normalCdf, normalInv } from "../math";
import type {
  ArmId,
  DeltaTarget,
  FactorNote,
  MarketSnapshot,
  ModeARecommendation,
  ModeBRecommendation,
  Side,
} from "../types";

export interface P13Params {
  /** Arm this variant reports as, and how it names itself in the UI. */
  arm: ArmId;
  label: string;
  blurb: string;
  cutoffSec: number;
  minAsk: number;
  maxAsk: number;
  minLean: number;
  minConf: number;
  spreadBuffer: number;
  maxSpread: number;
  targets: DeltaTarget[];
}

/** bleepblorp 0.1 exactly as it shipped and traded. */
export const P13_DEFAULTS: P13Params = {
  arm: "C",
  label: "Control — protocol 13 (0.1)",
  blurb:
    "The shipped bleepblorp 0.1 mid-market rule, running untouched as the benchmark: 992 paper trades at 68.8% and +1.29¢. Any new strategy has to beat this.",
  cutoffSec: 180,
  minAsk: 0.35,
  maxAsk: 0.55,
  minLean: 0.35,
  minConf: 75,
  spreadBuffer: 0.025,
  maxSpread: 0.1,
  targets: [20, 15, 10],
};

/**
 * The same rule with the price band and clock opened up.
 *
 * Replayed over 4,026 recorded ticks, 0.1's lean fires on 73% of them but only
 * 35 become trades, and the largest single cause is the 55¢ ceiling (1,241
 * blocks). The median ask on the side the lean wants is 56¢ — one cent the wrong
 * side of that ceiling — so 0.1 discards over half its own signals on price
 * alone. The lean threshold is deliberately untouched: it is the part with the
 * demonstrated edge, so leaving it fixed makes the aperture the only variable.
 */
export const P13_WIDE: P13Params = {
  ...P13_DEFAULTS,
  arm: "P",
  label: "Wide — protocol 13, opened up",
  blurb:
    "0.1's lean and drift model with the ceiling opened to 85¢, entries allowed to 1:00 and the confidence bar at 60%. Floor stays at 35¢ — the lottery tickets below that were 32% and −3.0¢, and they were never the experiment.",
  cutoffSec: 60,
  minAsk: 0.35,
  maxAsk: 0.85,
  minConf: 60,
};

/** The 0.1 lean, before the mean-reversion retune. */
export function proto13Lean(m: MarketSnapshot): { lean: number; label: string } {
  const rising = m.stochK > m.stochKPrev;
  const falling = m.stochK < m.stochKPrev;

  let mom = 0;
  if (m.stochK >= 45 && m.stochK <= 80 && rising) mom = 0.55;
  else if (m.stochK >= 20 && m.stochK <= 55 && falling) mom = -0.55;
  else if (m.stochK > 55 && rising) mom = 0.35;
  else if (m.stochK < 45 && falling) mom = -0.35;

  const halfWidth = Math.max((m.bbUpper - m.bbLower) / 2, 1e-9);
  const bPos = (m.spot - m.bbMid) / halfWidth;

  let rev = 0;
  const outsideUp = m.spot > m.bbUpper;
  const outsideDown = m.spot < m.bbLower;

  if (m.stochK < 20 && rising) rev = 0.8;
  else if (m.stochK > 80 && falling) rev = -0.8;
  else if (bPos <= -0.8 && !outsideDown) rev = 0.6;
  else if (bPos >= 0.8 && !outsideUp) rev = -0.6;
  else if (outsideDown && rising) rev = 0.4;
  else if (outsideUp && falling) rev = -0.4;

  if (outsideUp && rising) {
    mom = Math.max(mom, 0.7);
    rev = 0;
  } else if (outsideDown && falling) {
    mom = Math.min(mom, -0.7);
    rev = 0;
  }

  const delta = 0.12;
  let lean: number;
  let label: string;

  if (Math.abs(mom) >= Math.abs(rev) + delta) {
    lean = mom;
    label = mom >= 0 ? "Momentum continuation → Up" : "Momentum continuation → Down";
  } else if (Math.abs(rev) > Math.abs(mom) + delta) {
    lean = rev;
    label = rev >= 0 ? "Mean-reversion bounce → Up" : "Mean-reversion fade → Down";
  } else if (Math.abs(mom) < 0.2 && Math.abs(rev) < 0.2) {
    lean = 0;
    label = "No clear indicator lean";
  } else {
    lean = clip(0.5 * mom + 0.5 * rev, -1, 1);
    label = "Mixed signals — soft blend";
  }

  return { lean: clip(lean, -1, 1), label };
}

function p13HitProb(args: {
  m: MarketSnapshot;
  lean: number;
  side: Side;
  ask: number;
  targetCents: DeltaTarget;
}): number {
  const { m, lean, side, ask, targetCents } = args;
  const level = ask + targetCents / 100;
  if (level >= 0.985) return 0;

  const tSec = Math.max(m.secondsLeft, 1);
  const sig = Math.max(m.atr1m * Math.sqrt(tSec / 60), 1e-9);
  const drift = lean * sig;

  if (side === "up") {
    const spotNeeded = m.strike + sig * normalInv(level);
    return normalCdf((m.spot + drift - spotNeeded) / sig);
  }
  const spotCeiling = m.strike + sig * normalInv(1 - level);
  return normalCdf((spotCeiling - (m.spot + drift)) / sig);
}

/** Protocol 13 Mode A. With no params this is 0.1 exactly. */
export function decideModeAProto13(
  m: MarketSnapshot,
  p: P13Params = P13_DEFAULTS,
): ModeARecommendation {
  const { lean, label: leanLabel } = proto13Lean(m);
  const factors: FactorNote[] = [];
  const wait = (reason: string, confidence = 0, side?: Side): ModeARecommendation => ({
    action: "wait",
    side,
    confidence,
    reason,
    factors,
  });

  factors.push({
    id: "arm",
    label: "Arm",
    value: p.label,
    plainEnglish: p.blurb,
  });

  if (m.secondsLeft <= p.cutoffSec) {
    return wait(
      p.arm === "C"
        ? "No new positions — open tickets still tracked."
        : `Under ${formatClock(p.cutoffSec)} — no new entries.`,
    );
  }

  factors.push({
    id: "lean",
    label: "Indicator lean (0.1)",
    value: leanLabel,
    plainEnglish: "Stoch RSI + Bollinger as they were tuned in 0.1, before the chop retune.",
  });

  if (Math.abs(lean) < p.minLean) {
    return wait(
      p.arm === "C"
        ? "Lean too weak for a high-probability Mode A entry — Wait."
        : "Lean too weak for a 0.1 entry — Wait.",
      15,
    );
  }

  const side: Side = lean >= 0 ? "up" : "down";
  const ask = side === "up" ? m.askUp : m.askDown;
  const bid = side === "up" ? m.bidUp : m.bidDown;
  const spread = ask - bid;

  if (ask < p.minAsk) {
    return wait(
      p.arm === "C"
        ? `Ask ${formatCents(ask)} is below 35¢ — mid-market skips thin tickets. Wait.`
        : `Ask ${formatCents(ask)} is below ${formatCents(p.minAsk)} — Wait.`,
      0,
      side,
    );
  }
  if (ask > p.maxAsk) {
    return wait(
      `Ask ${formatCents(ask)} is above the ${formatCents(p.maxAsk)} max entry — Wait.`,
      0,
      side,
    );
  }
  if (spread > p.maxSpread) {
    return wait(
      p.arm === "C"
        ? "Spread too wide for a clean Mode A scalp — Wait."
        : "Spread too wide for a clean 0.1 scalp — Wait.",
      20,
      side,
    );
  }

  let best: { target: DeltaTarget; hitProb: number } | null = null;
  for (const target of p.targets) {
    if (ask + target / 100 >= 0.985) continue;
    if (target / 100 < spread + p.spreadBuffer) continue;
    const hitProb = p13HitProb({ m, lean, side, ask, targetCents: target });
    if (hitProb * 100 < p.minConf) continue;
    best = { target, hitProb };
    break;
  }

  if (!best) {
    const probe = p13HitProb({ m, lean, side, ask, targetCents: 10 });
    return wait(
      `P(hit +10¢) ${(probe * 100).toFixed(0)}% is below ${p.minConf}% — Wait.`,
      probe * 100,
      side,
    );
  }

  const confidence = clip(best.hitProb * 100, 0, 99.9);
  factors.push({
    id: "hit-prob",
    label: "P(hit target)",
    value: `${confidence.toFixed(0)}% for +${best.target}¢`,
    plainEnglish: `Largest of +10/+15/+20 clearing ${p.minConf}%, using the 0.1 drift model.`,
  });
  factors.push({
    id: "clock",
    label: "Time left",
    value: formatClock(m.secondsLeft),
    plainEnglish: `This arm stops opening new entries at ${formatClock(p.cutoffSec)}.`,
  });

  return {
    action: "buy",
    side,
    entryAsk: ask,
    targetCents: best.target,
    expectedDelta: best.target / 100,
    confidence,
    reason:
      p.arm === "C"
        ? `Buy ${side === "up" ? "Up" : "Down"} @ ${formatCents(ask)} — ${confidence.toFixed(0)}% to make +${best.target}¢.`
        : `Buy ${side === "up" ? "Up" : "Down"} @ ${formatCents(ask)} — ${confidence.toFixed(0)}% to make +${best.target}¢ (0.1 wide).`,
    factors,
    arms: p.arm === "C" ? undefined : [p.arm],
  };
}

/** Protocol 13's rule with the widened aperture. */
export function decideModeAProto13Wide(m: MarketSnapshot): ModeARecommendation {
  return decideModeAProto13(m, P13_WIDE);
}

/**
 * Shipped 0.1 Mode B — the veto the Strategist viewer applies to mid-market.
 *
 * Copied from bleepblorp-viewer-2026-08-11. 0.2's live end-of-market rule has
 * since gained a 2:00 cutoff, market-premium cap, and the chop-retuned lean;
 * using that to veto Mode A would make our picks diverge from theirs. This
 * function is not shown in the end-of-market boxes.
 */
const P13_MODE_B = {
  endSec: 15,
  startSec: 480,
  minConf: 0.8,
  highlightConf: 0.85,
  minAsk: 0.85,
  maxAsk: 0.98,
  safetyFloor: 0.5,
} as const;

export function decideModeBProto13(m: MarketSnapshot): ModeBRecommendation {
  const { lean } = proto13Lean(m);
  const factors: FactorNote[] = [];
  const bandLabel = "85–98¢";
  const wait = (
    reason: string,
    confidence: number,
    side?: Side,
  ): ModeBRecommendation => ({
    action: "wait",
    side,
    bandLabel,
    confidence,
    reason,
    factors,
  });

  if (m.secondsLeft <= P13_MODE_B.endSec) {
    return wait("Final seconds — Wait.", 0);
  }

  const sig = sigmaT(m.atr1m, m.secondsLeft);
  let pUp = baseFinishProb(m.spot, m.strike, sig);
  const lambda = Math.min(0.15, m.secondsLeft / 900);
  const pInd = clip(0.5 + 0.12 * lean, 0.05, 0.95);
  pUp = clip((1 - lambda) * pUp + lambda * pInd, 0.02, 0.98);

  const side: Side = pUp >= 0.5 ? "up" : "down";
  const finishProb = side === "up" ? pUp : 1 - pUp;
  const ask = side === "up" ? m.askUp : m.askDown;
  const cushion = Math.abs(m.spot - m.strike);
  const safety = cushion / Math.max(sig, 1e-9);
  const inWindow = m.secondsLeft <= P13_MODE_B.startSec;
  let conf = finishProb;
  if (safety < P13_MODE_B.safetyFloor) {
    conf = Math.min(conf, P13_MODE_B.minConf - 0.05);
  }
  const confPct = conf * 100;

  if (conf >= P13_MODE_B.highlightConf) {
    if (inWindow && ask >= P13_MODE_B.minAsk && ask <= P13_MODE_B.maxAsk) {
      return {
        action: "buy",
        side,
        bandLabel,
        confidence: confPct,
        finishProb,
        safety,
        reason: `Buy ${side === "up" ? "Up" : "Down"} @ ${formatCents(ask)} — ${confPct.toFixed(0)}% confidence.`,
        factors,
      };
    }
    if (inWindow && ask > P13_MODE_B.maxAsk) {
      return {
        action: "hold",
        side,
        bandLabel,
        confidence: confPct,
        finishProb,
        safety,
        reason: `Ask ${formatCents(ask)} is above 98¢ — still safe; no new entry.`,
        factors,
      };
    }
    const why =
      !inWindow && ask < P13_MODE_B.minAsk
        ? "before 8:00 and ask below 85¢"
        : !inWindow
          ? "before 8:00"
          : `ask ${formatCents(ask)} outside 85–98¢`;
    return {
      action: "hold",
      side,
      bandLabel,
      confidence: confPct,
      finishProb,
      safety,
      reason: `${confPct.toFixed(0)}%+ finish confidence — thesis lit (${why}); entry still gated.`,
      factors,
    };
  }

  if (conf < P13_MODE_B.minConf) {
    return wait(
      `Confidence ${confPct.toFixed(0)}% is below ${(P13_MODE_B.minConf * 100).toFixed(0)}% — Wait.`,
      confPct,
      side,
    );
  }

  if (!inWindow) {
    return wait("Mode B starts at the 8:00-to-go mark — Wait.", confPct, side);
  }

  if (ask < P13_MODE_B.minAsk) {
    return wait(
      `Ask ${formatCents(ask)} is below 85¢ — not an end-of-market ticket. Wait.`,
      confPct,
      side,
    );
  }

  if (ask > P13_MODE_B.maxAsk) {
    return {
      action: "hold",
      side,
      bandLabel,
      confidence: confPct,
      finishProb,
      safety,
      reason: `Ask ${formatCents(ask)} is above 98¢ — still safe; no new entry.`,
      factors,
    };
  }

  return {
    action: "buy",
    side,
    bandLabel,
    confidence: confPct,
    finishProb,
    safety,
    reason: `Buy ${side === "up" ? "Up" : "Down"} @ ${formatCents(ask)} — ${confPct.toFixed(0)}% confidence.`,
    factors,
  };
}
