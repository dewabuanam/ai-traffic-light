import {
  ALONG_UNITS,
  ACROSS_UNITS,
  MAX_ALONG,
  MIN_ALONG,
  SIZES,
  clamp,
  loadPrefs,
  onPrefsChanged,
  savePrefs,
  sizeFor,
} from "./prefs.js";
import { bindUnlock, play } from "./sound.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

const appWindow = getCurrentWindow();
const housing = document.getElementById("housing");
const grip = document.getElementById("grip");

let prefs = await loadPrefs();
let lastStatus = null;

bindUnlock();

/* ---------------- status ---------------- */

function render(snapshot) {
  const status = snapshot?.status ?? "green";
  housing.classList.remove("is-red", "is-yellow", "is-green");
  housing.classList.add(`is-${status}`);
  housing.title = snapshot?.detail || status;

  // Only announce real transitions, never the status we start up already in.
  if (lastStatus !== null && status !== lastStatus) chime(status);
  lastStatus = status;
}

function chime(status) {
  const sound = prefs.sound;
  const lamp = sound?.[status];
  if (!sound?.enabled || !lamp?.enabled) return;
  play(lamp.voice, sound.volume);
}

async function refresh() {
  try {
    render(await invoke("get_status"));
  } catch (err) {
    console.error("get_status failed", err);
  }
}

listen("status-changed", (event) => render(event.payload));
refresh();

/* ---------------- layout ---------------- */

// Pick the largest lamp diameter that still fits three lamps plus padding.
function layout() {
  const vertical = prefs.orientation !== "horizontal";
  housing.classList.toggle("vertical", vertical);
  housing.classList.toggle("horizontal", !vertical);
  document.body.classList.toggle("is-horizontal", !vertical);

  // A hidden or not-yet-painted webview reports zero; leave the lamps as they are.
  if (!window.innerWidth || !window.innerHeight) return;

  const along = vertical ? window.innerHeight : window.innerWidth;
  const across = vertical ? window.innerWidth : window.innerHeight;

  const lamp = Math.max(8, Math.floor(Math.min(along / ALONG_UNITS, across / ACROSS_UNITS)));
  document.documentElement.style.setProperty("--lamp", `${lamp}px`);
}

/* ---------------- window size ---------------- */

// The window's short axis is derived from its long axis, so the housing always
// fills the frame exactly and no background peeks out beside the lamps.
let applying = false;

async function resizeFromPrefs() {
  const { w, h } = sizeFor(prefs.along, prefs.orientation);
  if (Math.abs(w - window.innerWidth) > 1 || Math.abs(h - window.innerHeight) > 1) {
    applying = true;
    try {
      await appWindow.setSize(new LogicalSize(w, h));
    } finally {
      // Let our own resize event land before we start believing them again.
      setTimeout(() => (applying = false), 150);
    }
  }
  layout();
}

// The user dragged the grip: adopt the new long axis and snap the short one back.
//
// The size comes from Tauri rather than `window.innerWidth/innerHeight`, which
// read zero before the webview has painted. Sizes we asked for ourselves, and
// sizes below the minimum, are ignored — persisting either one used to shrink
// the light permanently.
let snapTimer = null;

function scheduleSnap(physical) {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => absorbResize(physical), 120);
}

async function absorbResize(physical) {
  if (applying) return;

  const scale = window.devicePixelRatio || 1;
  const vertical = prefs.orientation !== "horizontal";
  const along = Math.round((vertical ? physical.height : physical.width) / scale);

  // Anything under the minimum is a window that is hiding, minimising or being
  // torn down rather than a drag. Restore the size, and never write it down.
  if (!(along >= MIN_ALONG)) {
    await resizeFromPrefs();
    return;
  }

  const next = Math.min(along, MAX_ALONG);
  if (next !== prefs.along) {
    prefs.along = next;
    savePrefs(prefs);
  }
  await resizeFromPrefs();
}

async function setAlong(along) {
  prefs.along = clamp(Math.round(along), MIN_ALONG, MAX_ALONG);
  savePrefs(prefs);
  await resizeFromPrefs();
}

window.addEventListener("resize", layout);

/* ---------------- window controls ---------------- */

grip.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  // Only the long axis is draggable — the short axis is locked to the ratio.
  appWindow.startResizeDragging(prefs.orientation === "horizontal" ? "East" : "South");
});

// Ctrl + wheel scales the window around its current top-left corner.
window.addEventListener(
  "wheel",
  async (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    await setAlong(prefs.along * factor);
  },
  { passive: false }
);

/* ---------------- context menu ---------------- */

// The menu itself is native — the window is far too small to draw one inside.
// Rust handles the entries that do not touch preferences and sends the rest here.
window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  invoke("show_context_menu", { alwaysOnTop: prefs.alwaysOnTop }).catch((err) =>
    console.error("show_context_menu failed", err)
  );
});

listen("menu-action", async (event) => {
  switch (event.payload) {
    case "top":
      prefs.alwaysOnTop = !prefs.alwaysOnTop;
      savePrefs(prefs);
      await applyAlwaysOnTop();
      break;
    case "rotate":
      prefs.orientation = prefs.orientation === "horizontal" ? "vertical" : "horizontal";
      savePrefs(prefs);
      await resizeFromPrefs();
      break;
    case "small":
    case "medium":
    case "large":
      await setAlong(SIZES[event.payload]);
      break;
  }
});

/* ---------------- applying prefs ---------------- */

function applyAppearance() {
  document.documentElement.style.setProperty("--opacity", String(prefs.opacity));
  document.body.dataset.housing = prefs.housing;
}

async function applyAlwaysOnTop() {
  await appWindow.setAlwaysOnTop(prefs.alwaysOnTop);
}

async function applyAll() {
  // A snap queued against the old geometry would write back a stale size.
  clearTimeout(snapTimer);
  applyAppearance();
  await applyAlwaysOnTop();
  await resizeFromPrefs();
}

onPrefsChanged((next) => {
  prefs = next;
  applyAll();
});

// Only start tracking resizes once the window is at the size we asked for, so a
// startup transient can never be mistaken for the user dragging the grip.
applyAll().then(() => appWindow.onResized(({ payload }) => scheduleSnap(payload)));
