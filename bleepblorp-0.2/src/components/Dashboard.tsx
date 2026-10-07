"use client";

import { AssetRow } from "@/components/AssetRow";
import { ChimeSampleMenu } from "@/components/ChimeSampleMenu";
import { ScorecardStrip } from "@/components/ScorecardStrip";
import { VoiceSampleMenu } from "@/components/VoiceSampleMenu";
import { useBuyAlerts } from "@/hooks/useBuyAlerts";
import {
  announceAlertsEnabled,
  announceBuys,
  collectLitBuyAlerts,
  setChimeAlertsEnabled,
  setSpeakAlertsEnabled,
  unlockBuyAlerts,
} from "@/lib/buyAlerts";
import { DEMO_MARKETS, ASSET_ORDER } from "@/lib/demoMarkets";
import type { LiveFeedPayload } from "@/lib/liveTypes";
import { BLEEPBLORP_DISCLAIMER_SHORT, BLEEPBLORP_TITLE } from "@/lib/version";
import { useCallback, useEffect, useRef, useState, startTransition } from "react";

/** If no SSE data frame arrives this long, force a fresh EventSource. */
const SSE_STALE_MS = 8_000;

const ALERTS_KEY = "bleepblorp.buyAlerts";

export function Dashboard() {
  const [live, setLive] = useState<LiveFeedPayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [alertsOn, setAlertsOn] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const [chimeOn, setChimeOn] = useState(true);
  /** Bumps on unlock / Alerts-on so lit boxes announce under the gesture. */
  const [armNonce, setArmNonce] = useState(0);
  const liveTsRef = useRef(0);
  const liveRef = useRef<LiveFeedPayload | null>(null);
  liveRef.current = live;

  // Synchronous cold start — before child menus read localStorage.
  useState(() => {
    if (typeof window === "undefined") return false;
    try {
      localStorage.removeItem(ALERTS_KEY);
      localStorage.setItem("bleepblorp.alertSpeak", "0");
      localStorage.setItem("bleepblorp.alertChime", "1");
      localStorage.setItem("bleepblorp.alertChimeSound", "soft");
      localStorage.removeItem("bleepblorp.alertVoice");
    } catch {
      /* ignore */
    }
    return true;
  });

  const armAudioAndAlerts = useCallback(async (playConfirm: boolean) => {
    await unlockBuyAlerts();
    setAudioReady(true);
    setArmNonce((n) => n + 1);
    if (playConfirm) await announceAlertsEnabled();
    const lit = collectLitBuyAlerts(liveRef.current);
    if (lit.length) announceBuys(lit, { immediate: true });
  }, []);

  useBuyAlerts(live, alertsOn && audioReady, armNonce);

  // Fast Paper strip on hard-reload — do not wait for the next SSE scorecard push.
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const res = await fetch("/api/performance", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { scorecard?: LiveFeedPayload["scorecard"] };
        if (!data.scorecard || cancelled) return;
        setLive((prev) => {
          if (!prev) {
            // Assets still coming from SSE; stash card on a stub until then.
            return {
              tsMs: Date.now(),
              kalshiWs: { connected: false, detail: "booting" },
              credentialsConfigured: true,
              traderMode: "paper",
              assets: [],
              errors: [],
              scorecard: data.scorecard,
            };
          }
          if (prev.scorecard) return prev;
          return { ...prev, scorecard: data.scorecard };
        });
      } catch {
        /* SSE will deliver the card */
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let pending: LiveFeedPayload | null = null;
    let applyTimer: ReturnType<typeof setTimeout> | null = null;
    let lastApplyMs = 0;
    /** Keep UI responsive; wire activity still updates the stall watchdog. */
    const UI_MIN_MS = 400;

    const applyLive = (payload: LiveFeedPayload) => {
      lastApplyMs = Date.now();
      startTransition(() => {
        setLive((prev) => {
          // Scorecard is only sent when rebuilt (~15s). Keep the last one so the
          // Paper strip does not remount / re-layout on every book tick.
          if (!payload.scorecard && prev?.scorecard) {
            return { ...payload, scorecard: prev.scorecard };
          }
          return payload;
        });
        setConnected(true);
        setErr(null);
      });
    };

    const queueApply = () => {
      if (applyTimer) return;
      const wait = Math.max(0, UI_MIN_MS - (Date.now() - lastApplyMs));
      applyTimer = setTimeout(() => {
        applyTimer = null;
        const next = pending;
        pending = null;
        if (next) applyLive(next);
      }, wait);
    };

    let reconnectAttempt = 0;

    const connect = () => {
      if (stopped) return;
      es?.close();
      es = new EventSource("/api/live");
      es.onopen = () => {
        setConnected(true);
        setErr(null);
      };
      es.onmessage = (ev) => {
        try {
          pending = JSON.parse(ev.data) as LiveFeedPayload;
          // Stall watchdog must track wire receipt, not throttled React apply —
          // otherwise delayed applies look like a dead stream and force reconnects.
          liveTsRef.current = pending.tsMs || Date.now();
          reconnectAttempt = 0;
          queueApply();
        } catch {
          setErr("Bad live payload");
        }
      };
      es.onerror = () => {
        if (stopped) return;
        setConnected(false);
        setErr("Live stream disconnected — retrying…");
        const old = es;
        es = null;
        old?.close();
        // Back off so a full listener cap does not thrash every tab every 2.5s.
        reconnectAttempt += 1;
        const wait = Math.min(15_000, 1_500 * 2 ** Math.min(reconnectAttempt, 3));
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, wait);
      };
    };

    connect();
    watchdog = setInterval(() => {
      if (stopped) return;
      const age = Date.now() - liveTsRef.current;
      if (liveTsRef.current > 0 && age > SSE_STALE_MS) {
        setConnected(false);
        setErr("Live stream stalled — retrying…");
        const old = es;
        es = null;
        old?.close();
        reconnectAttempt += 1;
        connect();
      }
    }, 2_000);

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearInterval(watchdog);
      if (applyTimer) clearTimeout(applyTimer);
      es?.close();
    };
  }, []);

  const rows = ASSET_ORDER.map((symbol) => {
    const liveRow = live?.assets.find((a) => a.snapshot.symbol === symbol);
    if (liveRow) {
      return {
        market: liveRow.snapshot,
        meta: {
          ticker: liveRow.marketTicker,
          spotSource: liveRow.spotSource,
          spotDetail: liveRow.spotSourcesDetail,
          decision: liveRow.decision,
        },
      };
    }
    const demo = DEMO_MARKETS.find((m) => m.symbol === symbol) ?? DEMO_MARKETS[0]!;
    return {
      market: { ...demo, symbol, secondsLeft: live ? 0 : demo.secondsLeft },
      meta: {
        ticker: live ? "waiting…" : "demo",
        spotSource: "unknown" as const,
        decision: undefined,
      },
    };
  });

  const usingDemo = !live || live.assets.length === 0;

  const toggleAlerts = async () => {
    const next = !alertsOn;
    setAlertsOn(next);
    try {
      localStorage.setItem(ALERTS_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (next) {
      await armAudioAndAlerts(true);
    } else {
      setAudioReady(false);
    }
  };

  const toggleSpeak = async () => {
    const next = !speakOn;
    setSpeakOn(next);
    setSpeakAlertsEnabled(next);
    await unlockBuyAlerts();
  };

  const toggleChime = async () => {
    const next = !chimeOn;
    setChimeOn(next);
    setChimeAlertsEnabled(next);
    await unlockBuyAlerts();
  };

  return (
    <div className="obs-root">
      <header className="obs-head">
        <div className="hdr-title" title={BLEEPBLORP_TITLE}>
          {BLEEPBLORP_TITLE}
        </div>
        <div
          className="hdr-controls"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--ui-sm)",
            color: "var(--muted)",
            textAlign: "right",
            lineHeight: 1.2,
            flexShrink: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 4,
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <VoiceSampleMenu disabled={!alertsOn || !speakOn} />
          <button
            type="button"
            className="hdr-chip"
            onClick={() => void toggleSpeak()}
            disabled={!alertsOn}
            title={
              !alertsOn
                ? "Turn Alerts on to use voice"
                : speakOn
                  ? "Spoken Buy alerts on — click to mute voice"
                  : "Click to speak Buy alerts (select a voice first)"
            }
            style={{
              border: `1px solid ${
                alertsOn && speakOn ? "var(--accent)" : "var(--border)"
              }`,
              background: alertsOn && speakOn ? "var(--a-bg)" : "transparent",
              color: alertsOn && speakOn ? "var(--accent)" : "var(--muted)",
              cursor: alertsOn ? "pointer" : "not-allowed",
              opacity: alertsOn ? 1 : 0.45,
            }}
          >
            {speakOn ? "Vox" : "Vox·off"}
          </button>
          <ChimeSampleMenu disabled={!alertsOn || !chimeOn} />
          <button
            type="button"
            className="hdr-chip"
            onClick={() => void toggleChime()}
            disabled={!alertsOn}
            title={
              !alertsOn
                ? "Turn Alerts on to use the chime"
                : chimeOn
                  ? "Chime on with Buy alerts — click for voice-only (or silent if Voice is off)"
                  : "Chime off — click to restore the Buy alert chime"
            }
            style={{
              border: `1px solid ${
                alertsOn && chimeOn ? "var(--accent)" : "var(--border)"
              }`,
              background: alertsOn && chimeOn ? "var(--a-bg)" : "transparent",
              color: alertsOn && chimeOn ? "var(--accent)" : "var(--muted)",
              cursor: alertsOn ? "pointer" : "not-allowed",
              opacity: alertsOn ? 1 : 0.45,
            }}
          >
            {chimeOn ? "Chime" : "Chime·off"}
          </button>
          <button
            type="button"
            className="hdr-chip"
            data-alerts-toggle
            onClick={() => void toggleAlerts()}
            title="Master switch — with Alerts on, use Voice and/or Chime for Buy lights"
            style={{
              border: `1px solid ${alertsOn ? "var(--accent)" : "var(--warn)"}`,
              background: alertsOn ? "var(--a-bg)" : "transparent",
              color: alertsOn ? "var(--accent)" : "var(--warn)",
              cursor: "pointer",
            }}
          >
            {alertsOn ? "Alert" : "Alert·off"}
          </button>
          <span className="hdr-status" title={err ?? undefined}>
            <span style={{ color: connected ? "var(--accent)" : "var(--danger)" }}>
              {connected ? "SSE" : "SSE·off"}
            </span>
            {usingDemo ? " ·demo" : ""}
            {live?.kalshiWs.connected ? " ·CFB" : " ·approx"}
          </span>
        </div>
      </header>

      {live?.scorecard ? (
        <ScorecardStrip scorecard={live.scorecard} />
      ) : null}

      <div className="obs-grid">
        {rows.map(({ market, meta }) => (
          <div
            key={market.symbol}
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
              marketTicker={meta.ticker}
              spotSource={meta.spotSource}
              spotDetail={meta.spotDetail}
              decision={meta.decision}
            />
          </div>
        ))}
      </div>
      <footer className="legal-foot" title={BLEEPBLORP_DISCLAIMER_SHORT}>
        {BLEEPBLORP_DISCLAIMER_SHORT}
      </footer>
    </div>
  );
}
