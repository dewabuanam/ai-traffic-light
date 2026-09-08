# AI Traffic Lights

An always-on-top, resizable traffic light for **Claude Code CLI** status.

| Light | Meaning |
| --- | --- |
| 🔴 Red | Claude needs your response (permission prompt or question) |
| 🟡 Yellow | Claude is working on the task |
| 🟢 Green | Task finished / idle |

The window is frameless and transparent, floats above every other window, can be
dragged anywhere and resized, and lives in the system tray. Each colour has its
own sound, and the casing can be made translucent or hidden altogether.

## How it works

Claude Code fires [hooks](https://docs.claude.com/en/docs/claude-code/hooks) at
key points in a session. A tiny native helper, `claude-light-hook.exe`, is
registered on those hooks and writes the current status to

```
%USERPROFILE%\.claude\ai-traffic-lights\sessions\<session-id>.json
```

The Tauri app watches that folder and lights the matching lamp.

| Hook | Light |
| --- | --- |
| `SessionStart` | 🟢 green |
| `UserPromptSubmit` | 🟡 yellow |
| `PreToolUse` | 🟡 yellow |
| `Notification` | 🔴 red |
| `Stop` | 🟢 green |
| `SessionEnd` | clears the session |

**Multiple sessions at once:** every session gets its own file and the most
urgent one wins — any red makes the light red, otherwise any yellow makes it
yellow, otherwise green. Sessions with no update for 12 hours are pruned.

## Install

1. Run the installer from `target/release/bundle/`:
   - `AI Traffic Lights_1.1.2_x64-setup.exe` — NSIS, per-user, no admin
     required, installs to `%LOCALAPPDATA%\AI Traffic Lights\`
   - `AI Traffic Lights_1.1.2_x64_en-US.msi` — MSI, per-machine, needs admin
2. Register the Claude Code hooks:

   ```powershell
   node hooks/install-hooks.js
   ```

   This merges the hook entries into `~/.claude/settings.json` (backing the file
   up to `settings.json.bak` first) and points them at the installed
   `claude-light-hook.exe`. It is idempotent — re-run it any time.

   To point at a specific copy of the helper:

   ```powershell
   node hooks/install-hooks.js --exe "C:\path\to\claude-light-hook.exe"
   ```

   To remove the hooks again:

   ```powershell
   node hooks/install-hooks.js --uninstall
   ```

3. Restart any running Claude Code sessions so they pick up the new hooks.

`hooks/settings.hooks.example.json` shows the same configuration if you would
rather paste it in by hand.

## Using the light

- **Move** — drag the housing anywhere.
- **Resize** — drag the trailing edge (the bottom when vertical, the right when
  horizontal), or hold <kbd>Ctrl</kbd> and scroll. Only that one edge resizes,
  and only the long side is dragged: the short side follows it, staying on the
  traffic-light proportion throughout the drag, so the casing always fits the
  lamps exactly with no background showing beside them. No other edge or corner
  resizes — dragging anywhere else on the light moves it.
- **Right-click** — settings, always-on-top toggle, rotate, size presets, reset
  to green, hide to tray, quit.
- **Tray icon** — show, hide, settings or quit. Hovering it shows the current
  status text.

Everything persists between runs, in

```
%APPDATA%\com.quartexsoftware.ai-traffic-lights\prefs.json
```

Delete that file to go back to the defaults (or use **Restore defaults** in the
settings window).

## Sounds

Each colour plays its own sound when the light changes to it — nothing plays for
the status the app happens to start up in. The sounds are synthesised with the
Web Audio API, so the app ships no audio files.

| Light | Default sound |
| --- | --- |
| 🔴 Red | Alert — triple pulse |
| 🟡 Yellow | Blip |
| 🟢 Green | Chime — two-note rise |

Open **Settings…** (right-click the light, or the tray menu) to change them.
Every colour can be switched off on its own or given any of the nine voices —
chime, descend, bell, blip, beep, alert, siren, knock, pop — with a ▶ button to
preview each and a master volume.

## Settings

| Setting | What it does |
| --- | --- |
| Sound | Master on/off, volume, and a voice per colour |
| Casing | `Solid`, `Translucent` (the desktop shows through), or `None` — three floating lamps with no housing |
| Opacity | 20–100% for the whole light |
| Orientation | Vertical or horizontal |
| Size | Long side, 144–900 px; the short side follows automatically |
| Always on top | Float above other windows |

Changes apply live to the light as you make them.

"Reset to green" clears every tracked session — handy if a session was killed
without firing its `SessionEnd` hook and left the light stuck.

## Development

Requires Rust (MSVC toolchain), Node.js and the WebView2 runtime (preinstalled
on Windows 11).

```powershell
npm install
npm run dev      # hot-reloading dev window
npm run check    # load the frontend modules against a stub DOM
npm run build    # release build + NSIS and MSI bundles
```

The frontend is plain HTML/CSS/JS in `src/` — there is no bundler, so edits show
up on reload.

`npm run check` exists because a throw at module scope is invisible in the app:
the window still paints and the lamps still light from an already-issued
`get_status`, and only the code after the throw quietly goes missing. The check
loads each module against a stub DOM and stub `window.__TAURI__` and fails if
one throws or never reaches the handlers it must register.

### Layout

```
crates/core/     shared status-file logic (read, write, aggregate)
crates/hook/     claude-light-hook.exe, invoked by Claude Code hooks
src-tauri/       the Tauri app (windows, tray, status watcher)
src/             frontend — no bundler, plain modules:
                   index.html/style.css/main.js   the light
                   settings.html/.css/.js         the settings window
                   prefs.js                       prefs client + geometry
                   sound.js                       Web Audio status sounds
hooks/           hook installer + example settings snippet
scripts/         build-sidecar.js, stages the helper for bundling
```

The helper is bundled as a Tauri **sidecar**, so it is installed next to the app
executable and lands in a predictable place for the hook configuration.

Preferences are owned by the Rust side (`get_prefs`/`set_prefs`) rather than by
either webview, so the light and the settings window cannot end up with
diverging copies; every write is echoed to both windows, which is what makes the
settings apply live.

The light's right-click menu is a native menu built in Rust. The window is
smaller than any useful menu, so an HTML one would be clipped by the webview.

Resizing is driven entirely from the frontend, and the window is declared
`resizable: false` so that the OS cannot resize it at all. A native resize moves
only the edge being pulled, which cannot work here: the short side is derived
from the long one, so both axes have to move together on every frame. While the
window was resizable, wry hit-tested its border itself — a borderless resizable
window gets that for free — and the press never reached the webview, so the OS
dragged one edge while our correction pulled the other back, and the window
flickered between the two sizes for the whole gesture.

## Troubleshooting

Check what the app thinks the status is:

```powershell
& "$env:LOCALAPPDATA\AI Traffic Lights\claude-light-hook.exe" status
```

It prints the winning light plus every live session. If it reports
`No active Claude session`, the hooks are not firing — confirm they are present
in `~/.claude/settings.json` and that you restarted Claude Code. Running
`claude --debug` shows hook execution in the log.

Set a light by hand to check the app is watching:

```powershell
& "$env:LOCALAPPDATA\AI Traffic Lights\claude-light-hook.exe" red
```
