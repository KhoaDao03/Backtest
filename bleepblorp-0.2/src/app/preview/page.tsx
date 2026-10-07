"use client";

import { AssetRow } from "@/components/AssetRow";
import { ScorecardStrip } from "@/components/ScorecardStrip";
import { ASSET_ORDER, DEMO_MARKETS } from "@/lib/demoMarkets";
import { previewScorecard } from "@/lib/previewScorecard";
import { BLEEPBLORP_TITLE } from "@/lib/version";

/**
 * Layout preview with canned prices. Does not open EventSource or Kalshi.
 * Run: npm run preview → http://localhost:3001/preview
 */
export default function PreviewPage() {
  const scorecard = previewScorecard();

  return (
    <div className="obs-root">
      <header className="obs-head">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(13px, 1.8vh, 16px)",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1,
            }}
          >
            {BLEEPBLORP_TITLE}
          </div>
          <span
            style={{
              fontSize: "clamp(8px, 1.2vh, 10px)",
              color: "var(--muted)",
              whiteSpace: "nowrap",
            }}
          >
            UI preview · demo prices · paper assistant
          </span>
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            color: "var(--accent)",
            flexShrink: 0,
          }}
        >
          localhost:3001/preview
        </div>
      </header>

      <ScorecardStrip scorecard={scorecard} />

      <div className="obs-grid">
        {ASSET_ORDER.map((symbol) => {
          const market =
            DEMO_MARKETS.find((m) => m.symbol === symbol) ?? DEMO_MARKETS[0]!;
          return (
            <div
              key={symbol}
              style={{
                minHeight: 0,
                minWidth: 0,
                height: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <AssetRow
                market={market}
                marketTicker={`KX${symbol}15M-26AUG231645-45`}
                spotSource="cfbenchmarks"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
