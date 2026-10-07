import type { AssetSymbol, Side } from "@/lib/types";

export type BuyAlertLane = "mid" | "eom";

export type BuyAlertItem = {
  symbol: AssetSymbol;
  side?: Side;
  lane: BuyAlertLane;
};

const COIN_NAME: Record<AssetSymbol, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  XRP: "XRP",
};

let sharedCtx: AudioContext | null = null;
/** True after a user gesture unlocked AudioContext / speech (required by Chrome). */
let audioUnlocked = false;
let speechKeepalive: number | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    if (!sharedCtx || sharedCtx.state === "closed") {
      sharedCtx = new AC();
    }
    return sharedCtx;
  } catch {
    return null;
  }
}

export function isBuyAlertAudioUnlocked(): boolean {
  return audioUnlocked;
}

/** Chromium often parks speechSynthesis in paused=true until resume(). */
function kickSpeechSynth(synth: SpeechSynthesis): void {
  try {
    if (synth.paused) synth.resume();
  } catch {
    /* ignore */
  }
}

function startSpeechKeepalive(): void {
  if (typeof window === "undefined" || speechKeepalive) return;
  speechKeepalive = window.setInterval(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    kickSpeechSynth(synth);
  }, 8_000);
}

/** Call from a click handler so Chrome allows later chimes / speech. */
export async function unlockBuyAlerts(): Promise<void> {
  if (typeof window === "undefined") return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
  try {
    const synth = window.speechSynthesis;
    if (synth) {
      synth.getVoices();
      kickSpeechSynth(synth);
    }
  } catch {
    /* ignore */
  }
  audioUnlocked = true;
  startSpeechKeepalive();
}

export type ChimeSoundId =
  | "soft"
  | "bright"
  | "double"
  | "coin"
  | "marimba"
  | "glass"
  | "blip"
  | "chord"
  | "bell"
  | "rise";

export type ChimeSoundOption = {
  id: ChimeSoundId;
  label: string;
  blurb: string;
};

/** Built-in WebAudio alert sounds — no asset files required. */
export const CHIME_SOUNDS: ChimeSoundOption[] = [
  { id: "soft", label: "Soft ping", blurb: "Quiet sine tap (default)" },
  { id: "bright", label: "Bright ping", blurb: "Higher, snappier ping" },
  { id: "double", label: "Double tap", blurb: "Two quick notes" },
  { id: "coin", label: "Coin", blurb: "Short metallic clink" },
  { id: "marimba", label: "Marimba", blurb: "Warm two-tone pluck" },
  { id: "glass", label: "Glass", blurb: "Thin high chime" },
  { id: "blip", label: "Blip", blurb: "Retro square beep" },
  { id: "chord", label: "Chord", blurb: "Soft major third" },
  { id: "bell", label: "Bell", blurb: "Longer ring decay" },
  { id: "rise", label: "Rise", blurb: "Three-note lift" },
];

export const CHIME_SOUND_KEY = "bleepblorp.alertChimeSound";

function isChimeSoundId(v: string | null): v is ChimeSoundId {
  return CHIME_SOUNDS.some((s) => s.id === v);
}

export function getPreferredChimeId(): ChimeSoundId {
  if (typeof window === "undefined") return "soft";
  try {
    const raw = localStorage.getItem(CHIME_SOUND_KEY);
    return isChimeSoundId(raw) ? raw : "soft";
  } catch {
    return "soft";
  }
}

export function getPreferredChimeLabel(): string {
  const id = getPreferredChimeId();
  return CHIME_SOUNDS.find((s) => s.id === id)?.label ?? "Soft ping";
}

export function setPreferredChimeId(id: ChimeSoundId): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHIME_SOUND_KEY, id);
  } catch {
    /* ignore */
  }
}

async function ensureAudioRunning(): Promise<AudioContext | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
  return ctx.state === "running" ? ctx : null;
}

function playTone(
  ctx: AudioContext,
  opts: {
    type?: OscillatorType;
    freq: number;
    start: number;
    dur: number;
    peak?: number;
    attack?: number;
  },
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.value = opts.freq;
  const peak = opts.peak ?? 0.12;
  const attack = opts.attack ?? 0.015;
  const t0 = opts.start;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0008, t0 + opts.dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.02);
}

function playNoiseBurst(
  ctx: AudioContext,
  start: number,
  dur: number,
  peak = 0.08,
) {
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = "highpass";
  filt.frequency.value = 1800;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0008, start + dur);
  src.connect(filt);
  filt.connect(gain);
  gain.connect(ctx.destination);
  src.start(start);
  src.stop(start + dur + 0.02);
}

function playChimeSound(ctx: AudioContext, id: ChimeSoundId): void {
  const t = ctx.currentTime;
  switch (id) {
    case "soft":
      playTone(ctx, { freq: 660, start: t, dur: 0.32, peak: 0.12 });
      break;
    case "bright":
      playTone(ctx, { freq: 990, start: t, dur: 0.22, peak: 0.11 });
      playTone(ctx, { freq: 1480, start: t, dur: 0.14, peak: 0.05 });
      break;
    case "double":
      playTone(ctx, { freq: 740, start: t, dur: 0.12, peak: 0.11 });
      playTone(ctx, { freq: 880, start: t + 0.11, dur: 0.14, peak: 0.1 });
      break;
    case "coin":
      playTone(ctx, { type: "triangle", freq: 1240, start: t, dur: 0.08, peak: 0.1 });
      playTone(ctx, { type: "triangle", freq: 1860, start: t + 0.04, dur: 0.16, peak: 0.07 });
      playNoiseBurst(ctx, t, 0.04, 0.035);
      break;
    case "marimba":
      playTone(ctx, { type: "triangle", freq: 523.25, start: t, dur: 0.28, peak: 0.11 });
      playTone(ctx, { type: "triangle", freq: 659.25, start: t + 0.09, dur: 0.3, peak: 0.09 });
      break;
    case "glass":
      playTone(ctx, { freq: 1760, start: t, dur: 0.45, peak: 0.07, attack: 0.004 });
      playTone(ctx, { freq: 2637, start: t, dur: 0.28, peak: 0.035, attack: 0.004 });
      break;
    case "blip":
      playTone(ctx, { type: "square", freq: 520, start: t, dur: 0.09, peak: 0.05 });
      break;
    case "chord":
      playTone(ctx, { freq: 523.25, start: t, dur: 0.4, peak: 0.07 });
      playTone(ctx, { freq: 659.25, start: t, dur: 0.4, peak: 0.055 });
      playTone(ctx, { freq: 783.99, start: t, dur: 0.4, peak: 0.045 });
      break;
    case "bell":
      playTone(ctx, { freq: 880, start: t, dur: 0.7, peak: 0.1, attack: 0.008 });
      playTone(ctx, { freq: 1760, start: t, dur: 0.45, peak: 0.04, attack: 0.008 });
      break;
    case "rise":
      playTone(ctx, { freq: 523.25, start: t, dur: 0.12, peak: 0.09 });
      playTone(ctx, { freq: 659.25, start: t + 0.1, dur: 0.12, peak: 0.09 });
      playTone(ctx, { freq: 783.99, start: t + 0.2, dur: 0.18, peak: 0.1 });
      break;
    default:
      playTone(ctx, { freq: 660, start: t, dur: 0.32, peak: 0.12 });
  }
}

/** Alert chime using the selected (or given) sound. */
export async function playBuyChime(soundId?: ChimeSoundId): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const ctx = await ensureAudioRunning();
    if (!ctx) return;
    playChimeSound(ctx, soundId ?? getPreferredChimeId());
  } catch {
    /* ignore */
  }
}

/** Preview a chime from the picker (always plays, even if Chime is off). */
export async function previewChime(soundId: ChimeSoundId): Promise<void> {
  await unlockBuyAlerts();
  await playBuyChime(soundId);
}

/**
 * Voice tone for bleepblorp 0.2 — calm neon-desk, as natural as browser TTS allows.
 * Prefer neural “Online (Natural)” male voices (Guy first, or user pick); slight
 * ease on rate so alerts sound spoken, not barked.
 */
const SPEECH_RATE = 0.96;
const SPEECH_PITCH = 0.98;
const SPEECH_VOLUME = 1;

export const VOICE_PREF_KEY = "bleepblorp.alertVoice";
/** When "0", buy alerts do not speak. Default off until user enables Voice. */
export const VOICE_SPEAK_KEY = "bleepblorp.alertSpeak";
/** When "0", buy alerts skip the chime (voice-only if Voice is on). Default on. */
export const CHIME_ALERTS_KEY = "bleepblorp.alertChime";

const MALE_NAME_RE =
  /\b(guy|andrew|christopher|ryan|davis|james|eric|tony|steffan|roger|george|thomas|brian|arthur|wayne|mark|david|daniel)\b/i;

const FEMALE_NAME_RE =
  /\b(zira|aria|jenny|sara|michelle|emma|sonia|natasha|hazel|susan|samantha|karen|moira|heather|linda|catherine|raveena|tessa|fiona|veena)\b/i;

export type VoiceGender = "male" | "female" | "unknown";

export type VoiceOption = {
  name: string;
  lang: string;
  /** Short button label, e.g. "Guy Desktop". */
  label: string;
  gender: VoiceGender;
};

export type BrowserSpeechInfo = {
  /** Chrome | Edge | Firefox | Safari | Other */
  name: string;
  /** Short note about typical voice availability. */
  note: string;
};

/** Which browser engine is serving this page (drives which TTS voices exist). */
export function detectBrowserSpeech(): BrowserSpeechInfo {
  if (typeof navigator === "undefined") {
    return { name: "Browser", note: "Voice list loads in the page." };
  }
  const ua = navigator.userAgent;
  // Edge before Chrome — Edg/ also contains Chrome/
  if (/Edg\//i.test(ua)) {
    return {
      name: "Edge",
      note: "Edge usually includes Windows Online (Natural) voices when installed.",
    };
  }
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) {
    return {
      name: "Chrome",
      note: "Chrome typically lists Desktop + Google voices; Naturals often need Edge.",
    };
  }
  if (/Firefox\//i.test(ua)) {
    return {
      name: "Firefox",
      note: "Firefox uses the OS speech voices available on this machine.",
    };
  }
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
    return {
      name: "Safari",
      note: "Safari uses macOS / iOS system voices.",
    };
  }
  return {
    name: "Browser",
    note: "Showing every voice this browser reports.",
  };
}

function detectGender(name: string): VoiceGender {
  if (MALE_NAME_RE.test(name)) return "male";
  if (FEMALE_NAME_RE.test(name)) return "female";
  if (/google us english/i.test(name)) return "female";
  if (/google uk english male/i.test(name)) return "male";
  if (/google uk english female/i.test(name)) return "female";
  return "unknown";
}

function shortVoiceLabel(name: string): string {
  const male = name.match(MALE_NAME_RE);
  const female = name.match(FEMALE_NAME_RE);
  const hit = male?.[1] ?? female?.[1];
  if (hit) {
    const base = hit[0]!.toUpperCase() + hit.slice(1).toLowerCase();
    if (/natural|neural|online/i.test(name)) return `${base} Natural`;
    if (/desktop/i.test(name)) return `${base} Desktop`;
    return base;
  }
  if (/google uk english male/i.test(name)) return "Google UK Male";
  if (/google uk english female/i.test(name)) return "Google UK Female";
  if (/google/i.test(name)) return "Google US";
  // Strip common vendor prefixes for a shorter chip.
  const cleaned = name
    .replace(/^Microsoft\s+/i, "")
    .replace(/\s+-\s+English.*$/i, "")
    .replace(/\s+\(.*\)$/i, "")
    .trim();
  return cleaned.length > 22 ? `${cleaned.slice(0, 20)}…` : cleaned || name.slice(0, 22);
}

export function voiceOptionFromName(name: string): VoiceOption | null {
  const v = findVoiceByName(name);
  if (!v) return null;
  return {
    name: v.name,
    lang: v.lang,
    label: shortVoiceLabel(v.name),
    gender: detectGender(v.name),
  };
}

export function getPreferredVoiceLabel(): string | null {
  const name = readPreferredVoiceName();
  if (!name) return null;
  const opt = voiceOptionFromName(name);
  return opt?.label ?? shortVoiceLabel(name);
}

/** Rank voices — English neural first; still ranks every lang this browser has. */
function scoreVoice(v: SpeechSynthesisVoice): number {
  let score = 0;
  if (/en(-|_)US/i.test(v.lang)) score += 40;
  else if (/en(-|_)GB/i.test(v.lang)) score += 15;
  else if (/^en/i.test(v.lang)) score += 5;
  else score -= 20;

  const name = v.name;
  if (/natural|neural/i.test(name)) score += 80;
  if (/online/i.test(name)) score += 25;
  if (/\bguy\b/i.test(name)) score += 40;
  else if (/\b(andrew|christopher|ryan|davis|james)\b/i.test(name)) score += 28;
  else if (/\b(eric|tony|steffan|roger|george|thomas|brian|arthur)\b/i.test(name))
    score += 22;
  else if (/\b(aria|jenny|sara|michelle|emma|sonia|natasha)\b/i.test(name))
    score += 18;
  else if (/google/i.test(name)) score += 22;
  else if (/samantha|karen|moira|daniel/i.test(name)) score += 12;

  if (
    /\b(zira|david|mark|hazel|susan|desktop|microsoft david|microsoft zira)\b/i.test(
      name,
    ) &&
    !/natural|neural|online/i.test(name)
  ) {
    score -= 60;
  }
  return score;
}

function readPreferredVoiceName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(VOICE_PREF_KEY);
  } catch {
    return null;
  }
}

export function getPreferredVoiceName(): string | null {
  return readPreferredVoiceName();
}

export function setPreferredVoiceName(name: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!name) localStorage.removeItem(VOICE_PREF_KEY);
    else localStorage.setItem(VOICE_PREF_KEY, name);
  } catch {
    /* ignore */
  }
}

export function getSpeakAlertsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(VOICE_SPEAK_KEY) === "1";
  } catch {
    return false;
  }
}

/** Chime defaults on; only "0" turns it off. */
export function getChimeAlertsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(CHIME_ALERTS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setChimeAlertsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHIME_ALERTS_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function findVoiceByName(name: string): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  return window.speechSynthesis.getVoices().find((v) => v.name === name) ?? null;
}

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  // Only the user's Select choice — no auto-pick (David/etc. aren't on every browser).
  const preferred = readPreferredVoiceName();
  if (!preferred) return null;
  return voices.find((v) => v.name === preferred) ?? null;
}

/**
 * Every voice this browser’s speechSynthesis reports (full range for Chrome/Edge/etc.).
 * English male/female first, then other English, then other languages.
 */
export function listBrowserVoices(): VoiceOption[] {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  const voices = window.speechSynthesis.getVoices();
  const ranked = [...voices].sort((a, b) => {
    const bucket = (v: SpeechSynthesisVoice) => {
      const en = /^en/i.test(v.lang);
      const gender = detectGender(v.name);
      if (en && gender === "male") return 0;
      if (en && gender === "female") return 1;
      if (en) return 2;
      return 3;
    };
    const db = bucket(a) - bucket(b);
    if (db !== 0) return db;
    return scoreVoice(b) - scoreVoice(a) || a.name.localeCompare(b.name);
  });
  const seen = new Set<string>();
  const out: VoiceOption[] = [];
  for (const v of ranked) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    out.push({
      name: v.name,
      lang: v.lang,
      label: shortVoiceLabel(v.name),
      gender: detectGender(v.name),
    });
  }
  return out;
}

/** @deprecated use listBrowserVoices */
export function listEnglishVoices(): VoiceOption[] {
  return listBrowserVoices().filter((v) => /^en/i.test(v.lang));
}

/** @deprecated use listBrowserVoices */
export function listMaleNaturalVoices(): VoiceOption[] {
  return listBrowserVoices().filter(
    (v) => v.gender === "male" && /^en/i.test(v.lang),
  );
}

/** Preview a specific installed voice with a sample buy line. */
export function previewVoice(voiceName: string): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const voice = findVoiceByName(voiceName);
  if (!voice) return;
  const synth = window.speechSynthesis;
  try {
    kickSpeechSynth(synth);
    synth.cancel();
    window.setTimeout(() => {
      try {
        kickSpeechSynth(synth);
        const utter = new SpeechSynthesisUtterance(
          "This is a sample voice for Buy alerts.",
        );
        utter.rate = SPEECH_RATE;
        utter.pitch = SPEECH_PITCH;
        utter.volume = SPEECH_VOLUME;
        utter.voice = voice;
        utter.lang = voice.lang;
        synth.speak(utter);
      } catch {
        /* ignore */
      }
    }, 40);
  } catch {
    /* ignore */
  }
}

function sideWord(side: Side | undefined): string {
  if (side === "down") return "Down";
  if (side === "up") return "Up";
  return "";
}

function coinName(symbol: AssetSymbol): string {
  return COIN_NAME[symbol] ?? symbol;
}

function laneLabel(lane: BuyAlertLane): string {
  return lane === "eom" ? "End-of-Market" : "Mid-Market";
}

/**
 * One alert clause with slight TTS pauses between parts, e.g.
 * “Bitcoin, Up, Mid-Market”
 */
export function buyClause(
  symbol: AssetSymbol,
  side?: Side,
  lane: BuyAlertLane = "mid",
): string {
  const coin = coinName(symbol);
  const sw = sideWord(side);
  const market = laneLabel(lane);
  return sw ? `${coin}, ${sw}, ${market}` : `${coin}, ${market}`;
}

/**
 * One lane’s line(s). Multiple coins in the same lane are spoken as separate
 * paused clauses joined by a period.
 * “Bitcoin, Up, End-of-Market”
 * “Bitcoin, Up, Mid-Market. Solana, Down, Mid-Market”
 */
export function buildBuyAlertPhrase(items: BuyAlertItem[]): string {
  if (!items.length) return "";
  const lane = items[0]!.lane;
  const seen = new Set<string>();
  const clauses: string[] = [];
  for (const it of items) {
    if (it.lane !== lane) continue;
    const key = `${it.symbol}:${it.side ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clauses.push(buyClause(it.symbol, it.side, lane));
  }
  if (!clauses.length) return "";
  return clauses.join(". ");
}

function applySpeechTone(utter: SpeechSynthesisUtterance): void {
  utter.rate = SPEECH_RATE;
  utter.pitch = SPEECH_PITCH;
  utter.volume = SPEECH_VOLUME;
  const voice = pickVoice();
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  }
}

/** Pending alert batches — each is chime + phrases, played in order. */
type AlertBatch = { phrases: string[]; chime: boolean };
let alertQueue: AlertBatch[] = [];
let alertPumpRunning = false;
let speakDelayTimer: number | null = null;
let coalesceTimer: number | null = null;
let coalesceItems: BuyAlertItem[] = [];

const COALESCE_MS = 280;

function clearSpeakTimers(): void {
  if (speakDelayTimer != null) {
    window.clearTimeout(speakDelayTimer);
    speakDelayTimer = null;
  }
}

/** Drop queued alerts and stop current speech (voice off / Alerts-on reset). */
function resetSpeechPipeline(): void {
  alertQueue = [];
  clearSpeakTimers();
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

/**
 * Speak one batch and resolve when the last utterance ends (or speech is off).
 * Does not cancel in-flight speech — callers queue via enqueueAlertBatch.
 */
function speakPhrasesAndWait(phrases: string[]): Promise<void> {
  return new Promise((resolve) => {
    if (!phrases.length || typeof window === "undefined") {
      resolve();
      return;
    }
    if (!getSpeakAlertsEnabled() || !readPreferredVoiceName()) {
      resolve();
      return;
    }
    const synth = window.speechSynthesis;
    if (!synth) {
      resolve();
      return;
    }

    const toSpeak = phrases.filter(Boolean);
    if (!toSpeak.length) {
      resolve();
      return;
    }

    let left = toSpeak.length;
    const finishOne = () => {
      left -= 1;
      if (left <= 0) resolve();
    };

    try {
      kickSpeechSynth(synth);
      for (const phrase of toSpeak) {
        const utter = new SpeechSynthesisUtterance(phrase);
        applySpeechTone(utter);
        utter.onend = finishOne;
        utter.onerror = (ev) => {
          const err = (ev as SpeechSynthesisErrorEvent).error;
          // cancel() from reset — treat as done so the pump can stop.
          if (err === "interrupted" || err === "canceled") {
            left = 0;
            resolve();
            return;
          }
          finishOne();
        };
        synth.speak(utter);
      }
    } catch {
      resolve();
    }
  });
}

async function pumpAlertQueue(): Promise<void> {
  if (alertPumpRunning) return;
  alertPumpRunning = true;
  try {
    while (alertQueue.length) {
      const batch = alertQueue.shift()!;
      if (batch.chime) {
        try {
          await playBuyChime();
        } catch {
          /* ignore */
        }
      }
      await speakPhrasesAndWait(batch.phrases);
    }
  } finally {
    alertPumpRunning = false;
    // A batch may have been enqueued while we were finishing.
    if (alertQueue.length) void pumpAlertQueue();
  }
}

/** Queue phrases behind whatever is already speaking (no interrupt). */
function enqueueAlertBatch(phrases: string[], chime: boolean): void {
  const cleaned = phrases.filter(Boolean);
  if (!cleaned.length && !chime) return;
  alertQueue.push({ phrases: cleaned, chime });
  void pumpAlertQueue();
}

/** @deprecated internal — use enqueueAlertBatch */
function speakPhrases(phrases: string[]): void {
  enqueueAlertBatch(phrases, false);
}

export function setSpeakAlertsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(VOICE_SPEAK_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!on) {
    resetSpeechPipeline();
  }
}

function flushCoalescedBuys(): void {
  coalesceTimer = null;
  const items = coalesceItems;
  coalesceItems = [];
  if (!items.length) return;

  const mid = items.filter((i) => i.lane === "mid");
  const eom = items.filter((i) => i.lane === "eom");
  const phrases = [mid, eom]
    .map((group) => buildBuyAlertPhrase(group))
    .filter(Boolean);
  if (!phrases.length) return;

  const chime = getChimeAlertsEnabled();
  const willSpeak =
    getSpeakAlertsEnabled() && Boolean(readPreferredVoiceName());
  if (!chime && !willSpeak) return;

  enqueueAlertBatch(willSpeak ? phrases : [], chime);
}

/** Lit Trade Buy rows right now (for gesture re-arm). EOM Watch/Hold excluded. */
export function collectLitBuyAlerts(
  live: {
    assets?: Array<{
      snapshot?: { symbol?: AssetSymbol };
      marketTicker?: string;
      decision?: {
        modeA?: { action?: string; side?: Side };
        modeAMom?: { action?: string; side?: Side };
        modeB?: { action?: string; side?: Side };
      };
    }>;
  } | null,
): BuyAlertItem[] {
  if (!live?.assets?.length) return [];
  const out: BuyAlertItem[] = [];
  const seen = new Set<string>();
  for (const asset of live.assets) {
    const symbol = asset.snapshot?.symbol as AssetSymbol | undefined;
    if (!symbol) continue;
    const d = asset.decision;
    if (!d) continue;
    const mid = d.modeAMom ?? d.modeA;
    if (mid?.action === "buy") {
      const key = `${symbol}:mid`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ symbol, side: mid.side, lane: "mid" });
      }
    }
    const eom = d.modeB;
    if (eom?.action === "buy") {
      const key = `${symbol}:eom`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ symbol, side: eom.side, lane: "eom" });
      }
    }
  }
  return out;
}

/** Confirm toggle under the same click that unlocks audio. */
export async function announceAlertsEnabled(): Promise<void> {
  if (coalesceTimer != null) {
    window.clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  coalesceItems = [];
  // User gesture — clear backlog so "Alerts on" is heard promptly.
  resetSpeechPipeline();
  if (getChimeAlertsEnabled()) await playBuyChime();
  if (getSpeakAlertsEnabled() && readPreferredVoiceName()) {
    enqueueAlertBatch(["Alerts on"], false);
  }
}

/**
 * Announce Buys — optional chime + speak. If the voice is already talking, this
 * batch waits in line until the current recommendation finishes.
 * Pass `{ immediate: true }` under a user gesture (unlock / Alerts on).
 */
export function announceBuys(
  items: BuyAlertItem[],
  opts?: { immediate?: boolean },
): void {
  if (!items.length || typeof window === "undefined") return;
  if (opts?.immediate) {
    if (coalesceTimer != null) {
      window.clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    coalesceItems = [...items];
    flushCoalescedBuys();
    return;
  }
  coalesceItems.push(...items);
  if (coalesceTimer != null) window.clearTimeout(coalesceTimer);
  coalesceTimer = window.setTimeout(flushCoalescedBuys, COALESCE_MS);
}

/** @deprecated prefer announceBuys */
export function announceBuy(
  symbol: AssetSymbol,
  side: Side | undefined,
  lane: BuyAlertLane = "mid",
): void {
  announceBuys([{ symbol, side, lane }]);
}
