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

// The short axis is derived from the long one, so the housing always fits the
// lamps exactly and no background shows beside them. Every resize therefore has
// to move both axes together, which is why the window is not resizable by the
// OS (see `resizable` in `tauri.conf.json`) and the grip below drives it all.
let drag = null;

// The last size we asked for, so our own change echoing back is not mistaken
// for the user resizing again.
let requested = null;

async function resizeFromPrefs() {
  const { w, h } = sizeFor(prefs.along, prefs.orientation);
  layout();
  if (Math.abs(w - window.innerWidth) <= 1 && Math.abs(h - window.innerHeight) <= 1) return;
  requested = { w, h };
  await appWindow.setSize(new LogicalSize(w, h));
  layout();
}

// One resize per frame, so a fast drag cannot outrun the compositor.
let framePending = false;

function resizeSoon() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    resizeFromPrefs();
  });
}

// A file write per frame of a drag would be wasteful; once it settles is enough.
let saveTimer = null;

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savePrefs(prefs), 250);
}

function saveNow() {
  clearTimeout(saveTimer);
  savePrefs(prefs);
}

function onResized(physical) {
  // Our own pointer drag already keeps both axes in step.
  if (drag) return;

  const scale = window.devicePixelRatio || 1;
  const w = Math.round(physical.width / scale);
  const h = Math.round(physical.height / scale);

  // Our own change echoing back: only the lamps need re-fitting.
  if (requested && Math.abs(requested.w - w) <= 1 && Math.abs(requested.h - h) <= 1) {
    layout();
    return;
  }

  // Nothing else is meant to resize this window, so a size we did not ask for
  // is the window being shown, hidden, or moved to a screen at another scale.
  // Put it back on the ratio, and never write it down as the user's size.
  resizeFromPrefs();
}

async function setAlong(along) {
  prefs.along = clamp(Math.round(along), MIN_ALONG, MAX_ALONG);
  saveNow();
  await resizeFromPrefs();
}

window.addEventListener("resize", layout);

/* ---------------- resizing ---------------- */

// The drag is driven here rather than by the OS, because an OS drag moves only
// the edge being pulled. With the short side locked to the long one, that left
// the window off-ratio for the whole gesture — a dark band opening up beside
// the lamps — and any correction sent mid-drag fought the OS drag loop and made
// the window flicker between the two widths. Doing it ourselves keeps both axes
// in step on every frame.
//
// The window is `resizable: false` so that no OS drag can start at all. While
// it was resizable, wry hit-tested the border itself and claimed the outermost
// few pixels of the grip — including its two corners, where the OS resized the
// short axis too and the correction fought it hardest. That is the same strip
// of pixels this handler needs, so the two paths were racing for every press
// near the end of the grip.
grip.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);
  const horizontal = prefs.orientation === "horizontal";
  drag = {
    id: event.pointerId,
    horizontal,
    // Distance from the pointer to the edge, so the edge keeps its grip on the
    // pointer rather than jumping to sit under it.
    offset: horizontal
      ? window.innerWidth - event.clientX
      : window.innerHeight - event.clientY,
  };
});

grip.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  // The window's top-left stays put, so the pointer's client coordinate is the
  // distance from that corner — which is the new length once the grab offset
  // is added back.
  const edge = (drag.horizontal ? event.clientX : event.clientY) + drag.offset;
  prefs.along = clamp(Math.round(edge), MIN_ALONG, MAX_ALONG);
  resizeSoon();
});

function endDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  try {
    grip.releasePointerCapture(drag.id);
  } catch {
    /* capture is already gone */
  }
  drag = null;
  saveNow();
}

grip.addEventListener("pointerup", endDrag);
grip.addEventListener("pointercancel", endDrag);

// Ctrl + wheel scales the window around its current top-left corner.
window.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    prefs.along = clamp(Math.round(prefs.along * factor), MIN_ALONG, MAX_ALONG);
    resizeSoon();
    saveSoon();
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
applyAll().then(() => appWindow.onResized(({ payload }) => onResized(payload)));
