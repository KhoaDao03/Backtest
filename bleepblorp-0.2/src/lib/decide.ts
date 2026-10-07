import {
  baseFinishProb,
  indicatorLean,
  marketAsleep,
  sigmaT,
  type LeanKind,
} from "./indicators";
import { approvingArms, evaluateArms, signedCushion } from "./arms";
import { convergenceEtaSec } from "./convergence";
import { decideModeAProto13, decideModeAProto13Wide, decideModeBProto13 } from "./legacy/proto13";
import { modeAHitProb } from "./modeAHitProb";
import { signedCushionBps } from "./trend";
import {
  ARM_IDS,
  ARM_LABELS,
  MODE_A_ASLEEP_ATR_RATIO,
  MODE_A_CUTOFF_SEC,
  MODE_A_EARLY_REACH_PROB,
  MODE_A_EARLY_SEC,
  MODE_A_EXPLORER,
  SCANNER_ARMS,
  MODE_A_EXPLORER_MAX_SPREAD,
  MODE_A_EXPLORER_MIN_ASK,
  MODE_A_EXPLORER_MIN_SEC,
  MODE_A_HARD_MIN_ASK,
  MODE_A_LIVE_TARGETS,
  MODE_A_TP_SIZING_ENABLED,
  MODE_A_FIXED_TP,
  MODE_A_REV_ENABLED,
  MODE_A_MAX_ASK,
  MODE_A_MIN_ASK,
  MODE_A_MIN_CONF,
  MODE_A_MIN_LEAN,
  MODE_A_MIN_REACH_PROB,
  MODE_A_MOM_MAX_CUSHION_BPS,
  MODE_A_MOM_MIN_CUSHION_BPS,
  MODE_A_MOM_MIN_SEC,
  MODE_A_REV_MAX_ASK,
  MODE_A_REV_MIN_ASK,
  MODE_A_REV_MIN_LEAN,
  MODE_A_REV_MIN_SEC,
  MODE_A_SPREAD_BUFFER,
  MODE_B_END_SEC,
  MODE_B_HIGHLIGHT_CONF,
  MODE_B_MARKET_PREMIUM,
  MODE_B_MARKET_PREMIUM_MAJOR,
  MODE_B_MAX_ASK,
  MODE_B_MIN_ASK,
  MODE_B_MIN_CONF,
  MODE_B_SAFETY_FLOOR,
  MODE_B_SIGMA_MULT,
  MODE_B_START_SEC,
  isMajorAsset,
  type ArmId,
  type DecisionResult,
  type DeltaTarget,
  type FactorNote,
  type MarketSnapshot,
  type ModeARecommendation,
  type ModeBRecommendation,
  type Side,
} from "./types";
import { clip, formatCents, formatClock, normalCdf } from "./math";

/** Largest-first so we pick the biggest scalp that clears the hit bar. */
/** Explorer / legacy Mode A TP bank — fixed +20¢ (matches live mid policy). */
const MODE_A_TARGETS: DeltaTarget[] = [MODE_A_FIXED_TP];

/**
 * Previous live Mode A (chop-retuned lean, 40–55¢ band). Rec boxes now show
 * shipped 0.1 via decideModeAProto13; this path is kept for replay and as the
 * non-explorer fallback in git history.
 */
function decideModeA(
  m: MarketSnapshot,
  lean: number,
  leanLabel: string,
  leanKind: LeanKind,
): ModeARecommendation {
  const factors: FactorNote[] = [];
  const wait = (reason: string, confidence = 0, side?: Side): ModeARecommendation => ({
    action: "wait",
    side,
    confidence,
    reason,
    factors,
  });

  if (m.secondsLeft <= MODE_A_CUTOFF_SEC) {
    factors.push({
      id: "clock",
      label: "Clock",
      value: "≤ 3:00",
      plainEnglish:
        "Under 3 minutes — no new Mode A entries. Open paper tickets keep tracking for Δ hits.",
    });
    return wait("No new positions — open tickets still tracked.");
  }

  const atrBps = (m.atr1m / Math.max(m.spot, 1e-9)) * 10_000;
  const asleep = marketAsleep(m, MODE_A_ASLEEP_ATR_RATIO);
  factors.push({
    id: "vol-regime",
    label: "Vol regime",
    value: asleep
      ? `Asleep · ATR ${atrBps.toFixed(1)} bps`
      : `Active · ATR ${atrBps.toFixed(1)} bps`,
    plainEnglish: asleep
      ? "1m ATR is too thin vs spot for a mid-market Δ scalp. Slow slides fake Stoch leans and overstate hit odds — Mode A waits."
      : "Enough 1m path vs spot for mid-market Δ targets to be reachable.",
  });
  if (asleep) {
    return wait(
      "Market asleep — vol too thin for a mid-market scalp. Wait.",
      10,
    );
  }

  const cushion = m.spot - m.strike;
  const sigNow = sigmaT(m.atr1m, m.secondsLeft);
  const expectedMove = lean * sigNow;
  const isReversion = leanKind === "reversion";
  const minLean = isReversion ? MODE_A_REV_MIN_LEAN : MODE_A_MIN_LEAN;
  const minAsk = isReversion ? MODE_A_REV_MIN_ASK : MODE_A_MIN_ASK;
  const maxAsk = isReversion ? MODE_A_REV_MAX_ASK : MODE_A_MAX_ASK;

  factors.push({
    id: "trade-window",
    label: "Time left",
    value: formatClock(m.secondsLeft),
    plainEnglish:
      "Hit odds use the remaining window. New mid-market entries stop at 3:00; open tickets still track after.",
  });
  factors.push({
    id: "vs-strike",
    label: "Vs strike",
    value: `${cushion >= 0 ? "+" : ""}${cushion.toFixed(2)}`,
    plainEnglish: "How far spot sits from the strike — bigger gaps need more path to reprice the contract.",
  });
  factors.push({
    id: "lean",
    label: "Indicator lean",
    value: leanLabel,
    plainEnglish: isReversion
      ? "BB/RSI chop fade — Mode A uses the wider 40–55¢ reversion ask band."
      : "Stoch RSI + Bollinger set the expected direction of the next spot move.",
  });
  factors.push({
    id: "path",
    label: "Mode A path",
    value: isReversion
      ? "Mean-reversion chop"
      : leanKind === "momentum"
        ? "Momentum"
        : leanKind,
    plainEnglish: isReversion
      ? "Reversion path: clearer lean (≥0.45) and ask 40–55¢ so band fades can still enter."
      : "Momentum path: ask 45–52¢ (protocol-15 expectancy band).",
  });
  factors.push({
    id: "proj-move",
    label: "Expected spot move",
    value: `${expectedMove >= 0 ? "+" : ""}${expectedMove.toFixed(2)} over ${formatClock(m.secondsLeft)}`,
    plainEnglish: "Lean-scaled move using remaining-time volatility (ATR path).",
  });

  if (Math.abs(lean) < minLean) {
    return wait(
      isReversion
        ? "Reversion lean too soft for the chop path — Wait."
        : "Lean too weak for a high-probability Mode A entry — Wait.",
      15,
    );
  }

  // Side follows the lean — we only scalp the direction we actually expect.
  const side: Side = lean >= 0 ? "up" : "down";
  const ask = side === "up" ? m.askUp : m.askDown;
  const bid = side === "up" ? m.bidUp : m.bidDown;
  const spread = ask - bid;

  factors.push({
    id: "ask",
    label: "Entry ask",
    value: formatCents(ask),
    plainEnglish: isReversion
      ? "Reversion entries allow 40–55¢ (fade often prints after the cheap ask moved)."
      : "Momentum entries stay in 45–52¢.",
  });

  if (ask < minAsk) {
    return wait(
      `Ask ${formatCents(ask)} is below ${Math.round(minAsk * 100)}¢ — mid-market skips thin tickets. Wait.`,
      0,
      side,
    );
  }

  if (ask > maxAsk) {
    return wait(
      `Ask ${formatCents(ask)} is above the ${Math.round(maxAsk * 100)}¢ max entry — Wait.`,
      0,
      side,
    );
  }

  if (spread > 0.1) {
    return wait("Spread too wide for a clean Mode A scalp — Wait.", 20, side);
  }

  // Largest target with hit chance ≥ MODE_A_MIN_CONF (no expectancy picker).
  let best: { target: DeltaTarget; hitProb: number } | null = null;
  let anyReachable = false;
  for (const target of MODE_A_TARGETS) {
    if (ask + target / 100 >= 0.985) continue;
    anyReachable = true;
    if (target / 100 < spread + MODE_A_SPREAD_BUFFER) continue;
    const hitProb = modeAHitProb({ m, lean, side, ask, targetCents: target });
    if (hitProb * 100 < MODE_A_MIN_CONF) continue;
    best = { target, hitProb };
    break; // MODE_A_TARGETS is largest-first
  }

  const probe10 = modeAHitProb({ m, lean, side, ask, targetCents: 10 });
  factors.push({
    id: "hit-prob",
    label: "P(hit target)",
    value: best
      ? `${(best.hitProb * 100).toFixed(0)}% for +${best.target}¢`
      : !anyReachable
        ? `no reachable target @ ${formatCents(ask)}`
        : `${(probe10 * 100).toFixed(0)}% for +10¢ (need ≥${MODE_A_MIN_CONF}%)`,
    plainEnglish:
      `Chance the contract rises by the target before the window ends. Fixed +${MODE_A_FIXED_TP}¢ TP, no stop.`,
  });

  if (!anyReachable && !best) {
    return wait(
      `Ask ${formatCents(ask)} can’t reach a +10/+15/+20¢ target before 98.5¢ — Wait.`,
      0,
      side,
    );
  }

  if (!best) {
    return wait(
      `P(hit +10¢) ${(probe10 * 100).toFixed(0)}% is below ${MODE_A_MIN_CONF}% — Wait.`,
      probe10 * 100,
      side,
    );
  }

  const confidence = clip(best.hitProb * 100, 0, 99.9);
  return {
    action: "buy",
    side,
    entryAsk: ask,
    targetCents: best.target,
    expectedDelta: best.target / 100,
    confidence,
    reason: isReversion
      ? `Buy ${side === "up" ? "Up" : "Down"} @ ${formatCents(ask)} — chop fade ${confidence.toFixed(0)}% to make +${best.target}¢.`
      : `Buy ${side === "up" ? "Up" : "Down"} @ ${formatCents(ask)} — ${confidence.toFixed(0)}% to make +${best.target}¢.`,
    factors,
  };
}

/**
 * Explorer Mode A (protocol 18) — the data-collection strategy.
 *
 * No ask band and no directional prerequisite: any price with room for a +10¢
 * gain is a candidate on both sides, and the entry fires when any arm believes
 * in it. Entries run down to 1:00 rather than stopping at 3:00, because replay
 * put the best expectancy on rich contracts inside the last few minutes.
 *
 * Selection here is intentionally loose. The point of the run is to map where
 * the edge actually is, and a tight rule can only ever confirm what it already
 * assumes.
 */
function decideModeAExplorer(
  m: MarketSnapshot,
  lean: number,
  leanLabel: string,
  control: ModeARecommendation,
  wide: ModeARecommendation,
): ModeARecommendation {
  const factors: FactorNote[] = [];
  const wait = (reason: string, confidence = 0, side?: Side): ModeARecommendation => ({
    action: "wait",
    side,
    confidence,
    reason,
    factors,
  });

  factors.push({
    id: "explorer",
    label: "Mode A mode",
    value: "Explorer — collecting",
    plainEnglish:
      "Mid-market is in data-collection mode. It bids anything it believes can gain 10¢ or more, at any price, and logs the result. Expect a lot of entries and a rough PnL while the surface is mapped.",
  });

  if (m.secondsLeft < MODE_A_EXPLORER_MIN_SEC) {
    factors.push({
      id: "clock",
      label: "Clock",
      value: `< ${MODE_A_EXPLORER_MIN_SEC}s`,
      plainEnglish: "Too little time left for a Δ to print. Open tickets keep tracking.",
    });
    return wait("Under a minute — no new entries.");
  }

  type Candidate = {
    side: Side;
    target: DeltaTarget;
    ask: number;
    bid: number;
    verdicts: ReturnType<typeof evaluateArms>;
    arms: ArmId[];
    score: number;
  };

  const candidates: Candidate[] = [];
  let bestStrippedProbe = 0;
  let probeSide: Side | undefined;

  for (const side of ["up", "down"] as Side[]) {
    const ask = side === "up" ? m.askUp : m.askDown;
    const bid = side === "up" ? m.bidUp : m.bidDown;
    const spread = ask - bid;
    if (!Number.isFinite(ask) || !Number.isFinite(bid)) continue;
    if (ask < MODE_A_EXPLORER_MIN_ASK || ask >= 1) continue;
    if (spread > MODE_A_EXPLORER_MAX_SPREAD || spread < 0) continue;

    for (const target of MODE_A_TARGETS) {
      const verdicts = evaluateArms({
        m,
        side,
        targetCents: target,
        lean,
        control,
        wide,
      });
      if (target === 10 && verdicts.S.prob > bestStrippedProbe) {
        bestStrippedProbe = verdicts.S.prob;
        probeSide = side;
      }
      const arms = approvingArms(verdicts);
      if (!arms.length) continue;
      candidates.push({
        side,
        target,
        ask,
        bid,
        verdicts,
        arms,
        score: Math.max(...arms.map((id) => verdicts[id].prob)),
      });
      // MODE_A_TARGETS is largest-first — keep the biggest Δ this side supports.
      break;
    }
  }

  const atrBps = (m.atr1m / Math.max(m.spot, 1e-9)) * 10_000;
  factors.push({
    id: "vol-regime",
    label: "Vol regime",
    value: `ATR ${atrBps.toFixed(1)} bps`,
    plainEnglish:
      "1m volatility versus spot. Explorer does not sit out quiet markets — thin-vol entries are logged too, so we can find out whether skipping them was ever right.",
  });

  if (!candidates.length) {
    factors.push({
      id: "hit-prob",
      label: "Best P(+10¢)",
      value: `${(bestStrippedProbe * 100).toFixed(0)}% (need ≥${(MODE_A_MIN_REACH_PROB * 100).toFixed(0)}%)`,
      plainEnglish:
        "Highest reach probability across both sides. No arm believes in a ticket here.",
    });
    return wait(
      `No arm clears ${(MODE_A_MIN_REACH_PROB * 100).toFixed(0)}% — best is ${(bestStrippedProbe * 100).toFixed(0)}% for +10¢. Wait.`,
      bestStrippedProbe * 100,
      probeSide,
    );
  }

  candidates.sort((a, b) => b.score - a.score || b.target - a.target);
  const pick = candidates[0]!;
  const cushion = signedCushion(m, pick.side);
  const eta = convergenceEtaSec({
    cushion,
    atr1m: m.atr1m,
    entryAsk: pick.ask,
    targetCents: pick.target,
    spread: pick.ask - pick.bid,
  });

  const armProbs: Partial<Record<ArmId, number>> = {};
  for (const id of ARM_IDS) armProbs[id] = pick.verdicts[id].prob;

  factors.push({
    id: "vs-strike",
    label: "Vs strike",
    value: `${cushion >= 0 ? "+" : ""}${cushion.toFixed(2)} toward ${pick.side === "up" ? "Up" : "Down"}`,
    plainEnglish:
      "Distance from the strike measured toward the side we're buying. A positive cushion is what lets time decay lift the price without spot moving at all.",
  });
  factors.push({
    id: "convergence-eta",
    label: "Time-decay ETA",
    value:
      eta === null
        ? "n/a — needs spot to move"
        : eta <= m.secondsLeft
          ? `${formatClock(eta)} (fits)`
          : `${formatClock(eta)} (past close)`,
    plainEnglish:
      "How long until shrinking volatility alone would lift the price to target with spot frozen. Inside the remaining window means the trade can win on the clock rather than on a call about direction.",
  });
  factors.push({
    id: "arms",
    label: "Arms backing",
    value: pick.arms.map((id) => ARM_LABELS[id]).join(", "),
    plainEnglish: `${SCANNER_ARMS.map(
      (id) => `${ARM_LABELS[id]} ${(pick.verdicts[id].prob * 100).toFixed(0)}%`,
    ).join(" · ")} · 0.1 control ${
      pick.verdicts.C.take ? "agrees" : "declines"
    } · 0.1 wide ${pick.verdicts.P.take ? "agrees" : "declines"}`,
  });
  factors.push({
    id: "lean",
    label: "Indicator lean",
    value: leanLabel,
    plainEnglish:
      "Shown for the Indicators arm only. The Stripped arm ignores this entirely, which is the comparison being run.",
  });
  factors.push({
    id: "ask",
    label: "Entry ask",
    value: formatCents(pick.ask),
    plainEnglish:
      "Explorer has no price band. Replay showed the old 40–55¢ band was the worst zone on the board and the 70–90¢ zone the best.",
  });

  const confidence = clip(pick.score * 100, 0, 99.9);
  return {
    action: "buy",
    side: pick.side,
    entryAsk: pick.ask,
    targetCents: pick.target,
    expectedDelta: pick.target / 100,
    confidence,
    reason: `Buy ${pick.side === "up" ? "Up" : "Down"} @ ${formatCents(pick.ask)} — ${confidence.toFixed(0)}% to make +${pick.target}¢ (${pick.arms.map((id) => ARM_LABELS[id]).join("+")}).`,
    factors,
    arms: pick.arms,
    armProbs,
    etaSec: eta,
  };
}

/**
 * Explorer mid-market lane — single live book = momentum continuation.
 * Momentum: on-side 2–15 bps, Stoch confirming, ≥6:00 left.
 * Targets: TP sizing on (+10 first); reversion parked via MODE_A_REV_ENABLED.
 * 75% hit bar while the mom window is open. No stop.
 */
function decideModeALane(
  m: MarketSnapshot,
  lean: number,
  leanLabel: string,
  leanKind: LeanKind,
  lane: "momentum" | "reversion",
): ModeARecommendation {
  const factors: FactorNote[] = [];
  const wait = (reason: string, confidence = 0, side?: Side): ModeARecommendation => ({
    action: "wait",
    side,
    confidence,
    reason,
    factors,
  });

  const laneLabel =
    lane === "momentum" ? "momentum continuation" : "mean reversion";

  if (lane === "reversion" && !MODE_A_REV_ENABLED) {
    return wait("Mean reversion mid-market parked — momentum-only board.", 0);
  }

  factors.push({
    id: "lane",
    label: "Lane",
    value: lane === "momentum" ? "Momentum continuation" : "Mean reversion",
    plainEnglish:
      "Each lean kind is its own book. Mixed and no-lean ticks sit both lanes out.",
  });

  if (leanKind !== lane) {
    const sit =
      leanKind === "momentum"
        ? "Lean is momentum continuation — mean reversion sits out."
        : leanKind === "reversion"
          ? "Lean is mean reversion — momentum sits out."
          : leanKind === "mixed"
            ? "Mixed signals — this lane sits out."
            : "No clear indicator lean — this lane sits out.";
    return wait(sit, 0);
  }

  const minSec = lane === "momentum" ? MODE_A_MOM_MIN_SEC : MODE_A_REV_MIN_SEC;
  if (m.secondsLeft < minSec) {
    factors.push({
      id: "clock",
      label: "Clock",
      value: "< " + formatClock(minSec),
      plainEnglish:
        lane === "momentum"
          ? "Momentum only enters with ≥6:00 left — late-window fills bled E."
          : "Reversion only enters with ≥8:00 left — late-window fills were −15¢ E.",
    });
    return wait(
      lane === "momentum"
        ? "Under six minutes — momentum waits."
        : "Under eight minutes — reversion waits.",
    );
  }

  if (Math.abs(lean) < 1e-9) {
    return wait("No clear indicator lean — this lane sits out.");
  }

  const side: Side = lean >= 0 ? "up" : "down";
  const ask = side === "up" ? m.askUp : m.askDown;
  const bid = side === "up" ? m.bidUp : m.bidDown;
  const spread = ask - bid;

  if (!Number.isFinite(ask) || !Number.isFinite(bid)) {
    return wait("No book on the lean side — Wait.");
  }
  if (ask < MODE_A_HARD_MIN_ASK || ask >= 1) {
    return wait(
      ask < MODE_A_HARD_MIN_ASK
        ? "Ask below 35¢ — lottery tickets sit out."
        : "Ask is fully priced — Wait.",
      0,
      side,
    );
  }
  if (lane === "reversion" && ask > MODE_A_REV_MAX_ASK) {
    return wait(
      "Ask " + formatCents(ask) + " above " + Math.round(MODE_A_REV_MAX_ASK * 100) + "¢ — reversion stays ≤55¢.",
      0,
      side,
    );
  }
  if (spread > MODE_A_EXPLORER_MAX_SPREAD || spread < 0) {
    return wait("Spread too wide — Wait.", 0, side);
  }

  const cushion = signedCushion(m, side);
  const cushBps = signedCushionBps(m, side);

  if (lane === "reversion") {
    if (cushion <= 0) {
      factors.push({
        id: "vs-strike",
        label: "Vs strike",
        value: (cushion >= 0 ? "+" : "") + cushion.toFixed(2) + " toward " + (side === "up" ? "Up" : "Down"),
        plainEnglish:
          "Mean reversion only trades on-side decay — wrong-side fades are blocked.",
      });
      return wait("Wrong side of strike — reversion only trades on-side decay.", 0, side);
    }
  } else if (cushion <= 0) {
    factors.push({
      id: "vs-strike",
      label: "Vs strike",
      value: (cushion >= 0 ? "+" : "") + cushion.toFixed(2) + " toward " + (side === "up" ? "Up" : "Down"),
      plainEnglish: "Momentum needs spot already on-side of the strike.",
    });
    return wait("Wrong side of strike — momentum needs spot on-side of the run.", 0, side);
  } else if (cushBps < MODE_A_MOM_MIN_CUSHION_BPS) {
    return wait("Run not started — need spot at least 2 bps on-side of strike.", 0, side);
  } else if (cushBps > MODE_A_MOM_MAX_CUSHION_BPS) {
    return wait(
      "Run extended (" + cushBps.toFixed(1) + " bps) — momentum caps at " + MODE_A_MOM_MAX_CUSHION_BPS + " bps.",
      0,
      side,
    );
  }

  if (lane === "momentum" && !momStochConfirms(m, side)) {
    return wait(
      side === "up"
        ? "Stoch below 45 — up continuation not confirmed."
        : "Stoch outside 25–55 — down continuation not confirmed.",
      10,
      side,
    );
  }

  const minReach =
    m.secondsLeft >= MODE_A_EARLY_SEC
      ? MODE_A_EARLY_REACH_PROB
      : MODE_A_MIN_REACH_PROB;

  const targets: DeltaTarget[] = MODE_A_TP_SIZING_ENABLED
    ? MODE_A_LIVE_TARGETS
    : [MODE_A_FIXED_TP];

  let bestProb = 0;
  for (const target of targets) {
    if (ask + target / 100 >= 0.985) continue;
    if (target / 100 < spread + MODE_A_SPREAD_BUFFER) continue;

    const hitProb = modeAHitProb({ m, lean, side, ask, targetCents: target });
    bestProb = Math.max(bestProb, hitProb);
    if (hitProb < minReach) continue;

    const eta = convergenceEtaSec({
      cushion,
      atr1m: m.atr1m,
      entryAsk: ask,
      targetCents: target,
      spread,
    });
    const confidence = clip(hitProb * 100, 0, 99.9);
    factors.push({
      id: "vs-strike",
      label: "Vs strike",
      value: (cushion >= 0 ? "+" : "") + cushion.toFixed(2) + " (" + cushBps.toFixed(1) + " bps)",
      plainEnglish:
        lane === "reversion"
          ? "On-side decay — vol drain can lift the contract toward target."
          : "Spot on-side 2–15 bps — strike geometry included in P(hit).",
    });
    factors.push({
      id: "lean",
      label: "Indicator lean",
      value: leanLabel,
      plainEnglish: "This " + laneLabel + " rec only fires when Stoch RSI / Bollinger print this kind.",
    });
    factors.push({
      id: "ask",
      label: "Entry ask",
      value: formatCents(ask),
      plainEnglish:
        lane === "reversion"
          ? "Reversion band 35–55¢."
          : "Floor 35¢; no ceiling besides a fully priced contract.",
    });
    factors.push({
      id: "tp",
      label: "Take profit",
      value: `+${target}¢`,
      plainEnglish: MODE_A_TP_SIZING_ENABLED
        ? "Largest of +10/+15/+20 that clears the hit bar (smallest-first scan)."
        : `Fixed +${MODE_A_FIXED_TP}¢ TP (sizing bank off). No stop.`,
    });
    return {
      action: "buy",
      side,
      entryAsk: ask,
      targetCents: target,
      expectedDelta: target / 100,
      confidence,
      reason:
        "Buy " +
        (side === "up" ? "Up" : "Down") +
        " @ " +
        formatCents(ask) +
        " — " +
        confidence.toFixed(0) +
        "% to make +" +
        target +
        "¢ (" +
        laneLabel +
        ").",
      factors,
      arms: ["I"],
      armProbs: { I: hitProb },
      etaSec: eta,
    };
  }

  factors.push({
    id: "hit-prob",
    label: "Best P(hit)",
    value: (bestProb * 100).toFixed(0) + "% (need ≥" + (minReach * 100).toFixed(0) + "%)",
    plainEnglish: MODE_A_TP_SIZING_ENABLED
      ? "Strike-aware reach on +10/+15/+20 (smallest first). Mom window uses a 75% bar."
      : `Strike-aware reach on fixed +${MODE_A_FIXED_TP}¢. Mom window uses a 75% bar.`,
  });
  return wait(
    "P(hit) " +
      (bestProb * 100).toFixed(0) +
      "% is below " +
      (minReach * 100).toFixed(0) +
      "% — Wait.",
    bestProb * 100,
    side,
  );
}

/** Proto 29 momentum Stoch zone — blocks washed-out down leans (proto 28 −10.9¢). */
function momStochConfirms(m: MarketSnapshot, side: Side): boolean {
  if (side === "up") return m.stochK >= 45;
  return m.stochK >= 25 && m.stochK <= 55;
}


function decideModeB(m: MarketSnapshot, lean: number): ModeBRecommendation {
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

  // Finish confidence is always scored for the full 15m window so the Trade /
  // End-mkt box can keep updating. Buy/Hold entry actions stay gated below.
  const sig =
    sigmaT(m.atr1m, m.secondsLeft) * (MODE_B_SIGMA_MULT[m.symbol] ?? 1);
  let pUp = baseFinishProb(m.spot, m.strike, sig);

  // Light indicator nudge that fades as time runs out
  const lambda = Math.min(0.15, m.secondsLeft / 900);
  const pInd = clip(0.5 + 0.12 * lean, 0.05, 0.95);
  pUp = clip((1 - lambda) * pUp + lambda * pInd, 0.02, 0.98);

  const side: Side = pUp >= 0.5 ? "up" : "down";
  const finishProb = side === "up" ? pUp : 1 - pUp;
  const ask = side === "up" ? m.askUp : m.askDown;
  const bid = side === "up" ? m.bidUp : m.bidDown;
  const cushion = Math.abs(m.spot - m.strike);
  const safety = cushion / Math.max(sig, 1e-9);
  /** New entries from 8:00 left through the final second before flatten. */
  const inEntryWindow =
    m.secondsLeft <= MODE_B_START_SEC &&
    m.secondsLeft > MODE_B_END_SEC;
  const marketMid = clip((bid + ask) / 2, 0.01, 0.99);
  const marketPremium = isMajorAsset(m.symbol)
    ? MODE_B_MARKET_PREMIUM_MAJOR
    : MODE_B_MARKET_PREMIUM;
  const marketCap = clip(marketMid + marketPremium, 0.02, 0.98);

  factors.push({
    id: "finish-prob",
    label: "Finish probability",
    value: `${(finishProb * 100).toFixed(0)}% ${side.toUpperCase()}`,
    plainEnglish:
      "Chance spot finishes on this side of the strike given distance left and current volatility.",
  });
  factors.push({
    id: "market-implied",
    label: "Kalshi mid",
    value: formatCents(marketMid),
    plainEnglish:
      "Live book mid on this side — treated as a strong probability check from market makers/bots.",
  });
  factors.push({
    id: "safety",
    label: "Vol cushion",
    value: `${safety.toFixed(2)}× ATR path`,
    plainEnglish:
      "How many typical remaining moves fit between spot and strike. Thin cushion = coin flip.",
  });
  factors.push({
    id: "ask",
    label: "Live book",
    value: `bid ${formatCents(bid)} / ask ${formatCents(ask)}`,
    plainEnglish:
      "Maker entries when the best bid is 85–98¢ in the Mode B window (8:00→end); wide ask gaps no longer block a legal bid under 98¢. Box can light earlier at ≥85% finish conf.",
  });
  factors.push({
    id: "window",
    label: "Mode B window",
    value: inEntryWindow
      ? "Open (8:00→end)"
      : m.secondsLeft > MODE_B_START_SEC
        ? "Before 8:00 — highlight only"
        : "Final second",
    plainEnglish:
      "New entries from eight minutes left through the end of the window. No new entries in the final second. Confidence keeps updating until expiry.",
  });

  let conf = finishProb;
  if (safety < MODE_B_SAFETY_FLOOR) {
    conf = Math.min(conf, MODE_B_MIN_CONF - 0.05);
    factors.push({
      id: "safety-clamp",
      label: "Safety clamp",
      value: `Forced below ${(MODE_B_MIN_CONF * 100).toFixed(0)}%`,
      plainEnglish: "Spot is too close to the strike vs volatility — treating this as Wait.",
    });
  }

  // Respect the book: do not advertise confidence far above Kalshi implied.
  if (conf > marketCap) {
    const before = conf;
    conf = marketCap;
    factors.push({
      id: "market-respect",
      label: "Market respect",
      value: `${(before * 100).toFixed(0)}% → ${(conf * 100).toFixed(0)}% (cap mid+${(marketPremium * 100).toFixed(0)}¢)`,
      plainEnglish:
        "Model finish odds were well above the live Kalshi mid. Confidence is capped near the book — a large gap usually means our model is overconfident, not that the market is wrong.",
    });
  }

  const confPct = conf * 100;
  const minBuyConf = MODE_B_MIN_CONF;

  if (m.secondsLeft <= MODE_B_END_SEC) {
    factors.push({
      id: "clock",
      label: "Clock",
      value: `≤ ${MODE_B_END_SEC}s`,
      plainEnglish: "Final seconds — no new entries; confidence still updates.",
    });
    return wait("Final seconds — Wait.", confPct, side);
  }

  // Thesis highlight: ≥85% lights the box even before 8:00 or below 85¢ bid.
  // Paper/live buy still needs entry window + bid band + asset min conf.
  // Band is on the best bid (what we pay as maker), not the ask — alts often
  // print ask >98¢ while the joinable bid is still inside 85–98¢.
  const bidInBand =
    Number.isFinite(bid) &&
    bid > 0 &&
    bid >= MODE_B_MIN_ASK &&
    bid <= MODE_B_MAX_ASK;
  if (conf >= MODE_B_HIGHLIGHT_CONF) {
    if (inEntryWindow && bidInBand && conf >= minBuyConf) {
      return {
        action: "buy",
        side,
        bandLabel,
        confidence: confPct,
        finishProb,
        safety,
        reason: `Buy ${side === "up" ? "Up" : "Down"} @ bid ${formatCents(bid)} (ask ${formatCents(ask)}) — ${confPct.toFixed(0)}% confidence.`,
        factors,
      };
    }
    if (inEntryWindow && bidInBand && conf < minBuyConf) {
      return wait(
        `Confidence ${confPct.toFixed(0)}% is below ${(minBuyConf * 100).toFixed(0)}% for ${m.symbol} — Wait.`,
        confPct,
        side,
      );
    }
    if (inEntryWindow && Number.isFinite(bid) && bid > MODE_B_MAX_ASK) {
      return {
        action: "hold",
        side,
        bandLabel,
        confidence: confPct,
        finishProb,
        safety,
        reason: `Bid ${formatCents(bid)} is above 98¢ — still safe; no new entry.`,
        factors,
      };
    }
    // Early clock and/or bid outside the buy band — highlight only, no paper.
    const why =
      m.secondsLeft > MODE_B_START_SEC && bid > 0 && bid < MODE_B_MIN_ASK
        ? "before 8:00 and bid below 85¢"
        : m.secondsLeft > MODE_B_START_SEC
          ? "before 8:00"
          : `bid ${formatCents(bid)} outside 85–98¢`;
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

  // Below highlight bar: paper buy can still fire at ≥ minBuyConf inside the entry window/band.
  if (conf < minBuyConf) {
    return wait(
      `Confidence ${confPct.toFixed(0)}% is below ${(minBuyConf * 100).toFixed(0)}% — Wait.`,
      confPct,
      side,
    );
  }

  if (!inEntryWindow) {
    return wait("Mode B starts at the 8:00-to-go mark — Wait.", confPct, side);
  }

  if (!(Number.isFinite(bid) && bid > 0) || bid < MODE_B_MIN_ASK) {
    return wait(
      `Bid ${formatCents(bid)} is below 85¢ — not an end-of-market ticket. Wait.`,
      confPct,
      side,
    );
  }

  if (bid > MODE_B_MAX_ASK) {
    return {
      action: "hold",
      side,
      bandLabel,
      confidence: confPct,
      finishProb,
      safety,
      reason: `Bid ${formatCents(bid)} is above 98¢ — still safe; no new entry.`,
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
    reason: `Buy ${side === "up" ? "Up" : "Down"} @ bid ${formatCents(bid)} (ask ${formatCents(ask)}) — ${confPct.toFixed(0)}% confidence.`,
    factors,
  };
}

export function decide(m: MarketSnapshot): DecisionResult {
  const sig = sigmaT(m.atr1m, m.secondsLeft);
  const z = (m.spot - m.strike) / Math.max(sig, 1e-9);
  const pUp = baseFinishProb(m.spot, m.strike, sig);
  const { lean, label, kind } = indicatorLean(m);
  const cushion = Math.abs(m.spot - m.strike);
  const expectedMove = sig;

  const modeAMom = decideModeALane(m, lean, label, kind, "momentum");
  const modeARev = decideModeALane(m, lean, label, kind, "reversion");
  const modeB01 = decideModeBProto13(m);

  return reconcileModeSides({
    modeA: modeAMom,
    modeAMom,
    modeARev,
    modeB: decideModeB(m, lean),
    modeB01,
    indicators: {
      z,
      sigmaT: sig,
      pUp,
      lean,
      leanLabel: label,
      cushion,
      expectedMove,
    },
  });
}

/**
 * Viewer overlay: drop a Mode A Buy that fights a live Mode B finish.
 *
 * While mid-market lanes are independent of end-of-market we skip this —
 * vetoing against Mode B Hold (including the pre-8:00 thesis highlight)
 * kept every mid-market box on Wait. 0.2 end-of-market still shows on modeB.
 */
export function reconcileModeSides(decision: DecisionResult): DecisionResult {
  if (MODE_A_EXPLORER) return decision;

  const { modeA, modeB } = decision;
  const modeBLive = modeB.action === "buy" || modeB.action === "hold";
  if (
    modeA.action !== "buy" ||
    !modeBLive ||
    !modeA.side ||
    !modeB.side ||
    modeA.side === modeB.side
  ) {
    return decision;
  }

  return {
    ...decision,
    modeA: {
      action: "wait",
      side: modeA.side,
      confidence: modeA.confidence,
      reason: `Mode A ${modeA.side === "up" ? "Up" : "Down"} fights Mode B finish ${modeB.side === "up" ? "Up" : "Down"} — Wait.`,
      factors: [
        ...modeA.factors.filter((f) => f.id !== "side-conflict"),
        {
          id: "side-conflict",
          label: "Side conflict",
          value: `A ${modeA.side} ≠ B ${modeB.side}`,
          plainEnglish:
            "Mode B is the settlement call. We do not scalp the other side while that call is live.",
        },
      ],
    },
  };
}
