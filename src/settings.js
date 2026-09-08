import {
  CORNERS,
  MAX_ALONG,
  MAX_MARGIN,
  MIN_ALONG,
  clamp,
  defaults,
  loadPrefs,
  onPrefsChanged,
  savePrefs,
} from "./prefs.js";
import { VOICES, VOICE_IDS, bindUnlock, play } from "./sound.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const appWindow = getCurrentWindow();

const el = {
  soundEnabled: document.getElementById("sound-enabled"),
  volume: document.getElementById("volume"),
  volumeOut: document.getElementById("volume-out"),
  lampRows: [...document.querySelectorAll(".lamp-row")],
  housing: document.getElementById("housing"),
  opacity: document.getElementById("opacity"),
  opacityOut: document.getElementById("opacity-out"),
  orientation: document.getElementById("orientation"),
  along: document.getElementById("along"),
  alongOut: document.getElementById("along-out"),
  showTitles: document.getElementById("show-titles"),
  defaultCorner: document.getElementById("default-corner"),
  defaultMargin: document.getElementById("default-margin"),
  defaultMarginOut: document.getElementById("default-margin-out"),
  defaultAlong: document.getElementById("default-along"),
  defaultAlongOut: document.getElementById("default-along-out"),
  goHome: document.getElementById("go-home"),
  alwaysOnTop: document.getElementById("always-on-top"),
  autoHide: document.getElementById("auto-hide"),
  clickFocus: document.getElementById("click-focus"),
  restore: document.getElementById("restore"),
  close: document.getElementById("close"),
};

let prefs = await loadPrefs();

bindUnlock();

/* ---------------- build the voice pickers ---------------- */

for (const row of el.lampRows) {
  const select = row.querySelector('[data-field="voice"]');
  for (const id of VOICE_IDS) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = VOICES[id].label;
    select.append(option);
  }
}

for (const [value, label] of Object.entries(CORNERS)) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  el.defaultCorner.append(option);
}

el.along.min = String(MIN_ALONG);
el.along.max = String(MAX_ALONG);
el.defaultAlong.min = String(MIN_ALONG);
el.defaultAlong.max = String(MAX_ALONG);
el.defaultMargin.max = String(MAX_MARGIN);

/* ---------------- prefs -> form ---------------- */

function fill() {
  el.soundEnabled.checked = prefs.sound.enabled;
  el.volume.value = String(Math.round(prefs.sound.volume * 100));
  el.volumeOut.textContent = `${el.volume.value}%`;

  for (const row of el.lampRows) {
    const lamp = prefs.sound[row.dataset.status];
    const on = prefs.sound.enabled && lamp.enabled;
    row.querySelector('[data-field="enabled"]').checked = lamp.enabled;
    row.querySelector('[data-field="enabled"]').disabled = !prefs.sound.enabled;
    row.querySelector('[data-field="voice"]').value = lamp.voice;
    row.classList.toggle("off", !on);
  }

  el.housing.value = prefs.housing;
  el.opacity.value = String(Math.round(prefs.opacity * 100));
  el.opacityOut.textContent = `${el.opacity.value}%`;
  el.orientation.value = prefs.orientation;
  el.along.value = String(clamp(prefs.along, MIN_ALONG, MAX_ALONG));
  el.alongOut.textContent = `${el.along.value} px`;
  el.showTitles.checked = prefs.showTitles;
  el.defaultCorner.value = prefs.defaultCorner;
  el.defaultMargin.value = String(clamp(prefs.defaultMargin, 0, MAX_MARGIN));
  el.defaultMarginOut.textContent = `${el.defaultMargin.value} px`;
  el.defaultAlong.value = String(clamp(prefs.defaultAlong, MIN_ALONG, MAX_ALONG));
  el.defaultAlongOut.textContent = `${el.defaultAlong.value} px`;
  el.alwaysOnTop.checked = prefs.alwaysOnTop;
  el.autoHide.checked = prefs.autoHide;
  el.clickFocus.checked = prefs.clickFocus;
}

/* ---------------- form -> prefs ---------------- */

// Everything applies live, so there is no OK/Cancel to get wrong.
function commit() {
  savePrefs(prefs);
  fill();
}

el.soundEnabled.addEventListener("change", () => {
  prefs.sound.enabled = el.soundEnabled.checked;
  commit();
});

el.volume.addEventListener("input", () => {
  prefs.sound.volume = Number(el.volume.value) / 100;
  el.volumeOut.textContent = `${el.volume.value}%`;
  savePrefs(prefs);
});

for (const row of el.lampRows) {
  const status = row.dataset.status;

  row.querySelector('[data-field="enabled"]').addEventListener("change", (event) => {
    prefs.sound[status].enabled = event.target.checked;
    commit();
  });

  row.querySelector('[data-field="voice"]').addEventListener("change", (event) => {
    prefs.sound[status].voice = event.target.value;
    commit();
    play(event.target.value, prefs.sound.volume);
  });

  row.querySelector('[data-field="test"]').addEventListener("click", () => {
    play(prefs.sound[status].voice, prefs.sound.volume);
  });
}

el.housing.addEventListener("change", () => {
  prefs.housing = el.housing.value;
  commit();
});

el.opacity.addEventListener("input", () => {
  prefs.opacity = Number(el.opacity.value) / 100;
  el.opacityOut.textContent = `${el.opacity.value}%`;
  savePrefs(prefs);
});

el.orientation.addEventListener("change", () => {
  prefs.orientation = el.orientation.value;
  commit();
});

el.along.addEventListener("input", () => {
  prefs.along = Number(el.along.value);
  el.alongOut.textContent = `${el.along.value} px`;
  savePrefs(prefs);
});

el.showTitles.addEventListener("change", () => {
  prefs.showTitles = el.showTitles.checked;
  commit();
});

el.defaultCorner.addEventListener("change", () => {
  prefs.defaultCorner = el.defaultCorner.value;
  commit();
});

el.defaultMargin.addEventListener("input", () => {
  prefs.defaultMargin = Number(el.defaultMargin.value);
  el.defaultMarginOut.textContent = `${el.defaultMargin.value} px`;
  savePrefs(prefs);
});

el.defaultAlong.addEventListener("input", () => {
  prefs.defaultAlong = Number(el.defaultAlong.value);
  el.defaultAlongOut.textContent = `${el.defaultAlong.value} px`;
  savePrefs(prefs);
});

// The light moves itself: where a bottom or right corner puts the window
// depends on how big it is, and the light is what owns its size.
el.goHome.addEventListener("click", () => {
  invoke("send_light_home").catch((err) => console.error("send_light_home failed", err));
});

el.alwaysOnTop.addEventListener("change", () => {
  prefs.alwaysOnTop = el.alwaysOnTop.checked;
  commit();
});

el.autoHide.addEventListener("change", () => {
  prefs.autoHide = el.autoHide.checked;
  commit();
});

el.clickFocus.addEventListener("change", () => {
  prefs.clickFocus = el.clickFocus.checked;
  commit();
});

el.restore.addEventListener("click", () => {
  prefs = defaults();
  commit();
  // Defaults include where the light belongs, so put it there.
  invoke("send_light_home").catch((err) => console.error("send_light_home failed", err));
});

el.close.addEventListener("click", () => appWindow.close());

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") appWindow.close();
});

/* ---------------- stay in step with the light window ---------------- */

onPrefsChanged((next) => {
  prefs = next;
  fill();
});

fill();
