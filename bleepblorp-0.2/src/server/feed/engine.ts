import type { LiveAssetState, LiveAssetTrade, LiveFeedPayload, LivePnlSummary } from "@/lib/liveTypes";
import type { TrailWrSnapshot } from "@/lib/kalshiHold";
import type { DayScorecard } from "@/lib/performanceTypes";
import type { AssetSymbol, DecisionResult, MarketSnapshot } from "@/lib/types";
import { computeChopRegime } from "@/lib/chop";
import { decide, reconcileModeSides } from "@/lib/decide";
import { sigmaT } from "@/lib/indicators";
import { computeTrendRegime } from "@/lib/trend";
import { StrikeCrossTracker } from "@/server/feed/strikeCrossTracker";
import { ASSETS } from "@/server/config";
import { CandleBuilder, fetchSeedCandles } from "@/server/indicators/candles";
import { computeIndicators, atrRolling } from "@/server/indicators/compute";
import { hasKalshiCredentials } from "@/server/kalshi/auth";
import { fetchAllOpen15mMarkets, fetchMarketBbo, type KalshiMarketQuote } from "@/server/kalshi/rest";
import { KalshiWsClient, type BookTick, type SpotTick } from "@/server/kalshi/ws";
import { PerformanceTracker } from "@/server/performance/tracker";
import { clearPaperJournal } from "@/server/performance/journal";
import { ModeAStickyGate, patchModeALane, readModeALane } from "@/server/feed/modeASticky";
import { getPathRecorder } from "@/server/research/recorder";
import { approximateAllRti } from "@/server/spot/fallbackRti";
import {
  BOOK_RECONCILE_MS,
  DISCOVERY_OFFSET_MS,
  LIFECYCLE_REFRESH_MS,
  MARKET_DISCOVERY_MS,
  MARKET_ROLLOVER_MS,
  SCORECARD_MS,
  TICK_MS,
  WS_START_DELAY_MS,
  YIELDS_TO_COMPANION,
} from "@/server/kalshi/pacing";
import {
  getCompanionLiveBot,
  peekCompanionLiveBot,
  type CompanionLiveBot,
} from "@/server/kalshi/companion";

export type { LiveAssetState, LiveFeedPayload };

/** Bump to force a fresh engine after hot-reload / seed fixes. */
const FEED_ENGINE_VERSION = 82;

/** Strike TBD polls — separate from full rollover thrash. */
const STRIKE_FILL_MS = 5_000;
/** Treat WS ticker/orderbook as fresh below this age. */
const BOOK_FRESH_MS = 800;
/** Max concurrent dashboard SSE slots (leaked tabs used to wedge the event loop). */
const SSE_LISTENER_CAP = 8;
/** Min gap between book-driven *light* SSE publishes (quotes only). */
const BOOK_PUBLISH_MIN_MS = 300;

type Listener = (payload: LiveFeedPayload, json: string) => void;

type SseSlot = {
  send: Listener;
  /** Close the HTTP stream when this slot is stolen or send fails. */
  evict?: () => void;
};

/** Drop factor essays from SSE — dashboard boxes only use action/side/reason/conf. */
function slimDecision(d: DecisionResult): DecisionResult {
  const strip = <T extends { factors?: unknown[] }>(rec: T): T =>
    rec?.factors?.length ? { ...rec, factors: [] } : rec;
  return {
    ...d,
    modeA: strip(d.modeA),
    modeAMom: d.modeAMom ? strip(d.modeAMom) : d.modeAMom,
    modeARev: d.modeARev ? strip(d.modeARev) : d.modeARev,
    modeB: strip(d.modeB),
  };
}

function slimAssetsForSse(assets: LiveAssetState[]): LiveAssetState[] {
  return assets.map((a) => ({
    ...a,
    decision: slimDecision(a.decision),
  }));
}

type SubscribeOpts = {
  /** Never evict — the live trader must keep receiving ticks. */
  persist?: boolean;
  /** Called when the server drops this slot (cap eviction / dead socket). */
  onEvict?: () => void;
};

export type FeedEngineOptions = {
  /** Trader process: do not open mid-market paper tickets. */
  skipModeAPaper?: boolean;
  /** Live trader: do not shadow Mode B into the paper journal. */
  skipModeBPaper?: boolean;
  /** Shown on the dashboard so live is not labeled paper. */
  traderMode?: "paper" | "live";
};

class LiveFeedEngine {
  private listeners = new Set<SseSlot>();
  private persistentListeners = new Set<SseSlot>();
  private started = false;
  private sseEvictions = 0;
  private seeding = false;
  private markets = new Map<AssetSymbol, KalshiMarketQuote>();
  private bookTsMs = new Map<AssetSymbol, number>();
  private spot = new Map<
    AssetSymbol,
    { price: number; source: "cfbenchmarks" | "fallback"; sources?: string[]; tsMs: number }
  >();
  private candles = new Map<AssetSymbol, CandleBuilder>();
  private seedOk = new Map<AssetSymbol, boolean>();
  /** Once CFB RTI prints, candle bars (and ATR) must not mix exchange mids. */
  private cfbCandleLive = new Map<AssetSymbol, boolean>();
  /** CFB-only 1m bars — Mode B atr1m source so both processes share the same vol path. */
  private cfbCandles = new Map<AssetSymbol, CandleBuilder>();
  private kalshiWsStatus = {
    connected: false,
    detail: "Not started",
  };
  private errors: string[] = [];
  private lastPayload: LiveFeedPayload | null = null;
  private ws: KalshiWsClient | null = null;
  private perf: PerformanceTracker;
  private modeASticky = new ModeAStickyGate();
  private strikeCross = new StrikeCrossTracker();
  private marketTimer: ReturnType<typeof setInterval> | null = null;
  private spotTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private seedTimer: ReturnType<typeof setInterval> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private lastBookPublishMs = 0;
  private marketRefreshInFlight = false;
  private lastMarketRefreshMs = 0;
  private lastStrikeFillMs = 0;
  private rolloverMode = false;
  private lifecycleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private bookReconcileInFlight = false;
  private lastBookReconcileMs = 0;
  private bookSource = new Map<AssetSymbol, string>();
  private bookSeedInFlight = new Set<string>();
  private cachedScorecard: DayScorecard | null = null;
  private cachedLivePnl: LivePnlSummary | undefined;
  private lastScorecardMs = 0;
  /** True when the next publish should attach a fresh scorecard blob. */
  private scorecardDirty = true;
  private scorecardRebuildScheduled = false;
  private lastPayloadJson: string | null = null;
  private recorder = getPathRecorder();
  private traderMode: "paper" | "live";
  private traderOverlay: Record<string, LiveAssetTrade> = {};
  private traderHold: string | null = null;
  /** 2h/−2¢ pause, 1h/+0.25¢ resume. Gate matches scorecard 2h column; hold-paper excluded. */
  private wrHold = false;
  private wrHoldReason: string | null = null;
  private trailWr: TrailWrSnapshot | null = null;
  /** Mid-market per-lane HOLD: 1h/−2¢ pause, 30m/+0.25¢ resume. */
  private momHold = false;
  private momHoldReason: string | null = null;
  private trailWrMom: TrailWrSnapshot | null = null;
  private revHold = false;
  private revHoldReason: string | null = null;
  private trailWrRev: TrailWrSnapshot | null = null;
  private startedAtMs = 0;

  constructor(opts: FeedEngineOptions = {}) {
    this.traderMode = opts.traderMode === "live" ? "live" : "paper";
    this.perf = new PerformanceTracker({
      skipModeA: Boolean(opts.skipModeAPaper),
      skipModeB: Boolean(opts.skipModeBPaper),
    });
  }

  subscribe(listener: Listener, opts?: SubscribeOpts): () => void {
    // Hard cap leaked SSE subscribers. Never evict the trader's persistent
    // listener — that is how Buy boxes lit while no orders went out.
    const slot: SseSlot = { send: listener, evict: opts?.onEvict };
    if (opts?.persist) {
      this.persistentListeners.add(slot);
    } else {
      while (this.listeners.size >= SSE_LISTENER_CAP) {
        const oldest = this.listeners.values().next().value;
        if (!oldest) break;
        this.listeners.delete(oldest);
        this.sseEvictions += 1;
        // Must close the HTTP stream — deleting the send fn alone leaves the
        // browser tab open with no data until the 15s client stall watchdog.
        try {
          oldest.evict?.();
        } catch {
          /* ignore */
        }
      }
      this.listeners.add(slot);
    }
    this.ensureStarted();
    // New tabs must get the cached Paper strip immediately. Light book
    // publishes omit scorecard on the wire, so lastPayloadJson alone leaves
    // hard-reload waiting ~SCORECARD_MS for the next dirty push.
    if (this.lastPayload) {
      const snap = this.payloadWithCachedScorecard(this.lastPayload);
      try {
        slot.send(snap, JSON.stringify(snap));
      } catch {
        try {
          slot.evict?.();
        } catch {
          /* ignore */
        }
        this.listeners.delete(slot);
        this.persistentListeners.delete(slot);
      }
    }
    return () => {
      this.listeners.delete(slot);
      this.persistentListeners.delete(slot);
    };
  }

  /** In-memory Paper strip if already built — never hits the journal. */
  getCachedPaperScorecard(): DayScorecard | null {
    return this.cachedScorecard;
  }

  getSnapshot(): LiveFeedPayload | null {
    return this.lastPayload;
  }

  /** Tiny pulse for the dashboard status line — not the full SSE payload. */
  getPulse(): {
    tsMs: number;
    feedAgeMs: number | null;
    kalshiWs: { connected: boolean; detail: string };
    traderMode: "paper" | "live";
    sseListeners: number;
    sseEvictions: number;
    traderListeners: number;
    hold: string | null;
    trailWr: TrailWrSnapshot | null;
    holdMom: string | null;
    trailWrMom: TrailWrSnapshot | null;
    holdRev: string | null;
    trailWrRev: TrailWrSnapshot | null;
    /** Soft Kalshi yield when sharing a key with a live companion (sevenstreams). */
    yieldsToCompanion: boolean;
    /** @deprecated alias of yieldsToCompanion — kept for older dashboards. */
    yieldsToEomTrader: boolean;
    companionLiveBot: CompanionLiveBot;
    discoveryOffsetMs: number;
    discoveryMs: number;
  } {
    void getCompanionLiveBot();
    const companion = peekCompanionLiveBot();
    const snap = this.lastPayload;
    return {
      tsMs: snap?.tsMs ?? 0,
      feedAgeMs: snap ? Date.now() - snap.tsMs : null,
      kalshiWs: snap?.kalshiWs ?? { connected: false, detail: "starting" },
      traderMode: this.traderMode,
      sseListeners: this.listeners.size,
      sseEvictions: this.sseEvictions,
      traderListeners: this.persistentListeners.size,
      hold: snap?.hold ?? this.wrHoldReason,
      trailWr: snap?.trailWr ?? this.trailWr,
      holdMom: snap?.holdMom ?? this.momHoldReason,
      trailWrMom: snap?.trailWrMom ?? this.trailWrMom,
      holdRev: snap?.holdRev ?? this.revHoldReason,
      trailWrRev: snap?.trailWrRev ?? this.trailWrRev,
      yieldsToCompanion: YIELDS_TO_COMPANION,
      yieldsToEomTrader: YIELDS_TO_COMPANION,
      companionLiveBot: companion,
      discoveryOffsetMs: DISCOVERY_OFFSET_MS,
      discoveryMs: MARKET_DISCOVERY_MS,
    };
  }

  /** Start Kalshi IO even if no dashboard is connected (droplet 24/7 paper). */
  wake() {
    this.ensureStarted();
  }

  /** Attach live order/PnL state so the dashboard trade box can update. */
  setTraderOverlay(
    overlay: Record<string, LiveAssetTrade>,
    publish = false,
    hold?: string | null,
  ) {
    this.traderOverlay = overlay;
    if (hold !== undefined) this.traderHold = hold;
    if (!publish || !this.lastPayload) return;
    const now = Date.now();
    this.lastPayload = {
      ...this.lastPayload,
      tsMs: now,
      hold: this.wrHoldReason ?? this.traderHold,
      trailWr: this.trailWr,
      holdMom: this.momHoldReason,
      trailWrMom: this.trailWrMom,
      holdRev: this.revHoldReason,
      trailWrRev: this.trailWrRev,
      livePnl: this.cachedLivePnl,
      // Keep cached card in memory; wire omit (overlay is high-frequency).
      scorecard: this.cachedScorecard ?? this.lastPayload.scorecard,
      assets: this.lastPayload.assets.map((a) => ({
        ...a,
        trade: overlay[a.marketTicker],
      })),
    };
    this.emitPayload(false);
  }

  /** Fresh paper scorecard (All / 24h / 2h + per-asset), independent of last SSE payload. */
  getPaperScorecard(): DayScorecard {
    return this.perf.getScorecard();
  }

  /** Clear paper journal + in-memory tickets and republish a zeroed scorecard. */
  resetPaper() {
    clearPaperJournal();
    this.perf.reset();
    void import("@/lib/exitOptStore").then((m) => m.invalidateExitOptCache());
    void import("@/server/performance/exitOptScheduler").then((m) =>
      m.scheduleExitOptRebuild("scorecard-reset"),
    );
    void import("@/server/performance/sessionOptStore").then((m) =>
      m.invalidateSessionOptCache(),
    );
    void import("@/server/performance/sessionOptScheduler").then((m) =>
      m.scheduleSessionOptRebuild("reset"),
    );
    this.cachedScorecard = this.perf.getScorecard();
    this.lastScorecardMs = Date.now();
    this.scorecardDirty = true;
    this.publish();
    return this.lastPayload?.scorecard ?? this.cachedScorecard;
  }

  /** Reset mid-market lanes only — keep end-of-market journal / opens. */
  resetMidMarketPaper() {
    this.perf.resetModeA();
    void import("@/lib/exitOptStore").then((m) => m.invalidateExitOptCache());
    void import("@/server/performance/exitOptScheduler").then((m) =>
      m.scheduleExitOptRebuild("mid-market-reset"),
    );
    void import("@/server/performance/sessionOptStore").then((m) =>
      m.invalidateSessionOptCache(),
    );
    void import("@/server/performance/sessionOptScheduler").then((m) =>
      m.scheduleSessionOptRebuild("reset"),
    );
    this.cachedScorecard = this.perf.getScorecard();
    this.lastScorecardMs = Date.now();
    this.scorecardDirty = true;
    this.publish();
    return this.lastPayload?.scorecard ?? this.cachedScorecard;
  }

  private ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.startedAtMs = Date.now();
    for (const a of ASSETS) {
      this.candles.set(a, new CandleBuilder());
      this.cfbCandles.set(a, new CandleBuilder());
      this.seedOk.set(a, false);
      this.cfbCandleLive.set(a, false);
    }

    void this.bootstrapCandles();
    void this.refreshFallbackSpot();
    // Warm scorecard-era Rec / sit-out off-process — does not touch the feed event loop.
    void import("@/server/performance/exitOptScheduler").then((m) =>
      m.scheduleExitOptBootRebuild(),
    );
    void import("@/server/performance/sessionOptScheduler").then((m) =>
      m.scheduleSessionOptBootRebuild(),
    );

    this.ws = new KalshiWsClient(
      (tick) => this.onSpotTick(tick),
      (book) => this.onBookTick(book),
      (status) => {
        const age = this.ws?.lastBookAgeMs();
        const n = this.ws?.bookUpdates() ?? 0;
        this.kalshiWsStatus = {
          ...status,
          detail:
            status.connected && age != null
              ? `${status.detail} · book ${age}ms ago (${n} upd)`
              : status.detail,
        };
        this.publish();
      },
      (ev) => {
        // Coalesce lifecycle storms (created/activated × 4 series) into one refresh.
        if (
          ev.eventType === "created" ||
          ev.eventType === "activated" ||
          ev.eventType === "determined" ||
          ev.eventType === "settled" ||
          ev.eventType === "deactivated"
        ) {
          this.scheduleLifecycleRefresh();
        }
      },
    );
    // Yield first REST/WS burst when a co-located live companion may share the key.
    const startKalshiIo = () => {
      void this.refreshMarkets();
      this.marketTimer = setInterval(
        () => void this.refreshMarkets(),
        MARKET_DISCOVERY_MS,
      );
    };
    if (DISCOVERY_OFFSET_MS > 0) {
      setTimeout(startKalshiIo, DISCOVERY_OFFSET_MS);
    } else {
      startKalshiIo();
    }
    if (WS_START_DELAY_MS > 0) {
      setTimeout(() => this.ws?.start(), WS_START_DELAY_MS);
    } else {
      this.ws.start();
    }

    this.spotTimer = setInterval(() => void this.refreshFallbackSpot(), 2_000);
    this.tickTimer = setInterval(() => this.onTick(), TICK_MS);
    // Keep trying until every asset has enough history for Stoch RSI
    this.seedTimer = setInterval(() => void this.bootstrapCandles(true), 20_000);
    this.watchTimer = setInterval(() => this.watchdog(), 2_000);
    // Warm Paper strip immediately — do not wait for the first SCORECARD_MS gate.
    this.scheduleScorecardRebuild(true);
  }

  private watchdog() {
    const ts = this.lastPayload?.tsMs ?? 0;
    const age = Date.now() - ts;
    if (ts > 0 && age > 4_000) {
      this.errors.push(`FEED STALL ${age}ms — forcing publish`);
      if (this.errors.length > 24) this.errors.splice(0, this.errors.length - 24);
      this.publish();
    }
  }

  private scheduleLifecycleRefresh() {
    this.rolloverMode = true;
    if (this.lifecycleRefreshTimer) return;
    this.lifecycleRefreshTimer = setTimeout(() => {
      this.lifecycleRefreshTimer = null;
      void this.refreshMarkets(true);
    }, LIFECYCLE_REFRESH_MS);
  }

  private enterRolloverMode() {
    this.rolloverMode = true;
    void this.refreshMarkets(true);
  }

  private onTick() {
    const now = Date.now();
    let nearEnd = false;
    let anyExpired = false;
    for (const m of this.markets.values()) {
      const left = m.closeTimeMs - now;
      if (left <= 8_000) nearEnd = true;
      if (left <= 0) anyExpired = true;
    }
    if (anyExpired) this.enterRolloverMode();
    else if (nearEnd) this.rolloverMode = true;

    if (this.rolloverMode) {
      // Exit rollover once every asset has a live window with time left.
      // Pending strike alone must NOT keep us in 1Hz REST thrash.
      const allFresh = ASSETS.every((a) => {
        const m = this.markets.get(a);
        return !!m && m.closeTimeMs - now > 30_000;
      });
      if (allFresh) this.rolloverMode = false;
      else if (now - this.lastMarketRefreshMs >= MARKET_ROLLOVER_MS) {
        void this.refreshMarkets(true);
      }
    } else {
      // Gentle strike fill after the new ticker is bound.
      const needsStrike = [...this.markets.values()].some((m) => m.strikePending);
      if (needsStrike && now - this.lastStrikeFillMs >= STRIKE_FILL_MS) {
        this.lastStrikeFillMs = now;
        void this.refreshMarkets(true);
      }
    }

    // Full engine + UI publish on the decision cadence. Book path uses light
    // quote-only publishes so decide/perf/recorder are not re-run 3–5×/sec.
    this.lastBookPublishMs = now;
    this.publish();

    // REST BBO backup whenever ticker is quiet (including rollover).
    if (now - this.lastBookReconcileMs >= BOOK_RECONCILE_MS) {
      this.lastBookReconcileMs = now;
      void this.reconcileBooksFromRest();
    }
  }

  /** Compare local BBO to Kalshi GET /markets/{ticker}; overwrite when ≥1¢ off. */
  private async reconcileBooksFromRest() {
    if (this.bookReconcileInFlight || this.markets.size === 0) return;
    this.bookReconcileInFlight = true;
    try {
      const entries = [...this.markets.entries()];
      const results = await Promise.all(
        entries.map(async ([symbol, m]) => {
          const bookAge = Date.now() - (this.bookTsMs.get(symbol) ?? 0);
          const src = this.bookSource.get(symbol) ?? "";
          // Trust fresh WS ticker — do not fight it with REST.
          if (bookAge < BOOK_FRESH_MS && (src === "ticker" || src === "orderbook")) {
            return { symbol, m, bbo: null as Awaited<ReturnType<typeof fetchMarketBbo>> };
          }
          const bbo = await fetchMarketBbo(m.marketTicker);
          return { symbol, m, bbo };
        }),
      );
      let corrected = false;
      for (const { symbol, m, bbo } of results) {
        if (!bbo) continue;
        const dBid = Math.abs(m.bidUp - bbo.bidUp);
        const dAsk = Math.abs(m.askUp - bbo.askUp);
        if (dBid < 0.0095 && dAsk < 0.0095) continue;
        this.markets.set(symbol, {
          ...m,
          bidUp: bbo.bidUp,
          askUp: bbo.askUp,
          bidDown: bbo.bidDown,
          askDown: bbo.askDown,
        });
        this.bookTsMs.set(symbol, Date.now());
        this.bookSource.set(symbol, "rest_mkt");
        corrected = true;
      }
      if (corrected) this.publishBookThrottled();
    } catch (err) {
      this.errors.push(
        `Book reconcile: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.bookReconcileInFlight = false;
    }
  }

  /** Immediately seed BBO for a newly bound ticker (bridge until WS snapshot). */
  private async seedBookFromRest(symbol: AssetSymbol, marketTicker: string) {
    if (this.bookSeedInFlight.has(marketTicker)) return;
    this.bookSeedInFlight.add(marketTicker);
    try {
      const bbo = await fetchMarketBbo(marketTicker);
      if (!bbo) return;
      const cur = this.markets.get(symbol);
      if (!cur || cur.marketTicker !== marketTicker) return;
      this.markets.set(symbol, {
        ...cur,
        bidUp: bbo.bidUp,
        askUp: bbo.askUp,
        bidDown: bbo.bidDown,
        askDown: bbo.askDown,
      });
      this.bookTsMs.set(symbol, Date.now());
      this.bookSource.set(symbol, "rest_mkt");
      this.publishBookThrottled();
    } catch {
      /* ignore — WS snapshot should follow */
    } finally {
      this.bookSeedInFlight.delete(marketTicker);
    }
  }

  private async bootstrapCandles(onlyMissing = false) {
    if (this.seeding) return;
    this.seeding = true;
    try {
      await Promise.all(
        ASSETS.map(async (a) => {
          // CFB-built bars are the ATR source of truth — never clobber with exchange OHLC.
          if (this.cfbCandleLive.get(a)) {
            this.seedOk.set(a, true);
            return;
          }
          if (onlyMissing && this.seedOk.get(a) && (this.candles.get(a)?.length ?? 0) >= 40) {
            return;
          }
          try {
            const { candles } = await fetchSeedCandles(a, 100);
            // Race: CFB may have arrived while the HTTP seed was in flight.
            if (this.cfbCandleLive.get(a)) {
              this.seedOk.set(a, true);
              return;
            }
            this.candles.get(a)?.seed(candles);
            this.seedOk.set(a, candles.length >= 40);
            this.errors = this.errors.filter((e) => !e.startsWith(`Candle seed ${a}`));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const soft = /451|blocked/i.test(msg)
              ? `Candle seed ${a}: exchange blocked — building from live RTI`
              : `Candle seed ${a}: retrying…`;
            this.errors = this.errors.filter((e) => !e.startsWith(`Candle seed ${a}`));
            // Only surface persistent failures
            if (!onlyMissing) this.errors.push(soft);
            this.seedOk.set(a, false);
          }
        }),
      );
      this.publish();
    } finally {
      this.seeding = false;
    }
  }

  private async refreshMarkets(force = false) {
    if (this.marketRefreshInFlight) return;
    const now = Date.now();
    if (!force && now - this.lastMarketRefreshMs < 200) return;
    this.marketRefreshInFlight = true;
    this.lastMarketRefreshMs = now;
    try {
      const markets = await fetchAllOpen15mMarkets();
      if (!markets.length) {
        // Don't wipe a good book if Kalshi briefly returns nothing at rollover.
        this.errors = this.errors.filter((e) => !e.startsWith("Kalshi markets"));
        this.errors.push("Kalshi markets: empty open set — retrying");
        return;
      }

      // Merge per asset — never drop BTC/SOL/… just because one series refreshed first.
      const seen = new Set<AssetSymbol>();
      for (const m of markets) {
        seen.add(m.symbol);
        const prev = this.markets.get(m.symbol);
        const sameTicker = prev != null && prev.marketTicker === m.marketTicker;

        // Provisional strike: use live spot until Kalshi publishes floor_strike.
        let strike = m.strike;
        let strikePending = !!m.strikePending || !Number.isFinite(strike);
        if (strikePending) {
          const spot = this.spot.get(m.symbol)?.price;
          if (sameTicker && prev && Number.isFinite(prev.strike) && !prev.strikePending) {
            strike = prev.strike;
            strikePending = false;
          } else if (sameTicker && prev && Number.isFinite(prev.strike)) {
            strike = prev.strike;
          } else if (spot != null && Number.isFinite(spot)) {
            strike = spot;
          }
        }

        const merged: KalshiMarketQuote = { ...m, strike, strikePending };
        // Series-list yes_bid/ask lags GET /markets/{ticker} and WS ticker by
        // several ¢. Never let discovery overwrite a live same-ticker book.
        if (sameTicker && prev) {
          this.markets.set(m.symbol, {
            ...merged,
            askUp: prev.askUp,
            bidUp: prev.bidUp,
            askDown: prev.askDown,
            bidDown: prev.bidDown,
          });
        } else {
          this.markets.set(m.symbol, merged);
          this.bookSource.set(m.symbol, "rest_mkt");
          if (!sameTicker) {
            this.strikeCross.reset(m.marketTicker);
            this.bookTsMs.delete(m.symbol);
            // Don't sit on stale series-list quotes while WS resubscribes.
            void this.seedBookFromRest(m.symbol, m.marketTicker);
          }
        }
      }

      // Drop expired tickers we failed to replace (avoids stuck sec=0 / 100¢ books).
      for (const [sym, m] of this.markets) {
        if (!seen.has(sym) && m.closeTimeMs <= now) {
          this.markets.delete(sym);
          this.bookTsMs.delete(sym);
        }
      }

      this.ws?.setBookMarkets([...this.markets.values()].map((q) => q.marketTicker));
      this.errors = this.errors.filter((e) => !e.startsWith("Kalshi markets"));
      // Only missing / expired markets keep full rollover mode.
      // TBD strike is filled on a slower cadence (see onTick).
      if (markets.length < ASSETS.length) {
        this.enterRolloverMode();
      }
    } catch (err) {
      this.errors.push(`Kalshi markets: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.marketRefreshInFlight = false;
    }
    this.publish();
  }

  private async refreshFallbackSpot() {
    try {
      const approx = await approximateAllRti();
      const now = Date.now();
      for (const a of ASSETS) {
        const existing = this.spot.get(a);
        if (existing?.source === "cfbenchmarks" && now - existing.tsMs < 5_000) continue;
        const r = approx[a];
        if (!r) continue;
        this.onSpotTick({
          symbol: a,
          price: r.price,
          source: "fallback",
          sources: r.sources,
          tsMs: now,
        });
      }
    } catch (err) {
      this.errors.push(`RTI fallback: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onSpotTick(tick: SpotTick) {
    this.spot.set(tick.symbol, {
      price: tick.price,
      source: tick.source,
      sources: tick.sources,
      tsMs: tick.tsMs,
    });

    if (tick.source === "cfbenchmarks") {
      this.cfbCandleLive.set(tick.symbol, true);
      this.candles.get(tick.symbol)?.tick(tick.price, tick.tsMs);
      this.cfbCandles.get(tick.symbol)?.tick(tick.price, tick.tsMs);
      return;
    }

    // Fallback mids: keep UI spot alive before CFB, but do not widen ATR after RTI is live.
    if (!this.cfbCandleLive.get(tick.symbol)) {
      this.candles.get(tick.symbol)?.tick(tick.price, tick.tsMs);
    }
  }

  private onBookTick(book: BookTick) {
    for (const [symbol, m] of this.markets) {
      if (m.marketTicker !== book.marketTicker) continue;
      this.markets.set(symbol, {
        ...m,
        askUp: book.askUp,
        bidUp: book.bidUp,
        askDown: book.askDown,
        bidDown: book.bidDown,
      });
      this.bookTsMs.set(symbol, book.tsMs);
      this.bookSource.set(symbol, book.source);
      this.publishBookThrottled();
      return;
    }
  }

  /**
   * Quote-only SSE push for book moves. Does NOT re-run decide / paper / research —
   * that work stays on the TICK_MS engine path. Re-running it on every BBO flicker
   * was freezing the UI (and bloating pathMarks).
   */
  private publishBookThrottled() {
    const now = Date.now();
    if (now - this.lastBookPublishMs < BOOK_PUBLISH_MIN_MS) return;
    this.lastBookPublishMs = now;
    if (!this.lastPayload?.assets?.length) {
      this.publish();
      return;
    }
    if (this.ws && this.kalshiWsStatus.connected) {
      const age = this.ws.lastBookAgeMs();
      const n = this.ws.bookUpdates();
      const base =
        this.kalshiWsStatus.detail.split(" · book ")[0] ??
        this.kalshiWsStatus.detail;
      this.kalshiWsStatus = {
        connected: true,
        detail:
          age != null
            ? `${base} · book ${age}ms ago (${n} upd)`
            : `${base} · book waiting`,
      };
    }
    const assets = this.lastPayload.assets.map((a) =>
      this.patchAssetLiveQuotes(a, now),
    );
    const pushScorecard = this.scorecardDirty && Boolean(this.cachedScorecard);
    // Keep scorecard on the in-memory snapshot for new SSE subscribers.
    this.lastPayload = {
      ...this.lastPayload,
      tsMs: now,
      kalshiWs: this.kalshiWsStatus,
      assets: slimAssetsForSse(assets),
      scorecard: this.cachedScorecard ?? this.lastPayload.scorecard,
      hold: this.wrHoldReason ?? this.traderHold,
      livePnl: this.cachedLivePnl,
    };
    this.emitPayload(pushScorecard);
  }

  /** Refresh spot / book / clock on a cached asset row without re-deciding. */
  private patchAssetLiveQuotes(
    asset: LiveAssetState,
    now: number,
  ): LiveAssetState {
    const symbol = asset.snapshot.symbol;
    const m = this.markets.get(symbol);
    const s = this.spot.get(symbol);
    if (!m || !s) return asset;
    const secondsLeft = Math.max(0, Math.floor((m.closeTimeMs - now) / 1000));
    const bookTs = this.bookTsMs.get(symbol) ?? 0;
    return {
      ...asset,
      marketTicker: m.marketTicker,
      exchangeIndex: m.exchangeIndex,
      spotSource: s.source,
      spotSourcesDetail: s.sources,
      bookSource: this.bookSource.get(symbol),
      updatedAtMs: Math.max(s.tsMs, bookTs, now),
      trade: this.traderOverlay[m.marketTicker] ?? asset.trade,
      snapshot: {
        ...asset.snapshot,
        spot: s.price,
        strike: m.strike,
        secondsLeft,
        askUp: m.askUp,
        bidUp: m.bidUp,
        askDown: m.askDown,
        bidDown: m.bidDown,
      },
    };
  }

  private buildPayload(): LiveFeedPayload {
    const assets: LiveAssetState[] = [];
    const now = Date.now();
    this.refreshWrHold();

    for (const symbol of ASSETS) {
      const m = this.markets.get(symbol);
      const s = this.spot.get(symbol);
      const builder = this.candles.get(symbol);
      if (!m || !s || !builder) continue;

      const series = builder.withLive();
      const ind = computeIndicators(series);
      const cfbSeries = this.cfbCandles.get(symbol)?.withLive() ?? [];
      // Rolling last-15m CFB ATR — matches across processes without synced restarts.
      const cfbAtr = atrRolling(cfbSeries);
      const secondsLeft = Math.max(0, Math.floor((m.closeTimeMs - now) / 1000));
      // Relative 1.5 bps of spot. An absolute 0.01 floor wrecks sub-dollar coins (DOGE/XRP).
      const atrFloor = Math.max(s.price * 0.00015, 1e-8);
      // Mode B / finish-conf σ uses CFB-only ATR so co-located processes do not
      // diverge on exchange-seed vs long-lived CFB history. Stoch/BB still use seed.
      const atr1m = Math.max(cfbAtr ?? atrFloor, atrFloor);
      const sig = sigmaT(atr1m, secondsLeft);
      const crossSample = this.strikeCross.sample(
        m.marketTicker,
        s.price,
        m.strike,
        sig,
      );
      const chop = computeChopRegime({
        m: {
          symbol,
          spot: s.price,
          strike: m.strike,
          secondsLeft,
          askUp: m.askUp,
          bidUp: m.bidUp,
          askDown: m.askDown,
          bidDown: m.bidDown,
          atr1m,
          stochK: ind.stoch?.k ?? 50,
          stochKPrev: ind.stoch?.kPrev ?? (ind.stoch?.k ?? 50),
          bbMid: ind.bb?.mid ?? s.price,
          bbUpper: ind.bb?.upper ?? s.price * 1.001,
          bbLower: ind.bb?.lower ?? s.price * 0.999,
        },
        candles: series,
        crossCount: crossSample.crossCount,
        pctTimeNearStrike: crossSample.pctTimeNearStrike,
      });
      const trend = computeTrendRegime({
        m: {
          symbol,
          spot: s.price,
          strike: m.strike,
          secondsLeft,
          askUp: m.askUp,
          bidUp: m.bidUp,
          askDown: m.askDown,
          bidDown: m.bidDown,
          atr1m,
          stochK: ind.stoch?.k ?? 50,
          stochKPrev: ind.stoch?.kPrev ?? (ind.stoch?.k ?? 50),
          bbMid: ind.bb?.mid ?? s.price,
          bbUpper: ind.bb?.upper ?? s.price * 1.001,
          bbLower: ind.bb?.lower ?? s.price * 0.999,
        },
        candles: series,
        crossCount: crossSample.crossCount,
        pctTimeNearStrike: crossSample.pctTimeNearStrike,
        chop,
      });

      const snapshot: MarketSnapshot = {
        symbol,
        spot: s.price,
        strike: m.strike,
        secondsLeft,
        askUp: m.askUp,
        bidUp: m.bidUp,
        askDown: m.askDown,
        bidDown: m.bidDown,
        atr1m,
        stochK: ind.stoch?.k ?? 50,
        stochKPrev: ind.stoch?.kPrev ?? (ind.stoch?.k ?? 50),
        bbMid: ind.bb?.mid ?? s.price,
        bbUpper: ind.bb?.upper ?? s.price * 1.001,
        bbLower: ind.bb?.lower ?? s.price * 0.999,
        chop,
        trend,
      };

      // Record before any strategy sees the tick — the research stream has to be
      // unconditional or it can't be used to judge the strategies later.
      try {
        this.recorder.record({
          snapshot,
          marketTicker: m.marketTicker,
          bookSource: this.bookSource.get(symbol),
        });
      } catch {
        /* research logging must never break the feed */
      }

      const rawDecision = decide(snapshot);
      const stickyDecision = this.modeASticky.apply(
        symbol,
        m.marketTicker,
        secondsLeft,
        rawDecision,
      );
      // Sticky can keep an old Mode A Buy; drop it if it fights live Mode B.
      let decision = reconcileModeSides(stickyDecision);
      try {
        this.perf.onTick({
          marketTicker: m.marketTicker,
          snapshot,
          decision,
          leanLabel: decision.indicators.leanLabel,
        });
        for (const lane of this.perf.wasModeALaneStopped(symbol)) {
          this.modeASticky.clear(symbol, lane);
          const rec = readModeALane(decision, lane);
          if (rec.action === "buy") {
            decision = patchModeALane(decision, lane, {
              action: "wait",
              side: rec.side,
              confidence: rec.confidence,
              reason: "Stopped out — Wait.",
              factors: rec.factors,
            });
          }
        }
        if (this.perf.isModeBStopped(m.marketTicker)) {
          decision = {
            ...decision,
            modeB: {
              ...decision.modeB,
              action: "wait",
              reason: "Stopped out — Wait.",
            },
          };
          // Re-check Mode A vs Mode B after forcing B to Wait (A may be free again).
          decision = reconcileModeSides(decision);
        }
      } catch {
        /* never break the live feed for journal errors */
      }

      const bookTs = this.bookTsMs.get(symbol) ?? 0;
      assets.push({
        snapshot,
        marketTicker: m.marketTicker,
        exchangeIndex: m.exchangeIndex,
        spotSource: s.source,
        spotSourcesDetail: s.sources,
        bookSource: this.bookSource.get(symbol),
        updatedAtMs: Math.max(s.tsMs, bookTs, now),
        decision,
        trade: this.traderOverlay[m.marketTicker],
      });
    }

    try {
      this.perf.drainStoppedModeA();
    } catch {
      /* ignore */
    }

    let scorecard: DayScorecard | undefined;
    let scorecardFresh = false;
    try {
      // Full scorecard can stall the event loop — rebuild off the hot path.
      // Attach a cached card whenever we have one and it's marked dirty (boot /
      // just rebuilt). Otherwise omit so book ticks stay small.
      if (
        !this.cachedScorecard ||
        now - this.lastScorecardMs >= SCORECARD_MS
      ) {
        this.lastScorecardMs = now;
        this.scheduleScorecardRebuild();
      }
      if (this.scorecardDirty && this.cachedScorecard) {
        scorecard = this.cachedScorecard;
        scorecardFresh = true;
      }
    } catch {
      if (this.scorecardDirty && this.cachedScorecard) {
        scorecard = this.cachedScorecard;
        scorecardFresh = true;
      }
    }
    if (scorecardFresh) this.scorecardDirty = false;

    this.refreshWrHold();

    return {
      tsMs: now,
      kalshiWs: this.kalshiWsStatus,
      credentialsConfigured: hasKalshiCredentials(),
      traderMode: this.traderMode,
      assets: slimAssetsForSse(assets),
      errors: this.errors.slice(-8),
      scorecard,
      livePnl: this.cachedLivePnl,
      hold: this.wrHoldReason ?? this.traderHold,
      trailWr: this.trailWr,
      holdMom: this.momHoldReason,
      trailWrMom: this.trailWrMom,
      holdRev: this.revHoldReason,
      trailWrRev: this.trailWrRev,
    };
  }

  /**
   * Expectancy HOLD sit-outs removed for EOM and mid-market.
   */
  private refreshWrHold() {
    this.wrHold = false;
    this.wrHoldReason = null;
    this.trailWr = null;
    this.momHold = false;
    this.momHoldReason = null;
    this.trailWrMom = null;
    this.revHold = false;
    this.revHoldReason = null;
    this.trailWrRev = null;
  }

  private refreshModeALaneHold(_lane: "mom" | "rev") {
    /* mid-market HOLD removed */
  }

  private scheduleScorecardRebuild(force = false) {
    if (this.scorecardRebuildScheduled) return;
    this.scorecardRebuildScheduled = true;
    setTimeout(() => {
      this.scorecardRebuildScheduled = false;
      try {
        this.cachedScorecard = this.perf.getScorecard();
        this.lastScorecardMs = Date.now();
        this.scorecardDirty = true;
        // Push immediately so hard-reload / boot is not stuck waiting for the
        // next engine tick (book-light publishes used to drop the card).
        this.publishScorecardNow();
      } catch {
        /* keep prior cache */
      }
    }, force ? 50 : 0);
  }

  /** Attach cached scorecard onto the last payload and emit once. */
  private publishScorecardNow() {
    if (!this.cachedScorecard || !this.lastPayload) return;
    this.lastPayload = {
      ...this.lastPayload,
      tsMs: Date.now(),
      scorecard: this.cachedScorecard,
    };
    this.scorecardDirty = true;
    this.emitPayload(true);
  }

  private publish() {
    if (this.ws && this.kalshiWsStatus.connected) {
      const age = this.ws.lastBookAgeMs();
      const n = this.ws.bookUpdates();
      const base = this.kalshiWsStatus.detail.split(" · book ")[0] ?? this.kalshiWsStatus.detail;
      this.kalshiWsStatus = {
        connected: true,
        detail:
          age != null
            ? `${base} · book ${age}ms ago (${n} upd)`
            : `${base} · book waiting`,
      };
    }
    const built = this.buildPayload();
    // Retain cached card in memory even when this tick omits a wire push.
    this.lastPayload = {
      ...built,
      scorecard: built.scorecard ?? this.cachedScorecard ?? this.lastPayload?.scorecard,
    };
    this.emitPayload(Boolean(built.scorecard));
  }

  /**
   * Emit to listeners. Memory snapshot keeps the scorecard; the wire omits it
   * unless pushScorecard (dirty rebuild / subscribe already sends a full snap).
   */
  private emitPayload(pushScorecard: boolean) {
    const payload = this.lastPayload;
    if (!payload) return;
    const withCard = this.payloadWithCachedScorecard(payload);
    this.lastPayload = withCard;
    const wire = pushScorecard
      ? withCard
      : { ...withCard, scorecard: undefined };
    if (pushScorecard) this.scorecardDirty = false;
    this.lastPayloadJson = JSON.stringify(wire);
    this.emitToListeners(this.listeners);
    this.emitToListeners(this.persistentListeners);
  }

  private payloadWithCachedScorecard(payload: LiveFeedPayload): LiveFeedPayload {
    if (payload.scorecard || !this.cachedScorecard) return payload;
    return { ...payload, scorecard: this.cachedScorecard };
  }

  private emitToListeners(set: Set<SseSlot>) {
    const payload = this.lastPayload;
    const json = this.lastPayloadJson;
    if (!payload || !json) return;
    for (const slot of [...set]) {
      try {
        slot.send(payload, json);
      } catch {
        set.delete(slot);
        this.sseEvictions += 1;
        try {
          slot.evict?.();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

const globalForFeed = globalThis as unknown as {
  __bleepblorpFeed?: LiveFeedEngine;
  __bleepblorpFeedVersion?: number;
};

export function getLiveFeed(opts?: FeedEngineOptions): LiveFeedEngine {
  // Never replace a running engine. A version-mismatch recreate (tsx vs
  // compiled Next, or /api/status booting a second copy) leaves the trader
  // subscribed to a dead feed while the dashboard shows live Buy boxes.
  if (!globalForFeed.__bleepblorpFeed) {
    globalForFeed.__bleepblorpFeed = new LiveFeedEngine(opts);
    globalForFeed.__bleepblorpFeedVersion = FEED_ENGINE_VERSION;
  }
  globalForFeed.__bleepblorpFeed.wake();
  return globalForFeed.__bleepblorpFeed;
}
