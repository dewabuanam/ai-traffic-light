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
  "lights",
  "grip",
  "housing",
  "sound-enabled",
  "volume",
  "volume-out",
  "opacity",
  "opacity-out",
  "orientation",
  "along",
  "along-out",
  "show-titles",
  "default-corner",
  "default-margin",
  "default-margin-out",
  "default-along",
  "default-along-out",
  "go-home",
  "always-on-top",
  "auto-hide",
  "click-focus",
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
  children: [],
  addEventListener(type) { registered.push(`${id}.${type}`); },
  remove() { registered.push(`${id}.remove`); },
  setPointerCapture() {},
  releasePointerCapture() {},
  querySelector: () => stubElement(`${id}>*`),
  querySelectorAll: () => [],
  // Recorded, because the light window building nothing at all is exactly the
  // silent failure this check exists to catch.
  append(...nodes) { registered.push(`${id}.append`); built.push(...nodes); },
  closest: () => null,
});

const stubLampRow = (status) => ({
  dataset: { status },
  classList: { add() {}, remove() {}, toggle() {} },
  querySelector: () => stubElement(`${status}-field`),
});

const registered = [];

// What `get_status` hands back: two sessions in different states, which is what
// the light window is for now.
const SNAPSHOT = {
  status: "red",
  detail: "Claude needs your response",
  sessions: [
    {
      session_id: "aaa111",
      status: "yellow",
      title: "api",
      detail: "Running Bash",
      cwd: "C:/work/api",
      console: 0,
      pids: [],
    },
    {
      session_id: "bbb222",
      status: "red",
      title: "ai-traffic-lights",
      detail: "Claude needs your response",
      cwd: "C:/work/ai-traffic-lights",
      console: 0,
      pids: [4242],
    },
  ],
};

// What `get_prefs` hands back. Empty is a first run — nothing has ever been
// stored, so nothing has ever placed the light.
const STORED = { value: {} };

// Event handlers the page registered, by event name.
const handlers = new Map();

// Nodes the page appended, so the check can tell a page that rendered from one
// that merely finished without throwing.
const built = [];

// A DOM node stub complete enough to assemble a light out of.
const stubNode = (tag) => {
  const node = {
    tag,
    className: "",
    dataset: {},
    textContent: "",
    title: "",
    value: "",
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {} },
    append(...nodes) { node.children.push(...nodes); },
    remove() {},
    closest: () => null,
    querySelector: () => stubNode("child"),
  };
  return node;
};

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
  createElement: (tag) => stubNode(tag),
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
        // Two live sessions, so the light window has to build a row rather than
        // the single light it would get away with from an empty snapshot.
        if (command === "get_status") return Promise.resolve(SNAPSHOT);
        if (command === "get_prefs") return Promise.resolve(STORED.value);
        return Promise.resolve({});
      },
    },
    event: {
      listen(name, handler) {
        registered.push(`listen:${name}`);
        // Kept so the check can deliver an event the way Rust does, and see
        // whether the page really reacts to it.
        handlers.set(name, handler);
        return Promise.resolve(() => {});
      },
      emit: () => Promise.resolve(),
    },
    window: {
      getCurrentWindow: () => ({
        setSize: () => Promise.resolve(),
        setAlwaysOnTop: () => Promise.resolve(),
        show: () => {
          registered.push("win.show");
          return Promise.resolve();
        },
        hide: () => {
          registered.push("win.hide");
          return Promise.resolve();
        },
        unminimize: () => Promise.resolve(),
        setFocus: () => Promise.resolve(),
        startDragging: () => Promise.resolve(),
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

// Let the microtask queue and one animation frame drain.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let failed = false;
process.on("unhandledRejection", (error) => {
  console.error(`  unhandled rejection: ${error?.message ?? error}`);
  failed = true;
});

// `main.js` must get all the way to registering the resize listener: that call
// sits behind `applyAll()`, so anything which makes it reject silently loses
// resizing, sizing and live preference updates.
const REQUIRED = {
  "main.js": [
    "onResized",
    "listen:status-changed",
    "listen:prefs-changed",
    "listen:visibility-forced",
    "lights.append",
    "lights.pointerdown",
    "grip.pointerdown",
    // Auto-hide has to bring the window back for a live session, and the window
    // starts hidden, so this is the only thing that ever shows it.
    "win.show",
    // Nothing is stored in this run, so it is a first run and the light has to
    // put itself in its default corner.
    "invoke:place_light",
  ],
};

// A light is a housing with three lamps and a caption. Checking the shape, not
// just that something was appended, is what catches a render that half-ran.
function describeRow() {
  // The row is re-appended when it is reordered, so the same node can arrive
  // more than once. Count nodes, not appends.
  const roots = [...new Set(built)].filter((node) => node?.className?.startsWith("light"));
  const housings = roots.flatMap((root) =>
    (root.children ?? []).filter((child) => child?.className?.startsWith("housing"))
  );
  const lamps = housings.flatMap((h) => h.children ?? []);
  const labels = roots.flatMap((root) =>
    (root.children ?? []).filter((child) => child?.className === "label")
  );
  return { roots: roots.length, housings: housings.length, lamps: lamps.length, labels: labels.length };
}

for (const entry of ["main.js", "settings.js"]) {
  registered.length = 0;
  built.length = 0;
  process.stdout.write(`${entry}: `);
  try {
    await import(`${pathToFileURL(path.join(SRC, entry)).href}?t=${Date.now()}`);
  } catch (error) {
    console.log(`threw while evaluating — ${error?.message ?? error}`);
    failed = true;
    continue;
  }
  await settle();

  const missing = (REQUIRED[entry] ?? []).filter((name) => !registered.includes(name));
  if (missing.length) {
    console.log(`never reached ${missing.join(", ")}`);
    failed = true;
    continue;
  }

  if (entry === "main.js") {
    const row = describeRow();
    const want = SNAPSHOT.sessions.length;
    if (row.roots !== want || row.housings !== want || row.lamps !== want * 3 || row.labels !== want) {
      console.log(
        `expected ${want} lights with 3 lamps and a caption each, built ` +
          `${row.roots} lights, ${row.housings} housings, ${row.lamps} lamps, ` +
          `${row.labels} captions`
      );
      failed = true;
      continue;
    }
    // Live updates. A session starting and a preference changing both arrive
    // as events, and both have to rebuild the row — the reason the previous
    // release shipped a window that never resized was exactly this path.
    const extra = {
      session_id: "ccc333",
      status: "green",
      title: "docs",
      detail: "Task finished",
      cwd: "C:/work/docs",
      console: 0,
      pids: [],
    };
    built.length = 0;
    handlers.get("status-changed")({ payload: { ...SNAPSHOT, sessions: [...SNAPSHOT.sessions, extra] } });
    await settle();
    const grown = describeRow();
    if (grown.roots !== want + 1) {
      console.log(`a third session did not add a light: ${grown.roots} lights`);
      failed = true;
      continue;
    }

    handlers.get("prefs-changed")({ payload: { showTitles: false, _src: "check" } });
    await settle();
    if (document.body.dataset.titles !== "off") {
      console.log(`turning captions off did not reach the page (titles=${document.body.dataset.titles})`);
      failed = true;
      continue;
    }

    console.log(
      `ok (${registered.length} handlers, ${row.roots} light(s) with captions, ` +
        `grew to ${grown.roots} on a new session, captions toggled live)`
    );
    continue;
  }

  console.log(`ok (${registered.length} handlers)`);
}

// A returning run. Preferences are stored, so the light must leave its position
// alone: the user may have dragged it somewhere deliberately, and putting it
// back on every start is the behaviour that was deliberately ruled out.
if (!failed) {
  STORED.value = {
    along: 264,
    orientation: "vertical",
    showTitles: true,
    autoHide: true,
    clickFocus: true,
    defaultCorner: "top-right",
    defaultMargin: 40,
    defaultAlong: 264,
  };
  registered.length = 0;
  built.length = 0;
  process.stdout.write("main.js (returning run): ");
  try {
    await import(`${pathToFileURL(path.join(SRC, "main.js")).href}?t=${Date.now()}-again`);
    await settle();
    if (registered.includes("invoke:place_light")) {
      console.log("moved the light even though a position was already stored");
      failed = true;
    } else {
      console.log("ok (left the light where it was)");
    }
  } catch (error) {
    console.log(`threw while evaluating — ${error?.message ?? error}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nfrontend check failed");
  process.exit(1);
}
console.log("\nfrontend check passed");
