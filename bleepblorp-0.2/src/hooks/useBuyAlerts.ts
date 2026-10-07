"use client";

import { announceBuys, type BuyAlertItem } from "@/lib/buyAlerts";
import type { LiveFeedPayload } from "@/lib/liveTypes";
import { MODE_A_UNLIT_DEBOUNCE_MS, type AssetSymbol, type Side } from "@/lib/types";
import { useEffect, useRef } from "react";

type Lane = "mid" | "eom";

type Episode = {
  alerted: boolean;
  unlitSinceMs: number | null;
  side?: Side;
};

/**
 * End-of-market: one alert when the Trade box first shows Buy (not Watch/Hold).
 * Mid-market: alert on each new sticky Buy (after unlit debounce).
 *
 * `armNonce` bumps on unlock / Alerts-on. Dashboard speaks lit boxes under that
 * gesture; this hook only seeds "already alerted" so the next SSE does not repeat.
 */
export function useBuyAlerts(
  live: LiveFeedPayload | null,
  enabled: boolean,
  armNonce = 0,
): void {
  const episodesRef = useRef(new Map<string, Episode>());
  const lastArmNonceRef = useRef(armNonce);

  useEffect(() => {
    if (!enabled) {
      episodesRef.current.clear();
      lastArmNonceRef.current = armNonce;
      return;
    }
    if (!live?.assets?.length) return;

    const rearm = armNonce !== lastArmNonceRef.current;
    if (rearm) {
      lastArmNonceRef.current = armNonce;
      episodesRef.current.clear();
      // Seed current lights as claimed — spoken by Dashboard under the gesture.
      for (const asset of live.assets) {
        const symbol = asset.snapshot.symbol as AssetSymbol;
        const ticker = asset.marketTicker || symbol;
        const d = asset.decision;
        if (!d) continue;
        const mid = d.modeAMom ?? d.modeA;
        if (mid?.action === "buy") {
          episodesRef.current.set(`${symbol}:mid:${ticker}`, {
            alerted: true,
            unlitSinceMs: null,
            side: mid.side,
          });
        }
        const eom = d.modeB;
        // Trade Buy only — thesis Watch (hold) must not claim the EOM episode.
        if (eom?.action === "buy") {
          episodesRef.current.set(`${symbol}:eom:${ticker}`, {
            alerted: true,
            unlitSinceMs: null,
            side: eom.side,
          });
        }
      }
      return;
    }

    const now = Date.now();
    const batch: BuyAlertItem[] = [];
    const seenKeys = new Set<string>();

    for (const asset of live.assets) {
      const symbol = asset.snapshot.symbol as AssetSymbol;
      const ticker = asset.marketTicker || symbol;
      const d = asset.decision;
      if (!d) continue;

      const lanes: { lane: Lane; action?: string; side?: Side }[] = [
        {
          lane: "mid",
          action: (d.modeAMom ?? d.modeA)?.action,
          side: (d.modeAMom ?? d.modeA)?.side,
        },
        {
          lane: "eom",
          action: d.modeB?.action,
          side: d.modeB?.side,
        },
      ];

      for (const { lane, action, side } of lanes) {
        const key = `${symbol}:${lane}:${ticker}`;
        seenKeys.add(key);
        const prev = episodesRef.current.get(key);

        if (lane === "eom") {
          // Match ModeBBox Trade "Buy" — not thesis Watch / above-98 Hold.
          const isBuy = action === "buy";
          if (isBuy) {
            if (!prev?.alerted) {
              batch.push({ symbol, side, lane: "eom" });
            }
            episodesRef.current.set(key, {
              alerted: true,
              unlitSinceMs: null,
              side: side ?? prev?.side,
            });
          } else if (prev?.alerted) {
            episodesRef.current.set(key, { ...prev, unlitSinceMs: null });
          }
          continue;
        }

        if (action === "buy") {
          const sideFlip =
            Boolean(prev?.alerted) &&
            Boolean(prev?.side) &&
            Boolean(side) &&
            prev!.side !== side;

          if (!prev?.alerted || sideFlip) {
            batch.push({ symbol, side, lane: "mid" });
          }
          episodesRef.current.set(key, {
            alerted: true,
            unlitSinceMs: null,
            side,
          });
          continue;
        }

        if (!prev) continue;

        if (prev.unlitSinceMs == null) {
          episodesRef.current.set(key, { ...prev, unlitSinceMs: now });
          continue;
        }

        if (now - prev.unlitSinceMs >= MODE_A_UNLIT_DEBOUNCE_MS) {
          episodesRef.current.delete(key);
        }
      }
    }

    for (const key of [...episodesRef.current.keys()]) {
      if (!seenKeys.has(key)) episodesRef.current.delete(key);
    }

    if (batch.length) announceBuys(batch);
  }, [live, enabled, armNonce]);
}
