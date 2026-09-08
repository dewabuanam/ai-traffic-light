// Preferences shared by the light window and the settings window.
//
// The backend owns the record: both windows read it from there and write it back
// through there, so neither can hold a stale copy and clobber the other's
// changes. Rust echoes every write to every window; the `_src` token lets the
// window that made the change ignore its own echo.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const CHANNEL = "prefs-changed";
const ME = Math.random().toString(36).slice(2);

// Geometry of the housing, in multiples of one lamp diameter. `main.js` uses the
// same numbers to size the lamps, and they fix the window's aspect ratio.
export const GAP_RATIO = 0.22;
export const PAD_RATIO = 0.28;
export const ALONG_UNITS = 3 + 2 * GAP_RATIO + 2 * PAD_RATIO;
export const ACROSS_UNITS = 1 + 2 * PAD_RATIO;
export const ASPECT = ACROSS_UNITS / ALONG_UNITS;

export const MIN_ALONG = 144;
export const MAX_ALONG = 900;

export const SIZES = { small: 176, medium: 264, large: 384 };

export const DEFAULTS = {
  alwaysOnTop: true,
  opacity: 1,
  housing: "solid", // solid | translucent | none
  orientation: "vertical", // vertical | horizontal
  along: SIZES.medium,
  sound: {
    enabled: true,
    volume: 0.6,
    red: { enabled: true, voice: "alert" },
    yellow: { enabled: true, voice: "blip" },
    green: { enabled: true, voice: "chime" },
  },
};

function merge(base, override) {
  if (!override || typeof override !== "object") return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (!(key in out)) continue;
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? merge(out[key], value)
        : value;
  }
  return out;
}

export async function loadPrefs() {
  try {
    return merge(DEFAULTS, await invoke("get_prefs"));
  } catch (err) {
    console.error("get_prefs failed", err);
    return structuredClone(DEFAULTS);
  }
}

export function savePrefs(prefs) {
  return invoke("set_prefs", { value: { ...prefs, _src: ME } }).catch((err) =>
    console.error("set_prefs failed", err)
  );
}

export function onPrefsChanged(handler) {
  return listen(CHANNEL, (event) => {
    const payload = event.payload;
    if (!payload || payload._src === ME) return;
    handler(merge(DEFAULTS, payload));
  });
}

export function defaults() {
  return structuredClone(DEFAULTS);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/// Window size for a given long-axis length, with the width locked to the ratio.
export function sizeFor(along, orientation) {
  const a = Math.round(clamp(along, MIN_ALONG, MAX_ALONG));
  const across = Math.round(a * ASPECT);
  return orientation === "horizontal" ? { w: a, h: across } : { w: across, h: a };
}
