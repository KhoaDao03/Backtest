"use client";

import {
  CHIME_SOUNDS,
  getPreferredChimeId,
  getPreferredChimeLabel,
  previewChime,
  setPreferredChimeId,
  unlockBuyAlerts,
  type ChimeSoundId,
  type ChimeSoundOption,
} from "@/lib/buyAlerts";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const btnStyle = (active: boolean): CSSProperties => ({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--ui-sm)",
  lineHeight: 1.2,
  padding: "1px 5px",
  borderRadius: 4,
  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
  background: active ? "var(--a-bg)" : "transparent",
  color: active ? "var(--accent)" : "var(--muted)",
  cursor: "pointer",
  fontWeight: 700,
  maxWidth: 64,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

/** First word of the chime label for the compact header chip. */
function shortChimeLabel(label: string): string {
  const word = label.trim().split(/\s+/)[0] ?? label;
  return word.length > 8 ? `${word.slice(0, 7)}…` : word;
}

/**
 * Alert-chime picker. Enabled when Alerts + Chime are on.
 */
export function ChimeSampleMenu({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ChimeSoundId>("soft");
  const [selectedLabel, setSelectedLabel] = useState("Soft ping");

  useEffect(() => {
    const id = getPreferredChimeId();
    setSelected(id);
    setSelectedLabel(getPreferredChimeLabel());
  }, []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleMenu = async () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    await unlockBuyAlerts();
  };

  const sample = async (s: ChimeSoundOption) => {
    await previewChime(s.id);
  };

  const choose = async (s: ChimeSoundOption) => {
    setPreferredChimeId(s.id);
    setSelected(s.id);
    setSelectedLabel(s.label);
    await previewChime(s.id);
    setOpen(false);
  };

  const closedLabel = shortChimeLabel(selectedLabel);
  const openLabel = `✓ ${shortChimeLabel(selectedLabel)}`;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => void toggleMenu()}
        title={
          disabled
            ? "Turn Alerts on and Chime on to choose an alert sound"
            : open
              ? `Close — ${selectedLabel} stays applied`
              : `Chime · ${selectedLabel} — choose Buy alert sound`
        }
        aria-expanded={open}
        disabled={disabled}
        style={{
          ...btnStyle(open || Boolean(selected)),
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {open ? openLabel : closedLabel}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Alert chime picker"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            zIndex: 40,
            minWidth: 260,
            maxWidth: 320,
            maxHeight: 380,
            overflowY: "auto",
            padding: 8,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--card)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            textAlign: "left",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--ui-xxs)",
              color: "var(--muted)",
              lineHeight: 1.35,
              marginBottom: 6,
            }}
          >
            Hear a sample, then{" "}
            <strong style={{ color: "var(--ink-soft)" }}>Select</strong>
            {" "}(saves + closes).
          </div>
          {CHIME_SOUNDS.map((s) => {
            const active = s.id === selected;
            return (
              <div
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 4px",
                  borderRadius: 4,
                  background: active ? "var(--a-bg)" : "transparent",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--ui-sm)",
                      fontWeight: 700,
                      color: active ? "var(--accent)" : "var(--ink-soft)",
                    }}
                  >
                    {s.label}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--ui-xxs)",
                      color: "var(--muted)",
                    }}
                  >
                    {s.blurb}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void sample(s)}
                  style={{
                    ...btnStyle(false),
                    fontSize: "var(--ui-xxs)",
                    padding: "2px 6px",
                    fontWeight: 600,
                  }}
                >
                  Hear
                </button>
                <button
                  type="button"
                  onClick={() => void choose(s)}
                  style={{
                    ...btnStyle(active),
                    fontSize: "var(--ui-xxs)",
                    padding: "2px 6px",
                  }}
                >
                  {active ? "On" : "Select"}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
