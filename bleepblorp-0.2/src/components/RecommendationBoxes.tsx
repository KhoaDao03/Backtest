import type { LiveAssetTrade } from "@/lib/liveTypes";
import { formatCentValue, formatCents } from "@/lib/math";
import type { ModeARecommendation, ModeBRecommendation, Side } from "@/lib/types";

function sideMark(side?: Side): string {
  if (side === "up") return "Up";
  if (side === "down") return "Down";
  return "";
}

function verbSide(verb: string, side?: Side): string {
  const mark = sideMark(side);
  return mark ? `${verb} ${mark}` : verb;
}

export function ModeABox({
  rec,
  label,
}: {
  rec: ModeARecommendation;
  label: string;
}) {
  const active = rec.action === "buy";
  const noNew = !active && rec.reason.toLowerCase().includes("no new positions");
  const pay =
    active && rec.entryAsk != null
      ? `${formatCentValue(rec.entryAsk * 100)}¢`
      : null;

  let headline: string;
  let metric: string;
  let metricColor: string;
  let note = "";
  const lit = active || noNew;
  const title = rec.reason;

  if (active) {
    headline = verbSide("Buy", rec.side);
    metric = pay ?? `+${rec.targetCents}¢`;
    metricColor = "var(--accent)";
    note = `+${rec.targetCents}¢ · ${rec.confidence.toFixed(0)}%`;
  } else if (noNew) {
    headline = "Tracking";
    metric = "open Δ";
    metricColor = "var(--muted)";
  } else {
    headline = verbSide("Wait", rec.side);
    metric = rec.confidence > 0 ? `${rec.confidence.toFixed(0)}%` : "—";
    metricColor = "var(--muted)";
    note = waitReasonLine(rec.reason);
  }

  return (
    <div
      className="mode-b"
      style={{
        background: lit && active ? "var(--a-bg)" : "var(--wait-bg)",
        borderColor: lit && active ? "var(--a-border)" : "var(--border)",
      }}
      title={title}
    >
      <div className="mode-b-label">{label}</div>
      <div
        className="mode-b-headline"
        style={{ color: lit && active ? "var(--ink)" : "var(--muted)" }}
      >
        {headline}
      </div>
      <div className="mode-b-conf" style={{ color: metricColor }}>
        {metric}
      </div>
      {note ? <div className="mode-b-note">{note}</div> : null}
    </div>
  );
}

function formatPnl(cents: number): string {
  const n = Math.round(cents * 10) / 10;
  const body = Number.isInteger(n) ? `${n}` : n.toFixed(1);
  if (n > 0) return `+${body}¢`;
  if (n < 0) return `${body}¢`;
  return "0.0¢";
}

function contractsAt(trade: LiveAssetTrade): string | null {
  if (trade.contracts == null || trade.entryPrice == null) return null;
  return `${trade.contracts} @ ${formatCents(trade.entryPrice)}`;
}

function tradeBoxView(
  rec: ModeBRecommendation,
  trade: LiveAssetTrade | undefined,
  ask: number | undefined,
): {
  lit: boolean;
  headline: string;
  metric: string;
  metricColor: string;
  note: string;
} {
  const recSide = rec.side;
  const thesisLit =
    rec.action === "hold" && rec.reason.toLowerCase().includes("thesis lit");
  const above98 = rec.action === "hold" && !thesisLit;

  if (trade) {
    const side = trade.side || recSide;
    const fill = contractsAt(trade);
    const confMetric =
      rec.confidence > 0 ? `${rec.confidence.toFixed(0)}%` : "—";
    switch (trade.phase) {
      case "bidding":
        return {
          lit: true,
          headline: verbSide("Bid", side),
          metric: confMetric,
          metricColor: "var(--accent)",
          note: fill ?? (trade.entryPrice != null ? `${formatCentValue(trade.entryPrice * 100)}¢ · maker` : "maker wait"),
        };
      case "open": {
        const pnl = trade.unrealizedCents ?? 0;
        const mark =
          trade.lastMarkCents != null
            ? `mark ${formatCentValue(trade.lastMarkCents)}¢`
            : "holding";
        return {
          lit: true,
          headline: verbSide("Hold", side),
          metric: confMetric,
          metricColor: "var(--accent)",
          note: `${formatPnl(pnl)}${fill ? ` · ${fill}` : ""} · ${mark}`,
        };
      }
      case "selling": {
        const pnl = trade.unrealizedCents ?? 0;
        return {
          lit: true,
          headline: verbSide("Sell", side),
          metric: confMetric,
          metricColor: "var(--accent)",
          note: `${formatPnl(pnl)} · stop at bid`,
        };
      }
      case "stopped": {
        const pnl = trade.realizedCents ?? 0;
        return {
          lit: false,
          headline: "Stopped",
          metric: formatPnl(pnl),
          metricColor: pnl >= 0 ? "var(--accent)" : "var(--danger)",
          note: fill ?? "sold at bid",
        };
      }
      case "settled": {
        const pnl = trade.realizedCents ?? 0;
        return {
          lit: false,
          headline: "Settled",
          metric: formatPnl(pnl),
          metricColor: pnl >= 0 ? "var(--accent)" : "var(--danger)",
          note: fill ?? "to expiry",
        };
      }
      case "unfilled":
        return {
          lit: false,
          headline: verbSide("Unfilled", side),
          metric: confMetric,
          metricColor: "var(--muted)",
          note: fill ?? (ask != null ? `IOC ${formatCentValue(ask * 100)}¢` : "retrying"),
        };
      case "error":
        return {
          lit: false,
          headline: "Bid failed",
          metric: confMetric,
          metricColor: "var(--danger)",
          note: trade.lastDetail ? fitNote(trade.lastDetail) : "Order error",
        };
    }
  }

  if (rec.action === "buy") {
    return {
      lit: true,
      headline: verbSide("Buy", recSide),
      metric: `${rec.confidence.toFixed(0)}%`,
      metricColor: "var(--accent)",
      note: "85–98¢",
    };
  }

  if (thesisLit) {
    return {
      lit: true,
      headline: verbSide("Watch", recSide),
      metric: `${rec.confidence.toFixed(0)}%`,
      metricColor: "var(--accent)",
      note: waitReasonLine(rec.reason) || "Thesis only",
    };
  }

  if (above98) {
    return {
      lit: true,
      headline: verbSide("Hold", recSide),
      metric: `${rec.confidence.toFixed(0)}%`,
      metricColor: "var(--accent)",
      note: "Above 98¢",
    };
  }

  return {
    lit: false,
    headline: verbSide("Wait", recSide),
    metric: `${rec.confidence.toFixed(0)}%`,
    metricColor: "var(--muted)",
    note: waitReasonLine(rec.reason),
  };
}

export function ModeBBox({
  rec,
  trade,
  ask,
}: {
  rec: ModeBRecommendation;
  trade?: LiveAssetTrade;
  ask?: number;
}) {
  const view = tradeBoxView(rec, trade, ask);
  const title = trade?.lastDetail
    ? `${rec.reason} · ${trade.lastDetail}`
    : rec.reason;

  return (
    <div
      className="mode-b"
      style={{
        background: view.lit ? "var(--b-bg)" : "var(--wait-bg)",
        borderColor: view.lit ? "var(--b-border)" : "var(--border)",
      }}
      title={title}
    >
      <div className="mode-b-label">End-mkt</div>
      <div
        className="mode-b-headline"
        style={{ color: view.lit ? "var(--ink)" : "var(--muted)" }}
      >
        {view.headline}
      </div>
      <div className="mode-b-conf" style={{ color: view.metricColor }}>
        {view.metric}
      </div>
      {view.note ? <div className="mode-b-note">{view.note}</div> : null}
    </div>
  );
}

/**
 * Short plain-English note for Mid-Market / End-mkt Wait boxes.
 * Kept ≤~34 chars so it fits the 2-line note clamp on asset cards.
 * Full detail stays on the box `title` tooltip.
 */
function waitReasonLine(reason: string): string {
  const r = reason.toLowerCase();

  if (r.includes("stopped out")) return "Stopped out";
  if (r.includes("no new positions")) return "Tracking open";

  const confBelow = reason.match(
    /Confidence\s+(\d+)%\s+is\s+below\s+(\d+)%/i,
  );
  if (confBelow) return `Need ${confBelow[2]}% confidence`;

  // Mid-Market lean gate (momentum-only board)
  if (r.includes("sits out") || r.includes("parked")) {
    if (r.includes("momentum continuation") && r.includes("mean reversion"))
      return "Run lean — rev off";
    if (r.includes("mean reversion") && r.includes("momentum sits"))
      return "No run — fade lean";
    if (r.includes("parked") && r.includes("momentum-only"))
      return "Rev lane off";
    if (r.includes("mixed")) return "Mixed signals";
    if (r.includes("no clear")) return "No clear lean";
    return "No clear lean";
  }

  if (r.includes("no clear indicator") || r.includes("too weak"))
    return "No clear lean";

  // Clock
  if (r.includes("under six minutes") || r.includes("under 6"))
    return "Need ≥6:00 left";
  if (r.includes("under eight minutes") || r.includes("under 8"))
    return "Need ≥8:00 left";
  if (r.includes("under a minute")) return "Under 1:00 left";
  if (r.includes("final seconds")) return "Final seconds";
  if (
    r.includes("entries closed at 2:00") ||
    r.includes("mode b entries closed") ||
    (r.includes("2:00") && (r.includes("closed") || r.includes("wait")))
  )
    return "Entry window closed";
  if (
    r.includes("starts at the 8:00") ||
    r.includes("mode b starts") ||
    (r.includes("before 8:00") && r.includes("thesis"))
  )
    return "Before 8:00 left";
  if (r.includes("8:00") && !r.includes("thesis")) return "Before 8:00 left";

  // Thesis Watch (end-mkt lit early)
  if (r.includes("thesis lit")) {
    if (r.includes("before 8:00") && r.includes("below 85"))
      return "Early · bid <85¢";
    if (r.includes("before 8:00")) return "Before entry window";
    if (r.includes("outside 85") || r.includes("bid"))
      return "Bid not 85–98¢";
    return "Thesis only";
  }

  // Geometry / indicators
  if (r.includes("wrong side of strike")) return "Wrong side of strike";
  if (r.includes("run not started") || r.includes("at least 2 bps"))
    return "Run not started";
  if (r.includes("run extended")) return "Run too extended";
  if (r.includes("stoch")) return "Stoch not confirmed";

  // Book / price
  if (r.includes("no book")) return "No book yet";
  if (r.includes("lottery") || r.includes("below 35") || r.includes("below 40"))
    return "Ask too cheap";
  if (r.includes("fully priced")) return "Ask maxed out";
  if (r.includes("above the 55") || r.includes("above 55¢") || r.includes("above the 70") || r.includes("above 70¢") || r.includes("above the 95") || r.includes("too rich"))
    return "Ask too rich";
  if (r.includes("spread too wide")) return "Spread too wide";
  if (r.includes("below 85¢")) return "Bid under 85¢";
  if (r.includes("above 98") || (r.includes("still safe") && r.includes("98")))
    return "Above 98¢";

  // Confidence / edge
  if (r.includes("p(hit")) {
    const hit = reason.match(
      /P\(hit[^)]*\)\s*([\d.]+)%\s+is\s+below\s+(\d+)%/i,
    );
    if (hit) return `Need ≥${hit[2]}% hit`;
    return "Hit chance too low";
  }
  if (
    r.includes("below 75") ||
    r.includes("below 80") ||
    r.includes("below 72") ||
    r.includes("conf <80")
  )
    return "Confidence too low";
  if (r.includes("edge") && r.includes("negative")) return "No edge";
  if (r.includes("too thin") || r.includes("under 10")) return "Edge too thin";
  if (r.includes("unreachable") || r.includes("can't reach") || r.includes("can’t reach"))
    return "Can't reach target";

  // Conflicts
  if (r.includes("fights mode b") || r.includes("side conflict"))
    return "Conflicts end-mkt";

  if (r.includes("cooldown")) return "Cooldown";
  if (r.includes("in window")) return "In window";

  return fitNote(reason);
}

const NOTE_MAX = 34;

function fitNote(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= NOTE_MAX) return t;
  const cut = t.slice(0, NOTE_MAX - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 16 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
