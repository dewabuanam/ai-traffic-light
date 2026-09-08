import {
  ALONG_UNITS,
  MAX_ALONG,
  MIN_ALONG,
  SIZES,
  alongFrom,
  clamp,
  loadPrefs,
  onPrefsChanged,
  savePrefs,
  sizeFor,
  unitsFor,
} from "./prefs.js";
import { bindUnlock, play } from "./sound.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;

const appWindow = getCurrentWindow();
const light = document.getElementById("light");
const housing = document.getElementById("housing");
const caption = document.getElementById("label");
const grip = document.getElementById("grip");

// This window shows one session, and `lights.rs` says which in the query
// string. It also says whether the window has ever been placed, and whether the
// user currently has the lights hidden — neither of which the page can work out
// for itself.
const params = new URLSearchParams(location.search);
const SESSION = params.get("session") ?? "";
const FRESH = params.get("fresh") === "1";
const START_HIDDEN = params.get("hidden") === "1";

let prefs = await loadPrefs();

bindUnlock();

/* ---------------- status ---------------- */

// What this light is showing. A window with no session is the placeholder the
// user gets when they keep the lights on screen with nothing running.
let shown = null;

// The last status seen, so only real transitions chime — the same reason the
// app stays quiet about whatever status it starts up in.
let heard = null;

const IDLE = { status: "green", title: "No sessions", detail: "No active Claude session" };

function paint() {
  const session = shown ?? IDLE;
  const status = session.status ?? "green";
  const vertical = prefs.orientation !== "horizontal";

  light.className = shown ? "light" : "light is-empty";
  housing.className = `housing ${vertical ? "vertical" : "horizontal"} is-${status}`;
  caption.textContent = session.title || "session";
  // The caption truncates to the width of its light, so the full name and what
  // the session is doing live in the tooltip.
  light.title = `${session.title || SESSION}\n${session.detail || status}`;
}

function chime(status) {
  const before = heard;
  heard = status;
  // Nothing to announce about the status this window opened in.
  if (before === null || before === status) return;

  const sound = prefs.sound;
  const lamp = sound?.[status];
  if (!sound?.enabled || !lamp?.enabled) return;
  play(lamp.voice, sound.volume);
}

function render(snapshot) {
  const mine = (snapshot?.sessions ?? []).find((s) => s.session_id === SESSION);
  // A session that has just ended leaves this window with nothing to show, but
  // `lights.rs` is already closing it — keep the last state rather than
  // flashing the placeholder on the way out.
  if (SESSION && !mine) {
    paint();
    return;
  }
  shown = mine ?? null;
  if (shown) chime(shown.status ?? "green");
  paint();
  resizeSoon();
}

async function refresh() {
  try {
    render(await invoke("get_status"));
  } catch (err) {
    console.error("get_status failed", err);
    paint();
  }
}

listen("status-changed", (event) => render(event.payload));

/* ---------------- layout ---------------- */

// Pick the lamp diameter. It comes from the size preference, clamped to the
// window: between a preference changing and the window resizing to match, the
// lamps shrink for a frame rather than being clipped.
function layout() {
  const vertical = prefs.orientation !== "horizontal";
  document.body.classList.toggle("is-horizontal", !vertical);

  const units = unitsFor(prefs.orientation, 1, prefs.showTitles);
  const fromPrefs = prefs.along / ALONG_UNITS;

  const alongPx = vertical ? window.innerHeight : window.innerWidth;
  const acrossPx = vertical ? window.innerWidth : window.innerHeight;
  // A hidden or not-yet-painted webview reports zero; go by the preference.
  const fromWindow =
    alongPx && acrossPx
      ? Math.min(alongPx / units.along, acrossPx / units.across)
      : fromPrefs;

  const lamp = Math.max(4, Math.floor(Math.min(fromPrefs, fromWindow)));
  document.documentElement.style.setProperty("--lamp", `${lamp}px`);
}

/* ---------------- window size ---------------- */

// Both axes come from the size preference, so the light always fits its window
// exactly. Every resize therefore has to move both axes together, which is why
// the window is not resizable by the OS (see `lights.rs`) and the grip below
// drives it all.
let drag = null;

// The last size we asked for, so our own change echoing back is not mistaken
// for the user resizing again.
let requested = null;

async function resizeFromPrefs() {
  const { w, h } = sizeFor(prefs.along, prefs.orientation, 1, prefs.showTitles);
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
    resizeFromPrefs().catch((err) => console.error("resize failed", err));
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

// Put this light where it belongs: the default size, then a position. Size
// first, because where a bottom or right corner puts the window depends on how
// big it is. The position itself is worked out in Rust, which can see both the
// screen's work area — the part the taskbar does not cover — and where the
// other lights are.
//
// `place_new_light` is for a light that has never been placed: it joins the
// lights already on screen rather than going to the corner, so a new session
// turns up next to the row rather than somewhere else entirely. `place_light`
// is the explicit "go to the default position", which always means the corner.
async function place(command) {
  prefs.along = clamp(Math.round(prefs.defaultAlong), MIN_ALONG, MAX_ALONG);
  saveNow();
  await resizeFromPrefs();
  try {
    await invoke(command, { corner: prefs.defaultCorner, margin: prefs.defaultMargin });
  } catch (err) {
    console.error(`${command} failed`, err);
  }
}

window.addEventListener("resize", layout);

/* ---------------- moving and focusing ---------------- */

// Moving the window and clicking the light are the same press, so the press
// stays a click only while the pointer holds still; past a few pixels it
// becomes a window drag. This is why the light is not a
// `data-tauri-drag-region`: that swallows the press, and the click with it.
const DRAG_SLOP = 4;
let press = null;

// The pointer is captured for the duration of the press. A light is a small
// window, and a quick flick takes the pointer outside it before the first
// `pointermove` lands — without capture those moves go nowhere and the drag
// never starts, so the light simply refuses to move.
function releasePress() {
  if (!press) return;
  try {
    light.releasePointerCapture(press.id);
  } catch {
    /* capture is already gone */
  }
  press = null;
}

light.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  light.setPointerCapture(event.pointerId);
  press = { id: event.pointerId, x: event.clientX, y: event.clientY };
});

light.addEventListener("pointermove", (event) => {
  if (!press || event.pointerId !== press.id) return;
  if (
    Math.abs(event.clientX - press.x) < DRAG_SLOP &&
    Math.abs(event.clientY - press.y) < DRAG_SLOP
  ) {
    return;
  }
  // The OS takes the pointer from here — so hand it over, and expect no
  // pointerup of our own.
  releasePress();
  appWindow.startDragging().catch((err) => console.error("startDragging failed", err));
});

light.addEventListener("pointerup", (event) => {
  if (!press || event.pointerId !== press.id) return;
  releasePress();
  if (!SESSION || !prefs.clickFocus) return;

  // Best effort: the terminal may have been closed, or be one this cannot
  // find. Nothing useful to say to the user about it from a click.
  invoke("focus_session", { sessionId: SESSION }).catch((err) =>
    console.warn("focus_session failed", err)
  );
});

light.addEventListener("pointercancel", releasePress);

/* ---------------- resizing ---------------- */

// The drag is driven here rather than by the OS, because an OS drag moves only
// the edge being pulled. With the short side locked to the long one, that left
// the window off-ratio for the whole gesture — a dark band opening up beside
// the lamps — and any correction sent mid-drag fought the OS drag loop and made
// the window flicker between the two widths. Doing it ourselves keeps both axes
// in step on every frame.
//
// The window is built `resizable: false` so that no OS drag can start at all.
// While it was resizable, wry hit-tested the border itself and claimed the
// outermost few pixels of the grip — including its two corners, where the OS
// resized the short axis too and the correction fought it hardest. That is the
// same strip of pixels this handler needs, so the two paths were racing for
// every press near the end of the grip.
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
  // distance from that corner — which is the new window length once the grab
  // offset is added back. `alongFrom` takes the caption back off it.
  const edge = (drag.horizontal ? event.clientX : event.clientY) + drag.offset;
  const along = alongFrom(edge, prefs.orientation, 1, prefs.showTitles);
  prefs.along = clamp(Math.round(along), MIN_ALONG, MAX_ALONG);
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
// Rust handles the entries that do not touch preferences and sends the rest
// here. Anything that changes a preference goes to every light; "home" comes
// back only to the light the menu was opened on.
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
      await applyAll();
      break;
    case "small":
    case "medium":
    case "large":
      await setAlong(SIZES[event.payload]);
      break;
    case "home":
      await place("place_light");
      break;
  }
});

/* ---------------- applying prefs ---------------- */

function applyAppearance() {
  document.documentElement.style.setProperty("--opacity", String(prefs.opacity));
  document.body.dataset.housing = prefs.housing;
  document.body.dataset.titles = prefs.showTitles ? "on" : "off";
  document.body.dataset.clickFocus = prefs.clickFocus ? "on" : "off";
}

async function applyAlwaysOnTop() {
  await appWindow.setAlwaysOnTop(prefs.alwaysOnTop);
}

async function applyAll() {
  applyAppearance();
  await applyAlwaysOnTop();
  // Orientation and the caption toggle both change how the light is built and
  // how big the window has to be, so it is repainted before it is measured.
  paint();
  await resizeFromPrefs();
}

onPrefsChanged((next) => {
  prefs = next;
  applyAll();
});

// The window is built hidden, so nothing is seen at the wrong size or in the
// wrong place. It shows itself once it is sized — and only then: a light that
// opens while the user has them all hidden must stay hidden too.
applyAll()
  .then(refresh)
  .then(async () => {
    // A window with no remembered position has never been placed, so it takes
    // one now — beside the lights already on screen if there are any.
    if (FRESH) await place("place_new_light");
    if (!START_HIDDEN) await appWindow.show();
  })
  .then(() => appWindow.onResized(({ payload }) => onResized(payload)));
