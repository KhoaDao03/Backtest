import type { LiveFeedPayload } from "@/lib/liveTypes";
import { getLiveFeed } from "@/server/feed/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE for the dashboard. Must tear down on `request.signal` abort — Next does
 * not reliably call ReadableStream.cancel() when the tab reconnects, and each
 * leaked subscriber gets the full payload JSON on every tick. That wedges the
 * event loop, Kalshi's ping/pong is missed, and the UI reports a "Kalshi
 * disconnect" that was actually us drowning in dead sockets.
 */
export async function GET(request: Request) {
  if (process.env.BLEEPBLORP_PREVIEW === "1") {
    return new Response(null, { status: 204 });
  }
  const encoder = new TextEncoder();
  const feed = getLiveFeed();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        // desiredSize null/negative means the consumer is gone; enqueue would
        // only grow memory until the process misses Kalshi heartbeats.
        if (controller.desiredSize == null || controller.desiredSize < 0) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const send = (_payload: LiveFeedPayload, json: string) => {
        safeEnqueue(`data: ${json}\n\n`);
      };

      unsubscribe = feed.subscribe(send, { onEvict: cleanup });
      heartbeat = setInterval(() => {
        // Comments keep intermediaries from buffering; they do not reset the
        // browser stall watchdog (EventSource ignores comment frames).
        safeEnqueue(`: ping ${Date.now()}\n\n`);
      }, 5_000);

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
