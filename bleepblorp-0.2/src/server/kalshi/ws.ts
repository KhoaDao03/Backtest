import WebSocket from "ws";
import type { AssetSymbol } from "@/lib/types";
import { snapKalshiBook } from "@/lib/math";
import { ASSETS, CFB_INDEX_BY_ASSET, KALSHI_WS_URL, SERIES_BY_ASSET } from "@/server/config";
import { hasKalshiCredentials, kalshiAuthHeaders } from "@/server/kalshi/auth";
import { WS_RECONNECT_BASE_MS } from "@/server/kalshi/pacing";

export type SpotSource = "cfbenchmarks" | "fallback";

export interface SpotTick {
  symbol: AssetSymbol;
  price: number;
  avg60s?: number;
  source: SpotSource;
  sources?: string[];
  tsMs: number;
}

export type BookTick = {
  marketTicker: string;
  askUp: number;
  bidUp: number;
  askDown: number;
  bidDown: number;
  tsMs: number;
  source: "orderbook" | "ticker" | "rest_ob" | "rest_mkt";
};

export interface MarketLifecycleEvent {
  eventType: string;
  marketTicker: string;
  tsMs: number;
}

type SpotHandler = (tick: SpotTick) => void;
type BookHandler = (tick: BookTick) => void;
type LifecycleHandler = (ev: MarketLifecycleEvent) => void;
type StatusHandler = (status: { connected: boolean; detail: string }) => void;

const INDEX_TO_ASSET = Object.fromEntries(
  ASSETS.map((a) => [CFB_INDEX_BY_ASSET[a], a]),
) as Record<string, AssetSymbol>;

const SERIES_PREFIXES = ASSETS.map((a) => SERIES_BY_ASSET[a]);

/** Price levels keyed by millicents (0.001) — avoids float Map-key ghosts on deci-cent books. */
type SideBook = Map<number, number>; // millicents → size

function parseFp(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? NaN);
  return Number.isFinite(n) ? n : NaN;
}

function priceKey(v: unknown): number | null {
  const n = parseFp(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

function keyToDollars(k: number): number {
  return k / 1000;
}

function bestBidDollars(book: SideBook): number | null {
  let best = -Infinity;
  for (const [k, sz] of book) {
    if (sz > 1e-8 && k > best) best = k;
  }
  return best === -Infinity ? null : keyToDollars(best);
}

function isOurSeries(marketTicker: string): boolean {
  return SERIES_PREFIXES.some((p) => marketTicker.startsWith(`${p}-`) || marketTicker === p);
}

/**
 * Authenticated Kalshi WS:
 * - cfbenchmarks_value → spot RTI
 * - ticker → yes/no BBO (matches Kalshi UI; lightweight)
 * - market_lifecycle_v2 → instant wake on new 15m markets
 *
 * We intentionally do NOT subscribe to orderbook_delta for BBO.
 * Four active 15m books can flood 10–200+ deltas/sec and starve the
 * Node event loop so ticker (and decisions) lag several seconds behind
 * Kalshi — the “stale until refresh” failure mode.
 */
export class KalshiWsClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private stopped = false;
  private reconnectAttempt = 0;
  private bookTickers: string[] = [];
  private bookSid: number | null = null;
  private tickerSid: number | null = null;
  private bookSubscribedKey = "";
  private books = new Map<string, { yes: SideBook; no: SideBook }>();
  /** Tickers that have received an orderbook_snapshot since last (re)subscribe. */
  private bookReady = new Set<string>();
  private lastBookEmitMs = 0;
  private bookMsgCount = 0;
  /** Per-market last ticker emit — Kalshi UI tracks this BBO, not reconstructed OB. */
  private lastTickerEmitByMarket = new Map<string, number>();
  /** Per-market last *orderbook* emit — used only when ticker is quiet. */
  private lastObEmitByMarket = new Map<string, number>();
  /** Channel seq for orderbook_delta snapshot/delta consistency. */
  private lastBookSeq: number | null = null;
  private snapshotResyncAtMs = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clientPingTimer: ReturnType<typeof setInterval> | null = null;
  private connecting = false;

  constructor(
    private onSpot: SpotHandler,
    private onBook: BookHandler,
    private onStatus: StatusHandler,
    private onLifecycle?: LifecycleHandler,
  ) {}

  start() {
    this.stopped = false;
    if (!hasKalshiCredentials()) {
      this.onStatus({
        connected: false,
        detail: "No Kalshi API key — using public REST + exchange RTI fallback",
      });
      return;
    }
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.clientPingTimer) {
      clearInterval(this.clientPingTimer);
      this.clientPingTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  lastBookAgeMs(): number | null {
    if (!this.lastBookEmitMs) return null;
    return Date.now() - this.lastBookEmitMs;
  }

  bookUpdates(): number {
    return this.bookMsgCount;
  }

  /** Subscribe (or resubscribe) to orderbook + ticker for these market tickers. */
  setBookMarkets(tickers: string[]) {
    const next = [...new Set(tickers.filter(Boolean))].sort();
    const changed = next.join(",") !== this.bookTickers.join(",");
    this.bookTickers = next;
    if (changed) {
      for (const t of [...this.books.keys()]) {
        if (!next.includes(t)) this.books.delete(t);
      }
    }
    this.syncBookSubscription(changed);
  }

  private connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    if (this.clientPingTimer) {
      clearInterval(this.clientPingTimer);
      this.clientPingTimer = null;
    }
    try {
      try {
        this.ws?.removeAllListeners();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
      } catch {
        /* ignore */
      }
      const headers = kalshiAuthHeaders("GET", "/trade-api/ws/v2");
      // autoPong: reply to Kalshi's 10s heartbeat pings (required keep-alive).
      this.ws = new WebSocket(KALSHI_WS_URL, {
        headers,
        autoPong: true,
      });
    } catch (err) {
      this.connecting = false;
      this.onStatus({
        connected: false,
        detail: `WS auth failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.bookSid = null;
      this.tickerSid = null;
      this.bookSubscribedKey = "";
      this.books.clear();
      this.bookReady.clear();
      this.lastObEmitByMarket.clear();
      this.lastTickerEmitByMarket.clear();
      this.lastBookSeq = null;
      this.onStatus({
        connected: true,
        detail: "Kalshi WS connected (RTI + ticker BBO)",
      });
      this.send({
        id: this.msgId++,
        cmd: "subscribe",
        params: {
          channels: ["cfbenchmarks_value"],
          index_ids: ASSETS.map((a) => CFB_INDEX_BY_ASSET[a]),
        },
      });
      this.send({
        id: this.msgId++,
        cmd: "subscribe",
        params: { channels: ["market_lifecycle_v2"] },
      });
      this.syncBookSubscription(true);
      // Client→server ping as well — helps when the process was briefly busy.
      this.clientPingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }, 20_000);
    });

    this.ws.on("message", (buf) => {
      try {
        const data = JSON.parse(buf.toString()) as {
          type?: string;
          sid?: number;
          seq?: number;
          msg?: Record<string, unknown>;
        };

        if (data.type === "subscribed") {
          const channel = String(data.msg?.channel ?? "");
          const sid =
            typeof data.sid === "number"
              ? data.sid
              : typeof data.msg?.sid === "number"
                ? (data.msg.sid as number)
                : null;
          if (sid != null && channel === "orderbook_delta") this.bookSid = sid;
          if (sid != null && channel === "ticker") this.tickerSid = sid;
          return;
        }

        if (data.type === "market_lifecycle_v2" && data.msg) {
          this.handleLifecycle(data.msg);
          return;
        }
        if (data.type === "orderbook_snapshot" && data.msg) {
          this.noteBookSeq(data.seq, /*isSnapshot*/ true);
          this.handleObSnapshot(data.msg);
          return;
        }
        if (data.type === "orderbook_delta" && data.msg) {
          if (!this.noteBookSeq(data.seq, /*isSnapshot*/ false)) return;
          this.handleObDelta(data.msg);
          return;
        }
        if (data.type === "ticker" && data.msg) {
          this.handleTickerMsg(data.msg);
          return;
        }
        if (data.type === "cfbenchmarks_value" && data.msg) {
          this.handleSpotMsg(data.msg);
          return;
        }
        if (data.type === "error") {
          const code = data.msg?.code;
          const msg = data.msg?.msg;
          this.onStatus({
            connected: this.ws?.readyState === WebSocket.OPEN,
            detail: `Kalshi WS error ${code ?? "?"}: ${String(msg ?? "unknown")}`,
          });
          if (code === 6 || code === 8 || code === 14 || code === 16) {
            this.bookSubscribedKey = "";
          }
        }
      } catch {
        /* ignore malformed */
      }
    });

    this.ws.on("close", (code, reasonBuf) => {
      this.connecting = false;
      if (this.clientPingTimer) {
        clearInterval(this.clientPingTimer);
        this.clientPingTimer = null;
      }
      this.bookSid = null;
      this.tickerSid = null;
      this.bookSubscribedKey = "";
      this.books.clear();
      this.bookReady.clear();
      this.lastObEmitByMarket.clear();
      this.lastTickerEmitByMarket.clear();
      this.lastBookSeq = null;
      const reason = reasonBuf?.toString?.() || "";
      this.onStatus({
        connected: false,
        detail: `Kalshi WS disconnected (${code}${reason ? `: ${reason}` : ""})`,
      });
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.onStatus({
        connected: false,
        detail: `Kalshi WS error: ${err.message}`,
      });
    });
  }

  private handleLifecycle(msg: Record<string, unknown>) {
    const marketTicker = msg.market_ticker;
    const eventType = msg.event_type;
    if (typeof marketTicker !== "string" || typeof eventType !== "string") return;
    if (!isOurSeries(marketTicker)) return;
    if (
      eventType !== "created" &&
      eventType !== "activated" &&
      eventType !== "close_date_updated" &&
      eventType !== "deactivated" &&
      eventType !== "determined" &&
      eventType !== "settled"
    ) {
      return;
    }
    this.onLifecycle?.({
      eventType,
      marketTicker,
      tsMs: Date.now(),
    });
  }

  private syncBookSubscription(force = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const key = this.bookTickers.join(",");
    if (!force && key === this.bookSubscribedKey) return;

    for (const sid of [this.bookSid, this.tickerSid]) {
      if (sid != null) {
        this.send({
          id: this.msgId++,
          cmd: "unsubscribe",
          params: { sids: [sid] },
        });
      }
    }
    this.bookSid = null;
    this.tickerSid = null;
    this.bookSubscribedKey = key;
    this.lastBookSeq = null;
    this.lastObEmitByMarket.clear();
    this.lastTickerEmitByMarket.clear();
    // No local orderbook to rebuild — ticker snapshots carry BBO.
    this.books.clear();
    this.bookReady.clear();
    if (!this.bookTickers.length) return;

    // Ticker only — BBO that matches Kalshi UI without orderbook flood.
    this.send({
      id: this.msgId++,
      cmd: "subscribe",
      params: {
        channels: ["ticker"],
        market_tickers: this.bookTickers,
        send_initial_snapshot: true,
      },
    });
  }

  private ensureBook(ticker: string): { yes: SideBook; no: SideBook } {
    let b = this.books.get(ticker);
    if (!b) {
      b = { yes: new Map(), no: new Map() };
      this.books.set(ticker, b);
    }
    return b;
  }

  private handleObSnapshot(msg: Record<string, unknown>) {
    const marketTicker = msg.market_ticker;
    if (typeof marketTicker !== "string") return;
    const yes: SideBook = new Map();
    const no: SideBook = new Map();
    const yesLevels = msg.yes_dollars_fp ?? msg.yes_dollars;
    const noLevels = msg.no_dollars_fp ?? msg.no_dollars;
    if (Array.isArray(yesLevels)) {
      for (const row of yesLevels) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const k = priceKey(row[0]);
        const sz = parseFp(row[1]);
        if (k != null && Number.isFinite(sz) && sz > 0) yes.set(k, sz);
      }
    }
    if (Array.isArray(noLevels)) {
      for (const row of noLevels) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const k = priceKey(row[0]);
        const sz = parseFp(row[1]);
        if (k != null && Number.isFinite(sz) && sz > 0) no.set(k, sz);
      }
    }
    this.books.set(marketTicker, { yes, no });
    this.bookReady.add(marketTicker);
    this.emitTopOfBook(marketTicker, "orderbook");
  }

  private handleObDelta(msg: Record<string, unknown>) {
    const marketTicker = msg.market_ticker;
    if (typeof marketTicker !== "string") return;
    if (!this.bookReady.has(marketTicker)) {
      this.requestBookSnapshot();
      return;
    }
    const side = msg.side === "no" ? "no" : msg.side === "yes" ? "yes" : null;
    const k = priceKey(msg.price_dollars ?? msg.price);
    const delta = parseFp(msg.delta_fp ?? msg.delta);
    if (!side || k == null || !Number.isFinite(delta)) return;

    const book = this.ensureBook(marketTicker);
    const levels = side === "yes" ? book.yes : book.no;
    const next = (levels.get(k) ?? 0) + delta;
    if (next <= 1e-8) levels.delete(k);
    else levels.set(k, next);
    this.emitTopOfBook(marketTicker, "orderbook");
  }

  private emitTopOfBook(marketTicker: string, source: "orderbook" | "ticker") {
    const book = this.books.get(marketTicker);
    if (!book) return;
    const bidUp = bestBidDollars(book.yes);
    const bidDown = bestBidDollars(book.no);
    // Kalshi: YES ask = 1 − best NO bid; NO ask = 1 − best YES bid
    const askUp = bidDown != null ? 1 - bidDown : null;
    const askDown = bidUp != null ? 1 - bidUp : null;
    if (bidUp == null || askUp == null || bidDown == null || askDown == null) return;

    // Prefer ticker BBO when it's fresh — that matches what Kalshi's UI shows.
    // Reconstructed orderbooks can disagree with market yes_bid/ask by several ¢.
    if (source === "orderbook") {
      const tickerAge =
        Date.now() - (this.lastTickerEmitByMarket.get(marketTicker) ?? 0);
      if (tickerAge < 2_000) return;
    }

    this.bookMsgCount += 1;
    this.lastBookEmitMs = Date.now();
    if (source === "orderbook") {
      this.lastObEmitByMarket.set(marketTicker, this.lastBookEmitMs);
    }
    this.onBook(
      snapKalshiBook({
        marketTicker,
        bidUp,
        askUp,
        bidDown,
        askDown,
        tsMs: this.lastBookEmitMs,
        source,
      }),
    );
  }

  /**
   * Track orderbook channel seq. On a gap, request a fresh snapshot and
   * ignore the orphan delta so we don't drift behind Kalshi.
   */
  private noteBookSeq(seq: number | undefined, isSnapshot: boolean): boolean {
    if (typeof seq !== "number" || !Number.isFinite(seq)) return true;
    if (isSnapshot) {
      this.lastBookSeq = seq;
      return true;
    }
    if (this.lastBookSeq != null && seq > this.lastBookSeq + 1) {
      this.requestBookSnapshot();
      return false;
    }
    this.lastBookSeq = seq;
    return true;
  }

  private requestBookSnapshot() {
    if (this.bookSid == null || !this.bookTickers.length) return;
    const now = Date.now();
    if (now - this.snapshotResyncAtMs < 1_500) return;
    this.snapshotResyncAtMs = now;
    this.send({
      id: this.msgId++,
      cmd: "update_subscription",
      params: {
        sids: [this.bookSid],
        action: "get_snapshot",
        market_tickers: this.bookTickers,
      },
    });
  }

  private handleSpotMsg(msg: Record<string, unknown>) {
    const indexId = msg.index_id;
    if (typeof indexId !== "string") return;
    const symbol = INDEX_TO_ASSET[indexId];
    if (!symbol) return;

    let instant = NaN;
    try {
      const frame = JSON.parse(String(msg.data ?? "{}")) as { value?: string };
      instant = Number(frame.value);
    } catch {
      /* ignore */
    }
    const avgRaw = (msg.avg_60s_data as { value?: string } | undefined)?.value;
    const avg60s = avgRaw != null && avgRaw !== "" ? Number(avgRaw) : NaN;

    // Prefer the rolling 60s RTI average when Kalshi provides it:
    // - strike / settlement are 60s averages (often 4+ dp on SOL)
    // - raw CFB tick for SOL often arrives at only 2 dp over this channel
    const price = Number.isFinite(avg60s)
      ? avg60s
      : Number.isFinite(instant)
        ? instant
        : NaN;
    if (!Number.isFinite(price)) return;

    this.onSpot({
      symbol,
      price,
      avg60s: Number.isFinite(avg60s) ? avg60s : undefined,
      source: "cfbenchmarks",
      tsMs: Date.now(),
    });
  }

  private handleTickerMsg(msg: Record<string, unknown>) {
    const marketTicker = msg.market_ticker;
    if (typeof marketTicker !== "string") return;

    const bidUp = parseFp(msg.yes_bid_dollars ?? msg.yes_bid);
    const askUp = parseFp(msg.yes_ask_dollars ?? msg.yes_ask);
    // cents fallback
    const bidUpC =
      Number.isFinite(bidUp) && bidUp > 1 ? bidUp / 100 : bidUp;
    const askUpC =
      Number.isFinite(askUp) && askUp > 1 ? askUp / 100 : askUp;

    if (!Number.isFinite(bidUpC) || !Number.isFinite(askUpC)) return;

    const bidDown = 1 - askUpC;
    const askDown = 1 - bidUpC;
    this.bookMsgCount += 1;
    this.lastBookEmitMs = Date.now();
    this.lastTickerEmitByMarket.set(marketTicker, this.lastBookEmitMs);
    this.onBook(
      snapKalshiBook({
        marketTicker,
        bidUp: bidUpC,
        askUp: askUpC,
        bidDown,
        askDown,
        tsMs: this.lastBookEmitMs,
        source: "ticker",
      }),
    );
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private scheduleReconnect() {
    if (this.stopped || !hasKalshiCredentials()) return;
    if (this.reconnectTimer) return; // single-flight — avoid reconnect storms
    this.reconnectAttempt += 1;
    const delay = Math.min(
      30_000,
      WS_RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 4),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}
