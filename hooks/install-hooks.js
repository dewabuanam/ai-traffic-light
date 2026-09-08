#!/usr/bin/env node
/**
 * Registers (or removes) the AI Traffic Lights hooks in ~/.claude/settings.json.
 *
 *   node hooks/install-hooks.js [--exe <path to claude-light-hook.exe>]
 *   node hooks/install-hooks.js --uninstall
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const MARKER = "claude-light-hook";
const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const explicitExe = args[args.indexOf("--exe") + 1];

const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

function findExe() {
  if (explicitExe && args.includes("--exe")) return path.resolve(explicitExe);

  const exe = process.platform === "win32" ? "claude-light-hook.exe" : "claude-light-hook";
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "AI Traffic Lights", exe),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "AI Traffic Lights", exe),
    path.resolve(__dirname, "..", "target", "release", exe),
    path.resolve(__dirname, "..", "target", "debug", exe),
  ].filter(Boolean);

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error("Could not find claude-light-hook. Looked in:\n  " + candidates.join("\n  "));
    console.error("\nPass it explicitly:  node hooks/install-hooks.js --exe <path>");
    process.exit(1);
  }
  return found;
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.error(`Could not parse ${settingsPath}: ${err.message}`);
    process.exit(1);
  }
}

/** Strip any previously installed entries so re-running is idempotent. */
function purge(settings) {
  const hooks = settings.hooks ?? {};
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers
      .map((m) => ({
        ...m,
        hooks: (m.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARKER)),
      }))
      .filter((m) => m.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  settings.hooks = hooks;
  return settings;
}

function add(settings, event, matcher, command) {
  const entry = { hooks: [{ type: "command", command, timeout: 5 }] };
  if (matcher) entry.matcher = matcher;
  settings.hooks[event] = [...(settings.hooks[event] ?? []), entry];
}

const settings = purge(readSettings());

if (!uninstall) {
  const exe = findExe();
  const run = (state) => `"${exe}" ${state}`;

  // green  = idle / finished, yellow = working, red = waiting on you
  add(settings, "SessionStart", null, run("green"));
  add(settings, "UserPromptSubmit", null, run("yellow"));
  add(settings, "PreToolUse", "*", run("yellow"));
  add(settings, "Notification", null, run("red"));
  add(settings, "Stop", null, run("green"));
  add(settings, "SessionEnd", null, run("clear"));

  console.log(`Using helper: ${exe}`);
}

if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

console.log(`${uninstall ? "Removed" : "Installed"} traffic-light hooks in ${settingsPath}`);
console.log("Restart any running Claude Code sessions to pick up the change.");
