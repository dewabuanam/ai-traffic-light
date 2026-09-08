# AI Traffic Lights

An always-on-top, resizable traffic light for **Claude Code CLI** status.

| Light | Meaning |
| --- | --- |
| 🔴 Red | Claude needs your response (permission prompt or question) |
| 🟡 Yellow | Claude is working on the task |
| 🟢 Green | Task finished / idle |

**One window per session.** Run Claude Code in three projects and you get three
traffic lights, each its own little window that can be dragged and parked
wherever you like, each captioned with its project folder and showing that
session's own status. Click one to jump to the terminal it is running in. A
light appears when its session starts and goes away when the session ends, so
with nothing running there is nothing on screen — only the tray icon.

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

**Multiple sessions at once:** every session gets its own file, and every file
gets its own light window, captioned with the folder name from the session's
`cwd`. The tray icon summarises them all — any red makes it red, otherwise any
yellow makes it yellow, otherwise green — and its tooltip says how many sessions
are behind that. Sessions with no update for 12 hours are pruned.

Each light remembers where it was put, against its **project** rather than its
session: session ids are new every time Claude Code starts, so a position saved
against one would never be found again, while the directory is stable. Start
work in the same project tomorrow and its light comes back where you left it. A
project running several sessions at once gets a window each, numbered after the
first.

**Jumping to a session:** the hook is the only part of this that runs *inside*
the session, so it records how to find the terminal — the console window it
inherited, plus its ancestor process ids (the walk stops before the desktop, so
a click can never raise a File Explorer window). Clicking a light tries the
console window first, which is the real window in a classic console, and falls
back to the first ancestor process that owns a visible titled window, which is
how Windows Terminal and VS Code are found.

## Install

1. Run the installer from `target/release/bundle/`:
   - `AI Traffic Lights_1.5.0_x64-setup.exe` — NSIS, per-user, no admin
     required, installs to `%LOCALAPPDATA%\AI Traffic Lights\`
   - `AI Traffic Lights_1.5.0_x64_en-US.msi` — MSI, per-machine, needs admin
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

- **Move** — drag a light. Each is its own window, so they move independently,
  and each remembers where it was put. A press that travels more than a few
  pixels moves the window; one that stays put is a click.
- **Click a light** — brings the terminal that session is running in to the
  front. Turn it off with *Click a light to focus its terminal*.
- **Resize** — drag the trailing edge (the bottom when vertical, the right when
  horizontal), or hold <kbd>Ctrl</kbd> and scroll. Only that one edge resizes,
  and only the long side is dragged: the short side follows it, staying on the
  traffic-light proportion throughout the drag, so the casing always fits the
  lamps exactly with no background showing beside them. No other edge or corner
  resizes — dragging anywhere else on the light moves it.
- **Right-click** — settings, always-on-top toggle, rotate, move to default
  position, size presets, reset to green, hide to tray, quit.
- **Where a new light appears** — beside the lights already on screen, one step
  along the row from whichever has been there longest. Drag your lights into a
  corner or down the side of the screen and a new session joins them there
  rather than turning up somewhere else. The **default position** is used when
  there is nothing to sit beside — the first light of the day — and whenever you
  ask for it explicitly: *Move to default position* on that light's menu, *Move
  light there now* in the settings (which moves them all), or *Restore
  defaults*.
- **Tray icon** — show, hide, settings or quit. Hovering it shows the current
  status text and the session count.
- **Auto-hide** — a light exists only while its session does, so with nothing
  running there is nothing on screen. *Hide light* and *Show light* in the tray
  hide and show them all at once; a session starting while they are hidden stays
  hidden too. Turning *Hide when no session is running* off keeps a single
  dimmed placeholder on screen instead.

Everything persists between runs, in

```
%APPDATA%\com.quartexsoftware.ai-traffic-lights\prefs.json
%APPDATA%\com.quartexsoftware.ai-traffic-lights\lights.json   (light positions)
```

Delete those to go back to the defaults (or use **Restore defaults** in the
settings window, which also sends the lights back to their default position).

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
| Size | Long side of one light, 48–900 px; the short side follows automatically |
| Caption each light with its project | The folder name under each light's lamps |
| Default position | Which screen corner a light goes to when there is nothing to sit beside |
| Margin from the edges | 0–200 px in from the work area, so it clears the taskbar |
| Default size | The size the light goes back to, kept apart from the live Size |
| Always on top | Float above other windows |
| Hide when no session is running | Auto-hide, and reappear when a session starts |
| Click a light to focus its terminal | Raise the terminal the session is running in |

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

It also runs the light window twice over. Once as a window told it is showing
the *second* session of a two-session snapshot, which must paint that session
and not the first, follow its own session through a `status-changed`, ignore a
change to the other one, and pick up a `prefs-changed` turning captions off. And
once as a window whose position is already remembered, which must not move
itself. Those are the paths that are silent when they break: a light quietly
shows the wrong session, or jumps back to the corner every time you start work.

### Layout

```
crates/core/     shared status-file logic (read, write, aggregate)
crates/hook/     claude-light-hook.exe, invoked by Claude Code hooks
src-tauri/       the Tauri app (windows, tray, status watcher)
src/             frontend — no bundler, plain modules:
                   index.html/style.css/main.js   one light window
                   settings.html/.css/.js         the settings window
                   prefs.js                       prefs client + geometry
                   sound.js                       Web Audio status sounds
hooks/           hook installer + example settings snippet
scripts/         build-sidecar.js, stages the helper for bundling
```

`src-tauri/src/lights.rs` owns the windows: it opens one per live session,
closes the ones whose session has ended, and remembers where each was put.
`crates/hook/src/session_host.rs` works out which terminal a session is running
in; `src-tauri/src/focus.rs` is the other half, which finds and raises that
window when a light is clicked.

The helper is bundled as a Tauri **sidecar**, so it is installed next to the app
executable and lands in a predictable place for the hook configuration.

Preferences are owned by the Rust side (`get_prefs`/`set_prefs`) rather than by
either webview, so the light and the settings window cannot end up with
diverging copies; every write is echoed to both windows, which is what makes the
settings apply live.

The light's right-click menu is a native menu built in Rust. The window is
smaller than any useful menu, so an HTML one would be clipped by the webview.

A light is a window of its own so that it can be dragged and parked on its own:
one window holding a row of them could only ever be moved as a block. It costs a
webview per session, which is why each one is deliberately small — a single
light, reading the same preferences from the same place.

The app therefore has *no* window at all when nothing is running, which Tauri
would otherwise take as the end of the program. `RunEvent::ExitRequested` is
refused when it arrives without an exit code — the last light closing — and
honoured when it has one, which is what "Quit" sends.

Each window is sized from the size preference alone. `prefs.js` holds the layout
in multiples of one lamp diameter (`unitsFor`), so the window size and the lamp
size cannot drift apart — `sizeFor` goes one way for the window and `alongFrom`
comes back the other way when the grip is dragged. A caption always sits under
the lamps, which puts it on the long axis when the light is vertical and on the
short axis when it is horizontal.

The default position is a corner plus a margin rather than saved coordinates: a
remembered x/y is off-screen as soon as the display setup changes. It is applied
in Rust, because the corner has to be measured against the monitor's *work
area* — the screen minus the taskbar — which the webview cannot see. A light
placed bottom-right from JS would sit behind the taskbar. The frontend still
drives it, since where a bottom or right corner puts the window depends on how
big the window is, and only the frontend knows that.

A caption is held to the width of the lamps above it. Left to size itself a
light takes the width of its widest child, which is the caption: a long project
name pushed the light wider than its window, and what stuck out was clipped
instead of the caption ellipsising. The window size is also rounded up rather
than to nearest, since a window a fraction of a pixel short clips the light,
while a fraction over is transparent margin on a transparent window.

A light that has never been placed goes next to the ones already on screen —
one step along from the one that has been there longest, in the direction that
keeps the row on screen, skipping any spot that is taken. Only lights that have
actually been placed count as something to measure from: several windows load at
once at startup, and stepping away from one still sitting at its birth position
would scatter them. With nothing placed yet it falls back to the default corner,
where lights are stepped along by age so they do not stack up.

Positions live in `lights.json` beside the preferences, keyed by project and
written at most once every 800ms — `Moved` arrives for every pixel of a drag.
The first light of a project is keyed by the project alone, so the usual case of
one session per project keeps a stable name however many *other* sessions happen
to be running; only a project's second and later windows are numbered. Keying on
the *slot* instead looked fine until a second project was opened, at which point
the first project's light was numbered differently and lost its position.

This is also why the window-state plugin is gone: it keys on the window label,
which here lives and dies with a session.

Resizing is driven entirely from the frontend, and the window is declared
`resizable: false` so that the OS cannot resize it at all. A native resize moves
only the edge being pulled, which cannot work here: the short side is derived
from the long one, so both axes have to move together on every frame. While the
window was resizable, wry hit-tested its border itself — a borderless resizable
window gets that for free — and the press never reached the webview, so the OS
dragged one edge while our correction pulled the other back, and the window
flickered between the two sizes for the whole gesture.

The lights are not a `data-tauri-drag-region` either, for the same kind of
reason: that hands the press to the OS move loop, which swallows the click a
light needs in order to focus its terminal. Moving and clicking are told apart
by how far the pointer travels instead — and the light captures the pointer for
the whole press, because a light is a small window and a quick flick takes the
pointer outside it before the first move is delivered. Without the capture those
moves went nowhere and the light simply refused to be dragged.

Visibility is decided in the frontend, from the session count — but *Show light*
and *Hide to tray* move the window in Rust as well as telling the frontend, so
the tray can always bring the light back even if the webview is wedged. It is
the only way back from a hidden window.

## Troubleshooting

Check what the app thinks the status is:

```powershell
& "$env:LOCALAPPDATA\AI Traffic Lights\claude-light-hook.exe" status
```

It prints the winning light plus every live session, each with the caption its
light will carry. If it reports `No active Claude session`, the hooks are not
firing — confirm they are present in `~/.claude/settings.json` and that you
restarted Claude Code. Running `claude --debug` shows hook execution in the log.

**No lights at all.** With no session running that is the intended behaviour:
a light exists only while its session does. Turn *Hide when no session is
running* off to keep a placeholder on screen. If sessions *are* running and
there is still nothing, pick *Show light* from the tray — they may have been
hidden.

**A light came back somewhere unexpected.** Positions are remembered per
project, in `lights.json` next to `prefs.json`. Delete that file to start over,
or use *Move to default position* on the light's own menu.

**Clicking a light does not focus anything.** The hook records how to find the
terminal when it writes a status, so a session that has not fired a hook since
the app was installed has nothing recorded — the next status change fixes it.
Windows Terminal shares one window between its tabs, so the click raises the
window but cannot switch to the session's tab.

Set a light by hand to check the app is watching:

```powershell
& "$env:LOCALAPPDATA\AI Traffic Lights\claude-light-hook.exe" red
```
