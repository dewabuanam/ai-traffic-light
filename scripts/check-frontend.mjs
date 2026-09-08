// Loads every frontend module against a stub DOM and a stub `window.__TAURI__`,
// so anything that throws while a module is being evaluated fails here.
//
// There is no bundler and no test runner, and a throw at module scope is silent
// in the app itself: the window still paints, the lamps still light from an
// already-issued `get_status`, and only the code after the throw goes missing.
// That has cost real debugging time twice, so it is worth a check.
//
//   node scripts/check-frontend.mjs
//
// The modules import each other by `.js`, which Node resolves fine from disk;
// they are loaded as ES modules straight out of `src/`.

import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

const SRC = path.resolve(import.meta.dirname, "..", "src");

// Every id the two pages actually define. Asking for anything else is the bug
// this check is looking for, so it throws rather than handing back a stub.
const IDS = new Set([
  "housing",
  "grip",
  "sound-enabled",
  "volume",
  "volume-out",
  "opacity",
  "opacity-out",
  "orientation",
  "along",
  "along-out",
  "always-on-top",
  "restore",
  "close",
]);

const stubElement = (id) => ({
  id,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  style: { setProperty() {} },
  dataset: {},
  hidden: false,
  title: "",
  value: "",
  checked: false,
  disabled: false,
  min: "",
  max: "",
  offsetWidth: 100,
  offsetHeight: 100,
  addEventListener(type) { registered.push(`${id}.${type}`); },
  setPointerCapture() {},
  releasePointerCapture() {},
  querySelector: () => stubElement(`${id}>*`),
  querySelectorAll: () => [],
  append() {},
  closest: () => null,
});

const stubLampRow = (status) => ({
  dataset: { status },
  classList: { add() {}, remove() {}, toggle() {} },
  querySelector: () => stubElement(`${status}-field`),
});

const registered = [];

globalThis.document = {
  documentElement: { style: { setProperty() {} }, dataset: {} },
  body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
  title: "",
  getElementById(id) {
    if (!IDS.has(id)) throw new Error(`getElementById("${id}") — no such element in the page`);
    return stubElement(id);
  },
  querySelector: () => stubElement("query"),
  querySelectorAll: (selector) =>
    selector === ".lamp-row" ? ["red", "yellow", "green"].map(stubLampRow) : [],
  createElement: () => ({ textContent: "", value: "" }),
  addEventListener() {},
};

globalThis.window = {
  innerWidth: 103,
  innerHeight: 264,
  devicePixelRatio: 1,
  addEventListener(type) { registered.push(`window.${type}`); },
  AudioContext: function AudioContext() {
    const node = { connect: (next) => next };
    return {
      state: "running",
      currentTime: 0,
      destination: node,
      resume: () => Promise.resolve(),
      createOscillator: () => ({
        type: "sine",
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (next) => next,
        start() {},
        stop() {},
      }),
      createGain: () => ({
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (next) => next,
      }),
    };
  },
  __TAURI__: {
    core: {
      invoke(command) {
        registered.push(`invoke:${command}`);
        return Promise.resolve({});
      },
    },
    event: {
      listen(name) {
        registered.push(`listen:${name}`);
        return Promise.resolve(() => {});
      },
      emit: () => Promise.resolve(),
    },
    window: {
      getCurrentWindow: () => ({
        setSize: () => Promise.resolve(),
        setAlwaysOnTop: () => Promise.resolve(),
        hide: () => Promise.resolve(),
        close: () => Promise.resolve(),
        onResized() {
          registered.push("onResized");
          return Promise.resolve(() => {});
        },
      }),
      LogicalSize: class LogicalSize {
        constructor(width, height) {
          this.width = width;
          this.height = height;
        }
      },
    },
  },
};

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let failed = false;
process.on("unhandledRejection", (error) => {
  console.error(`  unhandled rejection: ${error?.message ?? error}`);
  failed = true;
});

// `main.js` must get all the way to registering the resize listener: that call
// sits behind `applyAll()`, so anything which makes it reject silently loses
// resizing, sizing and live preference updates.
const REQUIRED = { "main.js": ["onResized", "listen:status-changed", "listen:prefs-changed"] };

for (const entry of ["main.js", "settings.js"]) {
  registered.length = 0;
  process.stdout.write(`${entry}: `);
  try {
    await import(`${pathToFileURL(path.join(SRC, entry)).href}?t=${Date.now()}`);
  } catch (error) {
    console.log(`threw while evaluating — ${error?.message ?? error}`);
    failed = true;
    continue;
  }
  // Let the microtask queue and one animation frame drain.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const missing = (REQUIRED[entry] ?? []).filter((name) => !registered.includes(name));
  if (missing.length) {
    console.log(`never reached ${missing.join(", ")}`);
    failed = true;
  } else {
    console.log(`ok (${registered.length} handlers)`);
  }
}

if (failed) {
  console.error("\nfrontend check failed");
  process.exit(1);
}
console.log("\nfrontend check passed");
