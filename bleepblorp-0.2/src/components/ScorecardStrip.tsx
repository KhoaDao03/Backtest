import type {
  DayScorecard,
  ExitOptCell,
  ModeExitOpts,
  ModeScorecard,
  ModeStreaks,
  ScoreWindowSlice,
} from "@/lib/performanceTypes";
import type { ReactNode } from "react";
import { memo } from "react";
import { ASSET_ORDER } from "@/lib/demoMarkets";
import { formatCentValue } from "@/lib/math";
import type { ArmId, AssetSymbol } from "@/lib/types";
import { ARM_IDS } from "@/lib/types";
import { SessionOptBox } from "@/components/SessionOptBox";
import type { SessionOptSummary } from "@/lib/sessionOptTypes";

function fmtRate(n: number | null): string {
  if (n == null) return "—";
  return `${Math.round(n * 100)}%`;
}

function fmtExp(n: number | null): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}`;
}

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

function emptyPair() {
  return {
    modeA: emptyMode(),
    modeB: emptyMode(),
    modeAMom: emptyMode(),
    modeARev: emptyMode(),
    modeBEarly: emptyMode(),
  };
}

function emptyStreaks(): ModeStreaks {
  return {
    all: 0,
    byAsset: Object.fromEntries(ASSET_ORDER.map((s) => [s, 0])) as Record<
      AssetSymbol,
      number
    >,
  };
}

function emptyExitCell(): ExitOptCell {
  return {
    stopKind: null,
    stopAtEntryPct: null,
    stopMarkCents: null,
    takeProfitKind: null,
    takeProfitValue: null,
    expectancyCents: null,
    counterfactualSumCents: null,
    holdoutSumCents: null,
    baselineExpectancyCents: null,
    sampleSize: 0,
    source: "insufficient",
  };
}

function emptyExitOpts(): ModeExitOpts {
  return {
    all: emptyExitCell(),
    byAsset: Object.fromEntries(
      ASSET_ORDER.map((s) => [s, emptyExitCell()]),
    ) as Record<AssetSymbol, ExitOptCell>,
  };
}

function emptyArms(): Record<ArmId, ModeScorecard> {
  return Object.fromEntries(ARM_IDS.map((a) => [a, emptyMode()])) as Record<
    ArmId,
    ModeScorecard
  >;
}

function fallbackWindows(scorecard: DayScorecard): ScoreWindowSlice[] {
  const blank = () => emptyPair();
  const blankAssets = () =>
    Object.fromEntries(
      ASSET_ORDER.map((s) => [s, blank()]),
    ) as ScoreWindowSlice["byAsset"];
  return [
    {
      id: "all",
      label: "All",
      all: {
        modeA: scorecard.modeA,
        modeB: scorecard.modeB,
        modeAMom: emptyMode(),
        modeARev: emptyMode(),
        modeBEarly: scorecard.modeBEarly ?? emptyMode(),
      },
      byAsset: blankAssets(),
      modeAArms: scorecard.modeAArms ?? emptyArms(),
    },
    {
      id: "24h",
      label: "24h",
      all: blank(),
      byAsset: blankAssets(),
      modeAArms: emptyArms(),
    },
    {
      id: "2h",
      label: "2h",
      all: blank(),
      byAsset: blankAssets(),
      modeAArms: emptyArms(),
    },
  ];
}

function fmtPnlDollars(cents: number): string {
  const dollars = cents / 100;
  const body = Math.abs(dollars).toFixed(2);
  if (dollars > 0) return `$${body}`;
  if (dollars < 0) return `-$${body}`;
  return "$0.00";
}

function PnlCell({
  cents,
  n,
  title,
}: {
  cents: number;
  n: number;
  title?: string;
}) {
  const empty = n <= 0;
  const text = fmtPnlDollars(cents);
  return (
    <div
      className="score-stat"
      title={
        title ??
        (empty
          ? "No settled trades in this window"
          : `${n} settle${n === 1 ? "" : "s"} · ${text}`)
      }
      style={{
        fontWeight: 700,
        color: empty ? "var(--muted)" : cents > 0 ? "var(--accent)" : cents < 0 ? "var(--danger)" : "var(--ink)",
      }}
    >
      {empty ? "—" : text}
    </div>
  );
}

function StatCell({ m }: { m: ModeScorecard }) {
  const decided = m.hitsOrWins + m.missesOrLosses;
  let text = "—";
  if (decided > 0) {
    text = `${m.hitsOrWins}/${decided} ${fmtRate(m.hitRate)} ${fmtExp(m.expectancyCents)}¢`;
    if (m.openNow > 0) text += ` ·${m.openNow}`;
  } else if (m.openNow > 0) {
    text = `${m.openNow} open`;
  }

  return (
    <div
      className="score-stat"
      title={decided === 0 && m.openNow === 0 ? undefined : `${text}${m.openNow > 0 && decided > 0 ? " open" : ""}`}
      style={{
        color: decided === 0 ? "var(--muted)" : "var(--ink)",
        fontWeight: 600,
      }}
    >
      {text}
    </div>
  );
}

function StreakCell({ n }: { n: number }) {
  const hot = n >= 3;
  const text = n > 0 ? `${n}W` : "—";
  return (
    <div
      title={n > 0 ? `${n} win${n === 1 ? "" : "s"} in a row` : "No current win streak"}
      className="score-stat"
      style={{
        fontWeight: 700,
        color: n === 0 ? "var(--muted)" : hot ? "var(--a-border)" : "var(--ink)",
        textAlign: "right",
      }}
    >
      {text}
    </div>
  );
}

function exitTitle(cell: ExitOptCell, scalp = false): string {
  if (cell.source === "insufficient") {
    return `Need ~12+ settles (have ${cell.sampleSize})`;
  }
  let sl = "Stop: —";
  if (cell.stopKind === "none") {
    sl = scalp
      ? "Stop: off (ride to TP or paper settle mark)"
      : "Stop: off (path data does not beat holding the fill)";
  } else if (cell.stopKind === "protocol") {
    sl = "Stop when mark ≤ 49¢ (EOM entries are ≥80¢)";
  } else if (cell.stopKind === "delta" && cell.stopMarkCents != null) {
    sl = `Stop when mark is ${formatCentValue(cell.stopMarkCents)}¢ under entry`;
  } else if (cell.stopKind === "mark" && cell.stopMarkCents != null) {
    sl = `Stop when mark ≤ ${formatCentValue(cell.stopMarkCents)}¢`;
  } else if (cell.stopAtEntryPct != null) {
    sl = `Stop when mark ≤ ${cell.stopAtEntryPct}% of entry`;
  }
  let tp = scalp
    ? "TP: each fill's own rec target (+15 or +20)"
    : "TP: hold to natural exit";
  if (cell.takeProfitKind === "native") {
    tp = "TP: each fill's own rec target (+15 or +20)";
  } else if (cell.takeProfitKind === "delta" && cell.takeProfitValue != null) {
    tp = `TP: +${cell.takeProfitValue}¢ above entry`;
  } else if (cell.takeProfitKind === "mark" && cell.takeProfitValue != null) {
    tp = `TP: exit at ${formatCentValue(cell.takeProfitValue)}¢`;
  }
  const e =
    cell.expectancyCents != null
      ? `opt E ${fmtExp(cell.expectancyCents)}¢`
      : "";
  const rec =
    cell.counterfactualSumCents != null
      ? scalp
        ? `Rec PnL ${fmtPnlDollars(cell.counterfactualSumCents)} (first-touch SL/TP, else paper settle mark)`
        : `Rec PnL ${fmtPnlDollars(cell.counterfactualSumCents)} (SL/TP on entry-to-expiry paths)`
      : "";
  const holdout =
    cell.holdoutSumCents != null
      ? `holdout Rec ${fmtPnlDollars(cell.holdoutSumCents)}`
      : "";
  const base =
    cell.baselineExpectancyCents != null
      ? `base E ${fmtExp(cell.baselineExpectancyCents)}¢`
      : "";
  const src =
    cell.source === "historical" ? "provisional / prior paths" : "current fills";
  return `${sl} · ${tp} · ${e} ${rec} ${holdout} vs ${base} · n=${cell.sampleSize} (${src})`;
}

function OptCell({
  cell,
  part,
  scalp = false,
}: {
  cell: ExitOptCell;
  part: "sl" | "tp";
  scalp?: boolean;
}) {
  const muted = cell.source !== "current";
  const hasExit =
    cell.stopKind === "none" ||
    cell.stopKind === "protocol" ||
    cell.stopKind === "delta" ||
    (cell.stopKind === "mark" && cell.stopMarkCents != null) ||
    cell.stopAtEntryPct != null ||
    cell.takeProfitKind != null;
  let text = "—";
  if (cell.source !== "insufficient" && hasExit) {
    if (part === "sl") {
      if (cell.stopKind === "none") {
        text = "off";
      } else if (cell.stopKind === "protocol") {
        text = "49¢";
      } else if (cell.stopKind === "delta" && cell.stopMarkCents != null) {
        text = `-${formatCentValue(cell.stopMarkCents)}¢`;
      } else if (cell.stopKind === "mark" && cell.stopMarkCents != null) {
        text = `${formatCentValue(cell.stopMarkCents)}¢`;
      } else if (cell.stopAtEntryPct != null) {
        text = `${cell.stopAtEntryPct}%`;
      }
    } else if (cell.takeProfitKind === "hold") {
      text = "hold";
    } else if (cell.takeProfitKind === "native") {
      text = "tgt";
    } else if (cell.takeProfitKind === "delta" && cell.takeProfitValue != null) {
      text = `+${cell.takeProfitValue}¢`;
    } else if (cell.takeProfitKind === "mark" && cell.takeProfitValue != null) {
      text = `${formatCentValue(cell.takeProfitValue)}¢`;
    }
  }
  return (
    <div
      title={exitTitle(cell, scalp)}
      className="score-stat"
      style={{
        fontWeight: 600,
        color: muted ? "var(--muted)" : "var(--ink)",
      }}
    >
      {text}
    </div>
  );
}

function ColHead({
  children,
  title,
  align = "left",
}: {
  children: string;
  title?: string;
  align?: "left" | "right";
}) {
  return (
    <div title={title} className="score-head" style={{ textAlign: align }}>
      {children}
    </div>
  );
}

/** Asset | All | 24h | 2h | 24h PnL | All PnL | Rec PnL | SL | TP | Strk */
const GRID_CLASS = "score-table";

function ModeTable({
  title,
  color,
  pick,
  windows,
  streaks,
  exitOpts,
  extras = true,
  badge,
  scalpExits = false,
  sessionOpt,
}: {
  title: string;
  color: string;
  pick: (pair: ScoreWindowSlice["all"]) => ModeScorecard;
  windows: ScoreWindowSlice[];
  streaks: ModeStreaks;
  exitOpts: ModeExitOpts;
  extras?: boolean;
  badge?: ReactNode;
  /** Mid-market: Rec remainder is the paper settle mark, not 0/100 expiry. */
  scalpExits?: boolean;
  sessionOpt?: SessionOptSummary | null;
}) {
  const byId = (id: "all" | "24h" | "2h") => {
    const found = windows.find((w) => w.id === id);
    if (found) return found;
    return {
      id,
      label: id,
      all: emptyPair(),
      byAsset: Object.fromEntries(
        ASSET_ORDER.map((s) => [s, emptyPair()]),
      ) as ScoreWindowSlice["byAsset"],
      modeAArms: emptyArms(),
    };
  };

  const all = byId("all");
  const h24 = byId("24h");
  const h2 = byId("2h");

  const rows: {
    key: string;
    label: string;
    get: (w: ScoreWindowSlice) => ModeScorecard;
    streak: number;
    exit: ExitOptCell;
  }[] = [
    {
      key: "ALL",
      label: "ALL",
      get: (w) => pick(w.all),
      streak: streaks.all,
      exit: exitOpts.all,
    },
    ...ASSET_ORDER.map((symbol) => ({
      key: symbol,
      label: symbol,
      get: (w: ScoreWindowSlice) => pick(w.byAsset[symbol] ?? emptyPair()),
      streak: streaks.byAsset[symbol] ?? 0,
      exit: exitOpts.byAsset[symbol] ?? emptyExitCell(),
    })),
  ];

  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <div
        className="score-block-title"
        style={{
          color,
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          minWidth: 0,
        }}
      >
        <span>{title}</span>
        {badge}
      </div>
      <div className={extras ? GRID_CLASS : "score-table-compact"}>
        <div />
        <ColHead>All</ColHead>
        <ColHead>24h</ColHead>
        <ColHead>2h</ColHead>
        <ColHead title="Rolling 24-hour realized PnL">24h PnL</ColHead>
        <ColHead title="All-time realized PnL">All PnL</ColHead>
        {extras ? (
          <>
            <ColHead
              title={
                scalpExits
                  ? "PnL if this row used the displayed SL/TP on this strategy's complete All-era fills."
                  : "Complete All-era PnL if this row had used the displayed SL/TP on every settled fill (same sample as All)."
              }
            >
              Rec PnL
            </ColHead>
            <ColHead
              title={
                scalpExits
                  ? "Mid-market paper has no stop. Rec SL stays off."
                  : "Stop-loss of the all-time max-PnL policy, or off if no stop beats holding to settle"
              }
            >
              SL
            </ColHead>
            <ColHead
              title={
                scalpExits
                  ? "Take-profit overlay vs live tgt. tgt = each fill's own rec target; +N¢ = bank that delta instead"
                  : "Take-profit of the all-time max-PnL policy, or hold to natural settle"
              }
            >
              TP
            </ColHead>
            <ColHead title="Current win streak (protocol lifetime)" align="right">
              Strk
            </ColHead>
          </>
        ) : null}
        {rows.map((row) => {
          const paperAll = row.get(all);
          const paper24 = row.get(h24);
          return (
          <div key={row.key} style={{ display: "contents" }}>
            <div
              className="score-stat"
              style={{
                fontWeight: row.key === "ALL" ? 700 : 600,
                color: row.key === "ALL" ? "var(--ink)" : "var(--muted)",
              }}
            >
              {row.label}
            </div>
            <StatCell m={paperAll} />
            <StatCell m={paper24} />
            <StatCell m={row.get(h2)} />
            <PnlCell cents={paper24.sumPnlCents} n={paper24.settled} />
            <PnlCell cents={paperAll.sumPnlCents} n={paperAll.settled} />
            {extras ? (
              <>
                <PnlCell
                  cents={row.exit.counterfactualSumCents ?? 0}
                  n={row.exit.counterfactualSumCents == null ? 0 : paperAll.settled}
                  title={exitTitle(row.exit, scalpExits)}
                />
                <OptCell cell={row.exit} part="sl" scalp={scalpExits} />
                <OptCell cell={row.exit} part="tp" scalp={scalpExits} />
                <StreakCell n={row.streak} />
              </>
            ) : null}
          </div>
          );
        })}
      </div>
      <SessionOptBox sessionOpt={sessionOpt} />
    </div>
  );
}

export const ScorecardStrip = memo(function ScorecardStrip({
  scorecard,
}: {
  scorecard: DayScorecard;
}) {
  const windows =
    scorecard.windows?.length >= 3
      ? scorecard.windows
      : fallbackWindows(scorecard);

  const streaksMom = scorecard.streaks?.modeAMom ?? emptyStreaks();
  const streaksB = scorecard.streaks?.modeB ?? emptyStreaks();
  const exitMom =
    scorecard.exitOpt?.modeAMom ?? scorecard.exitOpt?.modeA ?? emptyExitOpts();
  const exitB = scorecard.exitOpt?.modeB ?? emptyExitOpts();

  return (
    <section className="score-strip">
      <div className="score-strip-title">
        <span className="score-strip-heading">Paper</span>
      </div>

      <ModeTable
        title="Mid-Market"
        color="var(--a-border)"
        pick={(p) => p.modeAMom ?? p.modeA ?? emptyMode()}
        windows={windows}
        streaks={streaksMom}
        exitOpts={exitMom}
        scalpExits
        sessionOpt={scorecard.sessionOpt?.modeA}
      />
      <ModeTable
        title="End-of-Market"
        color="var(--b-border)"
        pick={(p) => p.modeB}
        windows={windows}
        streaks={streaksB}
        exitOpts={exitB}
        sessionOpt={scorecard.sessionOpt?.modeB}
      />
    </section>
  );
});

