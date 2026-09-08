// Status sounds, synthesised with the Web Audio API.
//
// Everything is generated at runtime so the app ships no audio assets and stays
// inside the `default-src 'self'` CSP. A voice is just a list of notes; each note
// is one oscillator with an exponential attack/decay envelope.

const NOTE_DEFAULTS = { type: "sine", g: 1, t: 0, d: 0.2 };

// Keeps a few simultaneous oscillators from clipping the output.
const HEADROOM = 0.35;

export const VOICES = {
  none: { label: "None (silent)", notes: [] },

  chime: {
    label: "Chime — two-note rise",
    notes: [
      { f: 784, t: 0, d: 0.2, g: 0.9 },
      { f: 1175, t: 0.12, d: 0.42, g: 0.8 },
    ],
  },

  descend: {
    label: "Descend — two-note fall",
    notes: [
      { f: 660, t: 0, d: 0.18, g: 0.85 },
      { f: 440, t: 0.13, d: 0.4, g: 0.8 },
    ],
  },

  bell: {
    label: "Bell",
    notes: [
      { f: 1046, t: 0, d: 0.9, g: 0.8 },
      { f: 2886, t: 0, d: 0.5, g: 0.18 },
      { f: 5230, t: 0, d: 0.25, g: 0.07 },
    ],
  },

  blip: {
    label: "Blip",
    notes: [{ f: 660, t: 0, d: 0.09, g: 0.9, type: "triangle" }],
  },

  beep: {
    label: "Beep",
    notes: [{ f: 880, t: 0, d: 0.13, g: 0.55, type: "square" }],
  },

  alert: {
    label: "Alert — triple pulse",
    notes: [
      { f: 988, t: 0, d: 0.07, g: 0.5, type: "square" },
      { f: 988, t: 0.11, d: 0.07, g: 0.5, type: "square" },
      { f: 988, t: 0.22, d: 0.12, g: 0.5, type: "square" },
    ],
  },

  siren: {
    label: "Siren",
    notes: [
      { f: 440, to: 880, t: 0, d: 0.22, g: 0.35, type: "sawtooth" },
      { f: 880, to: 440, t: 0.22, d: 0.26, g: 0.35, type: "sawtooth" },
    ],
  },

  knock: {
    label: "Knock",
    notes: [
      { f: 190, to: 90, t: 0, d: 0.1, g: 0.9, type: "triangle" },
      { f: 190, to: 90, t: 0.15, d: 0.12, g: 0.9, type: "triangle" },
    ],
  },

  pop: {
    label: "Pop",
    notes: [{ f: 320, to: 940, t: 0, d: 0.08, g: 0.8 }],
  },
};

export const VOICE_IDS = Object.keys(VOICES);

let ctx = null;

function context() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/// Chromium suspends a fresh AudioContext until the page has seen a gesture.
/// The WebView2 autoplay flag normally covers this; this is the belt-and-braces.
export function unlock() {
  context();
}

export function bindUnlock(target = window) {
  const once = { once: true, capture: true };
  target.addEventListener("pointerdown", unlock, once);
  target.addEventListener("keydown", unlock, once);
}

export function play(voiceId, volume = 0.6) {
  const voice = VOICES[voiceId];
  if (!voice || voice.notes.length === 0) return;

  const level = Math.max(0, Math.min(1, Number(volume) || 0));
  if (level === 0) return;

  const ac = context();
  if (!ac) return;

  const t0 = ac.currentTime + 0.01;

  for (const raw of voice.notes) {
    const note = { ...NOTE_DEFAULTS, ...raw };
    const start = t0 + note.t;
    const end = start + note.d;
    const peak = Math.max(0.0001, note.g * level * HEADROOM);

    const osc = ac.createOscillator();
    osc.type = note.type;
    osc.frequency.setValueAtTime(note.f, start);
    if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, end);

    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}
