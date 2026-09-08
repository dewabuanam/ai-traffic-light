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

// Geometry of one light, in multiples of one lamp diameter. `main.js` sizes the
// lamps from the same numbers, and they fix the window's aspect ratio.
export const GAP_RATIO = 0.22;
export const PAD_RATIO = 0.28;
export const ALONG_UNITS = 3 + 2 * GAP_RATIO + 2 * PAD_RATIO;
export const ACROSS_UNITS = 1 + 2 * PAD_RATIO;
export const ASPECT = ACROSS_UNITS / ALONG_UNITS;

// The caption strip under a light's lamps, and the space between two lights.
export const LABEL_UNITS = 0.42;
export const LIGHT_GAP_UNITS = 0.3;

// `along` is the lamp axis of a *single* light, caption excluded, so the light
// keeps its proportions no matter how many sessions are running.
export const MIN_ALONG = 48;
export const MAX_ALONG = 900;

export const SIZES = { small: 112, medium: 264, large: 384 };

// Where the light goes when it has nowhere else to be: first run, "Restore
// defaults", and "Move light there now". Corners rather than coordinates,
// because a saved x/y lands off-screen as soon as the display setup changes.
export const CORNERS = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
  centre: "Centre",
};

export const MAX_MARGIN = 200;

export const DEFAULTS = {
  alwaysOnTop: true,
  opacity: 1,
  housing: "solid", // solid | translucent | none
  orientation: "vertical", // vertical | horizontal
  along: SIZES.medium,
  // The light's home: see CORNERS. `defaultAlong` is the size it goes back to,
  // kept apart from `along` so experimenting with the size does not lose it.
  defaultCorner: "top-right",
  defaultMargin: 40,
  defaultAlong: SIZES.medium,
  // Hide the light when no session is running, and bring it back when one
  // starts, so an idle desktop is not decorated with a dead traffic light.
  autoHide: true,
  // Caption each light with its session's folder name.
  showTitles: true,
  // Clicking a light raises the terminal that session is running in.
  clickFocus: true,
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

// Set by `loadPrefs`: true when nothing had been stored yet. The light uses it
// to place itself on first run — and then saves, so the next run is not a first
// run and whatever position the user has since chosen is left alone.
let fresh = false;

export function isFirstRun() {
  return fresh;
}

export async function loadPrefs() {
  try {
    const stored = await invoke("get_prefs");
    fresh = !stored || Object.keys(stored).length === 0;
    return merge(DEFAULTS, stored);
  } catch (err) {
    console.error("get_prefs failed", err);
    // Not a first run — just a failed read. Placing the light on top of
    // wherever the user put it would be the wrong guess here.
    fresh = false;
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

/// The whole window's footprint in lamp diameters, for `count` lights.
///
/// Lights tile across the short axis — side by side when they are vertical,
/// stacked when they are horizontal — and the caption always sits under a
/// light's lamps, which puts it on the long axis when vertical and on the short
/// axis when horizontal.
export function unitsFor(orientation, count = 1, labels = true) {
  const n = Math.max(1, count);
  const label = labels ? LABEL_UNITS : 0;
  const gaps = (n - 1) * LIGHT_GAP_UNITS;
  return orientation === "horizontal"
    ? { along: ALONG_UNITS, across: n * (ACROSS_UNITS + label) + gaps }
    : { along: ALONG_UNITS + label, across: n * ACROSS_UNITS + gaps };
}

/// Window size for a given single-light long-axis length. Both axes come out of
/// `along`, so the lights always fit the window exactly.
export function sizeFor(along, orientation, count = 1, labels = true) {
  const a = clamp(Math.round(along), MIN_ALONG, MAX_ALONG);
  const lamp = a / ALONG_UNITS;
  const units = unitsFor(orientation, count, labels);
  // Rounded up, never down: a window half a pixel narrower than the row it
  // holds clips the last light, while half a pixel too wide is transparent
  // margin on a transparent window. Three lights at the default size land on
  // exactly that half pixel (348.48).
  const alongPx = Math.ceil(lamp * units.along);
  const acrossPx = Math.ceil(lamp * units.across);
  return orientation === "horizontal"
    ? { w: alongPx, h: acrossPx }
    : { w: acrossPx, h: alongPx };
}

/// The inverse: a dragged window length on the long axis back to `along`. The
/// caption rides on that axis when the lights are vertical, so it has to come
/// back off again or the light would grow by a caption on every drag.
export function alongFrom(length, orientation, count = 1, labels = true) {
  const units = unitsFor(orientation, count, labels);
  return (length * ALONG_UNITS) / units.along;
}
