// Builds the `claude-light-hook` helper and stages it as a Tauri sidecar,
// which requires the target triple in the filename.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((line) => line.startsWith("host:"))
  .slice("host:".length)
  .trim();

execFileSync("cargo", ["build", "--release", "--package", "claude-light-hook"], {
  cwd: root,
  stdio: "inherit",
});

const ext = process.platform === "win32" ? ".exe" : "";
const from = path.join(root, "target", "release", `claude-light-hook${ext}`);
const to = path.join(root, "src-tauri", "binaries", `claude-light-hook-${triple}${ext}`);

fs.mkdirSync(path.dirname(to), { recursive: true });
fs.copyFileSync(from, to);
console.log(`sidecar staged: ${path.relative(root, to)}`);
