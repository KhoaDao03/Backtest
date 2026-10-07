import { ARM_IDS, type AssetSymbol } from "@/lib/types";
import { ASSET_ORDER } from "@/lib/demoMarkets";
import type { DayScorecard, ModeScorecard } from "@/lib/performanceTypes";

function emptyMode(): ModeScorecard {
  return {
    opens: 0,
    settled: 0,
    hitsOrWins: 0,
    missesOrLosses: 0,
    voids: 0,
    openNow: 0,
    hitRate: null,
    expectancyCents: null,
    sumPnlCents: 0,
  };
}

function mode(partial: Partial<ModeScorecard>): ModeScorecard {
  return { ...emptyMode(), ...partial };
}

function pair(b: ModeScorecard, a: ModeScorecard = emptyMode()) {
  const z = emptyMode();
  return { modeA: a, modeB: b, modeAMom: a, modeARev: a, modeBEarly: z };
}

/** Layout-only scorecard so /preview matches the live dashboard chrome. */
export function previewScorecard(): DayScorecard {
  const blank = emptyMode();
  const allB = mode({
    settled: 12,
    hitsOrWins: 9,
    missesOrLosses: 3,
    hitRate: 0.75,
    expectancyCents: 3.1,
    sumPnlCents: 37.2,
    openNow: 2,
    opens: 14,
  });
  const h24B = mode({
    settled: 5,
    hitsOrWins: 4,
    missesOrLosses: 1,
    hitRate: 0.8,
    expectancyCents: 2.4,
    sumPnlCents: 12,
    openNow: 2,
    opens: 7,
  });
  const h2B = mode({
    settled: 2,
    hitsOrWins: 2,
    missesOrLosses: 0,
    hitRate: 1,
    expectancyCents: 4.5,
    sumPnlCents: 9,
    openNow: 2,
    opens: 4,
  });

  const coinAll: Partial<Record<AssetSymbol, ModeScorecard>> = {
    BTC: mode({ settled: 3, hitsOrWins: 2, missesOrLosses: 1, hitRate: 2 / 3, expectancyCents: 1.2, sumPnlCents: 3.6 }),
    ETH: mode({ settled: 2, hitsOrWins: 2, missesOrLosses: 0, hitRate: 1, expectancyCents: 8.1, sumPnlCents: 16.2 }),
    SOL: mode({ settled: 4, hitsOrWins: 3, missesOrLosses: 1, hitRate: 0.75, expectancyCents: 2.1, sumPnlCents: 8.4, openNow: 1 }),
    XRP: mode({ settled: 3, hitsOrWins: 2, missesOrLosses: 1, hitRate: 2 / 3, expectancyCents: 3, sumPnlCents: 9 }),
  };
  const coin24: Partial<Record<AssetSymbol, ModeScorecard>> = {
    BTC: mode({ settled: 1, hitsOrWins: 1, missesOrLosses: 0, hitRate: 1, expectancyCents: 6.2, sumPnlCents: 6.2 }),
    ETH: mode({ settled: 1, hitsOrWins: 1, missesOrLosses: 0, hitRate: 1, expectancyCents: 4.1, sumPnlCents: 4.1 }),
    SOL: mode({ settled: 2, hitsOrWins: 1, missesOrLosses: 1, hitRate: 0.5, expectancyCents: -1.2, sumPnlCents: -2.4, openNow: 1 }),
    XRP: mode({ settled: 1, hitsOrWins: 1, missesOrLosses: 0, hitRate: 1, expectancyCents: 4.1, sumPnlCents: 4.1 }),
  };

  const byAsset = (
    coins: Partial<Record<AssetSymbol, ModeScorecard>>,
  ): DayScorecard["windows"][0]["byAsset"] =>
    Object.fromEntries(
      ASSET_ORDER.map((s) => [s, pair(coins[s] ?? blank)]),
    ) as DayScorecard["windows"][0]["byAsset"];

  const arms = Object.fromEntries(ARM_IDS.map((a) => [a, blank])) as DayScorecard["modeAArms"];
  const slice = (
    id: "all" | "24h" | "2h",
    label: string,
    b: ModeScorecard,
    coins: Partial<Record<AssetSymbol, ModeScorecard>>,
  ) => ({
    id,
    label,
    all: pair(b),
    byAsset: byAsset(coins),
    modeAArms: arms,
  });
  const streaks = {
    all: 2,
    byAsset: Object.fromEntries(ASSET_ORDER.map((s) => [s, s === "ETH" ? 2 : 0])) as Record<
      AssetSymbol,
      number
    >,
  };
  const exitCell = {
    stopKind: "mark" as const,
    stopAtEntryPct: null as number | null,
    stopMarkCents: 49 as number | null,
    takeProfitKind: "hold" as const,
    takeProfitValue: null,
    expectancyCents: null,
    counterfactualSumCents: null,
    holdoutSumCents: null,
    baselineExpectancyCents: null,
    sampleSize: 0,
    source: "insufficient" as const,
  };
  const exitOpts = {
    all: exitCell,
    byAsset: Object.fromEntries(ASSET_ORDER.map((s) => [s, exitCell])) as DayScorecard["exitOpt"]["modeB"]["byAsset"],
  };

  return {
    dayKey: "preview",
    modeA: blank,
    modeB: allB,
    modeAArms: arms,
    openTickets: 2,
    streaks: {
      modeA: { ...streaks, all: 0 },
      modeB: streaks,
      modeAMom: streaks,
      modeARev: streaks,
    },
    exitOpt: {
      modeA: exitOpts,
      modeB: exitOpts,
      modeAMom: exitOpts,
      modeARev: exitOpts,
      note: "preview",
    },
    sessionOpt: {
      builtAtMs: Date.now() - 45 * 60_000,
      modeA: {
        lane: "mid",
        builtAtMs: Date.now() - 45 * 60_000,
        closeCount: 180,
        sitOutSummary: "Weekdays 2am–5am / Thu 1pm–7:30pm",
        ranges: [
          {
            label: "Weekdays 2am–5am",
            pnlCents: -4.2,
            n: 24,
            weekdays: [0, 1, 2, 3, 4],
            startSlot: 8,
            endSlotExclusive: 20,
            kind: "weekdays",
          },
          {
            label: "Thu 1pm–7:30pm",
            pnlCents: -3.1,
            n: 12,
            weekdays: [3],
            startSlot: 52,
            endSlotExclusive: 78,
            kind: "day",
            startSunIndex: 3 * 96 + 52,
            slotCount: 26,
          },
        ],
        allPnlCents: 12,
        optPnlCents: 85,
        liftCents: 73,
      },
      modeB: {
        lane: "eom",
        builtAtMs: Date.now() - 45 * 60_000,
        closeCount: 96,
        sitOutSummary: "Weekend 9am–11am / Weekdays 9am–11am",
        ranges: [
          {
            label: "Weekdays 9am–11am",
            pnlCents: -1.8,
            n: 16,
            weekdays: [0, 1, 2, 3, 4],
            startSlot: 36,
            endSlotExclusive: 44,
            kind: "weekdays",
          },
        ],
        allPnlCents: 37.2,
        optPnlCents: 55.2,
        liftCents: 18,
      },
    },
    windows: [
      slice("all", "All", allB, coinAll),
      slice("24h", "24h", h24B, coin24),
      slice("2h", "2h", h2B, coin24),
    ],
  };
}
