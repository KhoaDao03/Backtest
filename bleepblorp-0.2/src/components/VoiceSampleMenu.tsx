"use client";

import {
  detectBrowserSpeech,
  listBrowserVoices,
  previewVoice,
  setPreferredVoiceName,
  unlockBuyAlerts,
  type VoiceOption,
} from "@/lib/buyAlerts";
import {
  useCallback,
  useEffect,
  useMemo,
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
  fontWeight: active ? 700 : 500,
  maxWidth: 72,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

function VoiceRows({
  voices,
  selected,
  onSample,
  onChoose,
}: {
  voices: VoiceOption[];
  selected: string | null;
  onSample: (v: VoiceOption) => void;
  onChoose: (v: VoiceOption) => void;
}) {
  if (!voices.length) return null;
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {voices.map((v) => {
        const active = selected === v.name;
        return (
          <li
            key={v.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              justifyContent: "space-between",
            }}
          >
            <button
              type="button"
              onClick={() => onSample(v)}
              title={`${v.name} (${v.lang}) — click to hear sample`}
              style={{
                ...btnStyle(active),
                flex: 1,
                maxWidth: "none",
                textAlign: "left",
              }}
            >
              {v.label}
              <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                {` · ${v.lang}`}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onChoose(v)}
              title="Apply this voice and close"
              style={{
                ...btnStyle(active),
                padding: "2px 6px",
                flexShrink: 0,
                maxWidth: "none",
              }}
            >
              {active ? "Selected" : "Select"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Alert-voice picker. Cold start shows "Select Voice" until the user picks one.
 */
export function VoiceSampleMenu({
  disabled = false,
}: {
  /** When true (Alerts/Voice off), picker stays visible but inactive. */
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const browser = useMemo(() => detectBrowserSpeech(), []);

  const refresh = useCallback(() => {
    setVoices(listBrowserVoices());
  }, []);

  const enMale = useMemo(
    () => voices.filter((v) => /^en/i.test(v.lang) && v.gender === "male"),
    [voices],
  );
  const enFemale = useMemo(
    () => voices.filter((v) => /^en/i.test(v.lang) && v.gender === "female"),
    [voices],
  );
  const enOther = useMemo(
    () => voices.filter((v) => /^en/i.test(v.lang) && v.gender === "unknown"),
    [voices],
  );
  const otherLang = useMemo(
    () => voices.filter((v) => !/^en/i.test(v.lang)),
    [voices],
  );

  useEffect(() => {
    refresh();
    const synth = window.speechSynthesis;
    if (!synth) return;
    const onVoices = () => refresh();
    synth.addEventListener("voiceschanged", onVoices);
    const t = window.setTimeout(refresh, 400);
    return () => {
      synth.removeEventListener("voiceschanged", onVoices);
      window.clearTimeout(t);
    };
  }, [refresh]);

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

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const toggleMenu = async () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      refresh();
      return;
    }
    setOpen(true);
    await unlockBuyAlerts();
    window.speechSynthesis?.getVoices();
    refresh();
    window.setTimeout(refresh, 100);
    window.setTimeout(refresh, 400);
  };

  const sample = async (v: VoiceOption) => {
    await unlockBuyAlerts();
    previewVoice(v.name);
  };

  const choose = async (v: VoiceOption) => {
    await unlockBuyAlerts();
    setPreferredVoiceName(v.name);
    setSelected(v.name);
    setSelectedLabel(v.label);
    previewVoice(v.name);
    setOpen(false);
  };

  const sectionTitle = (text: string) => (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--ui-xxs)",
        color: "var(--accent)",
        marginTop: 8,
        marginBottom: 4,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {text}
    </div>
  );

  const closedLabel = selectedLabel ?? "Voice…";
  const openLabel = selectedLabel ? `✓ ${selectedLabel}` : "Done";

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => void toggleMenu()}
        title={
          disabled
            ? "Turn Alerts on (and Voice on) to choose a spoken alert voice"
            : open
              ? "Close — your selected voice stays applied for alerts"
              : "Choose alert voice — Select required before spoken alerts"
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
          aria-label="Alert voice picker"
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
            }}
          >
            <strong style={{ color: "var(--ink-soft)" }}>{browser.name}</strong>
            {" — "}
            {voices.length} voice{voices.length === 1 ? "" : "s"} available.
            {" "}
            {browser.note}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--ui-xxs)",
              color: "var(--muted)",
              marginTop: 4,
              lineHeight: 1.35,
            }}
          >
            Hear a sample, then <strong style={{ color: "var(--ink-soft)" }}>Select</strong>
            {" "}(saves + closes). Or click{" "}
            <strong style={{ color: "var(--ink-soft)" }}>Done</strong> to close
            — the highlighted voice stays on.
          </div>
          {voices.length === 0 ? (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--ui-sm)",
                color: "var(--muted)",
                lineHeight: 1.35,
                marginTop: 8,
              }}
            >
              Voices still loading — leave this open a moment.
            </div>
          ) : (
            <>
              {enMale.length ? (
                <>
                  {sectionTitle("Male (English)")}
                  <VoiceRows
                    voices={enMale}
                    selected={selected}
                    onSample={(v) => void sample(v)}
                    onChoose={(v) => void choose(v)}
                  />
                </>
              ) : null}
              {enFemale.length ? (
                <>
                  {sectionTitle("Female (English)")}
                  <VoiceRows
                    voices={enFemale}
                    selected={selected}
                    onSample={(v) => void sample(v)}
                    onChoose={(v) => void choose(v)}
                  />
                </>
              ) : null}
              {enOther.length ? (
                <>
                  {sectionTitle("Other English")}
                  <VoiceRows
                    voices={enOther}
                    selected={selected}
                    onSample={(v) => void sample(v)}
                    onChoose={(v) => void choose(v)}
                  />
                </>
              ) : null}
              {otherLang.length ? (
                <>
                  {sectionTitle("Other languages")}
                  <VoiceRows
                    voices={otherLang}
                    selected={selected}
                    onSample={(v) => void sample(v)}
                    onChoose={(v) => void choose(v)}
                  />
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
