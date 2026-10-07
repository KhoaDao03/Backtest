"use client";

import type { SessionOptSummary } from "@/lib/sessionOptTypes";

function fmtAgo(builtAtMs: number, now: number): string {
  const ms = Math.max(0, now - builtAtMs);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function fmtCloses(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function fmtLiftUsd(cents: number): string {
  const usd = cents / 100;
  const abs = Math.abs(usd).toFixed(2);
  if (usd > 0) return `+$${abs}`;
  if (usd < 0) return `-$${abs}`;
  return `$${abs}`;
}

function sitOutLine(sessionOpt?: SessionOptSummary | null): string {
  const fromRanges = (sessionOpt?.ranges ?? [])
    .map((r) => r.label.trim())
    .filter(Boolean);
  if (fromRanges.length > 0) return fromRanges.join(" · ");
  const summary = sessionOpt?.sitOutSummary?.trim();
  if (!summary) return "none yet — needs your paper history";
  return summary;
}

/** Compact sit-out readout under a Mid / End-of-Market scorecard table. */
export function SessionOptBox({
  sessionOpt,
  nowMs = Date.now(),
}: {
  sessionOpt?: SessionOptSummary | null;
  nowMs?: number;
}) {
  const windows = sitOutLine(sessionOpt);
  const lift =
    sessionOpt != null ? fmtLiftUsd(sessionOpt.liftCents) : null;
  const meta = sessionOpt
    ? `${fmtAgo(sessionOpt.builtAtMs, nowMs)} · ${fmtCloses(sessionOpt.closeCount)}`
    : "waiting…";
  const tip = sessionOpt
    ? `${windows}\nSun 6pm–Fri 5pm PT · lift ${lift ?? "—"} · ${meta}`
    : meta;

  return (
    <div className="session-opt-box" title={tip}>
      <div className="session-opt-head">
        <span className="session-opt-title">Sit-Out</span>
        {lift ? <span className="session-opt-lift">{lift}</span> : null}
        <span className="session-opt-meta">{meta}</span>
      </div>
      <div className="session-opt-windows">{windows}</div>
    </div>
  );
}
