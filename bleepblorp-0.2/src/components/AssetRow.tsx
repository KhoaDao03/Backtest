import { decide } from "@/lib/decide";
import { formatCentValue, formatClock, snapKalshiCents } from "@/lib/math";
import { spotDecimals, type DecisionResult, type MarketSnapshot } from "@/lib/types";
import { ModeABox, ModeBBox } from "./RecommendationBoxes";

/** Book grid already labels bid/ask — skip the ¢ so 91.5 does not clip. */
function formatBookPx(prob: number): string {
  return formatCentValue(snapKalshiCents(prob * 100));
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="asset-line">
      <span className="asset-line-label">{label}</span>
      <span className="asset-line-value">{value}</span>
    </div>
  );
}

export function AssetRow({
  market,
  marketTicker,
  spotSource,
  decision: decisionProp,
}: {
  market: MarketSnapshot;
  marketTicker?: string;
  spotSource?: "cfbenchmarks" | "fallback" | "unknown";
  spotDetail?: string[];
  decision?: DecisionResult;
}) {
  const d = decisionProp ?? decide(market);
  const sideLead = market.spot >= market.strike ? "above" : "below";
  const px = spotDecimals(market.symbol);
  const priceFmt = { minimumFractionDigits: px, maximumFractionDigits: px };
  const stochDir =
    market.stochK > market.stochKPrev
      ? "↑"
      : market.stochK < market.stochKPrev
        ? "↓"
        : "→";
  const bb =
    market.spot < market.bbLower
      ? "Below"
      : market.spot > market.bbUpper
        ? "Above"
        : "Inside";

  const clockColor =
    market.secondsLeft <= 120
      ? "var(--danger)"
      : market.secondsLeft <= 180
        ? "var(--ink-soft)"
        : market.secondsLeft <= 480
          ? "var(--accent)"
          : "var(--ink)";

  return (
    <article className="asset-card">
      <header className="asset-card-head">
        <div style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0 }}>
          <h2 className="asset-card-symbol">{market.symbol}</h2>
          {marketTicker ? (
            <span className="asset-card-ticker" title={marketTicker}>
              {shortTicker(marketTicker)}
            </span>
          ) : null}
          {spotSource === "cfbenchmarks" ? (
            <span
              className="asset-card-ticker"
              style={{ color: "var(--accent)", flexShrink: 0, overflow: "visible" }}
            >
              CFB
            </span>
          ) : null}
        </div>
        <div className="asset-card-clock" style={{ color: clockColor }}>
          <span>{formatClock(market.secondsLeft)}</span>
        </div>
      </header>

      <div className="asset-card-body">
        <div className="asset-cell asset-cell-spot">
          <div className="asset-cell-title">Spot / strike</div>
          <Line
            label="Spot"
            value={market.spot.toLocaleString(undefined, priceFmt)}
          />
          <Line
            label="Strike"
            value={market.strike.toLocaleString(undefined, priceFmt)}
          />
          <div className="asset-line-sub">
            {d.indicators.cushion.toFixed(px)} {sideLead}
          </div>
        </div>

        <div className="asset-cell asset-cell-book">
          <div className="asset-book">
            <span className="asset-cell-title">Book</span>
            <span className="asset-book-head">bid</span>
            <span className="asset-book-head">ask</span>
            <span className="asset-book-side">Up</span>
            <span className="asset-book-px">{formatBookPx(market.bidUp)}</span>
            <span className="asset-book-px">{formatBookPx(market.askUp)}</span>
            <span className="asset-book-side">Down</span>
            <span className="asset-book-px">{formatBookPx(market.bidDown)}</span>
            <span className="asset-book-px">{formatBookPx(market.askDown)}</span>
          </div>
        </div>

        <div className="asset-cell asset-cell-ind">
          <div className="asset-cell-title">Ind 1m</div>
          <Line label="Stoch" value={`${market.stochK.toFixed(0)} ${stochDir}`} />
          <Line label="BB" value={bb} />
          <div className="asset-line-sub">
            ATR {formatAtr(market.atr1m)} · {shortLean(d.indicators.leanLabel)}
          </div>
        </div>

        <div className="asset-rec">
          <ModeABox
            rec={d.modeAMom ?? d.modeA}
            label="Mid-Market"
          />
        </div>
        <div className="asset-rec">
          <ModeBBox rec={d.modeB} />
        </div>
      </div>
    </article>
  );
}

function shortTicker(ticker: string): string {
  const parts = ticker.split("-");
  if (parts.length >= 3) return `${parts[1]}-${parts[2]}`;
  if (parts.length === 2) return parts[1] ?? ticker;
  return ticker;
}

function formatAtr(atr: number): string {
  if (atr >= 100) return atr.toFixed(0);
  if (atr >= 1) return atr.toFixed(2);
  if (atr >= 0.01) return atr.toFixed(4);
  return atr.toPrecision(2);
}

function shortLean(label: string): string {
  if (label.includes("continuation") && label.includes("Up")) return "mom ↑";
  if (label.includes("continuation") && label.includes("Down")) return "mom ↓";
  if (label.includes("bounce")) return "revert ↑";
  if (label.includes("fade")) return "revert ↓";
  if (label.includes("No clear")) return "no lean";
  if (label.includes("Mixed")) return "mixed";
  return label.length > 18 ? `${label.slice(0, 16)}…` : label;
}
