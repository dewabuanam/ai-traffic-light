#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

use tauri::menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

use tauri_plugin_window_state::StateFlags;

use ai_traffic_lights_core::{clear_status, read_sessions, snapshot, Snapshot, Status};

mod focus;

const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Wry's own default args plus the autoplay opt-out, so the status sounds can
/// play without the user first having clicked inside the window. Wry drops its
/// defaults as soon as this is set, hence repeating them here.
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Preferences live here rather than in each webview's `localStorage`, so the
/// light and the settings window cannot hold diverging copies and clobber each
/// other's changes. Both read from here and both are told when it changes.
struct Prefs {
    path: PathBuf,
    value: Mutex<Value>,
}

impl Prefs {
    fn load(app: &tauri::App) -> Self {
        let path = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("prefs.json");
        let value = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Default::default()));
        Prefs {
            path,
            value: Mutex::new(value),
        }
    }
}

/// Whatever was stored, defaults and all, is merged in by the frontend so the
/// defaults have a single definition.
#[tauri::command]
fn get_prefs(prefs: tauri::State<Prefs>) -> Value {
    match prefs.value.lock() {
        Ok(value) => value.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

#[tauri::command]
fn set_prefs(app: tauri::AppHandle, prefs: tauri::State<Prefs>, value: Value) -> Result<(), String> {
    let mut stored = value.clone();
    // `_src` only exists to let the sending window ignore its own echo.
    if let Some(object) = stored.as_object_mut() {
        object.remove("_src");
    }

    if let Some(dir) = prefs.path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    fs::write(&prefs.path, bytes).map_err(|e| e.to_string())?;

    if let Ok(mut slot) = prefs.value.lock() {
        *slot = stored;
    }
    app.emit("prefs-changed", value).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_status() -> Snapshot {
    snapshot()
}

/// Forget every tracked session, e.g. after a session died without firing
/// its `SessionEnd` hook and left the light stuck.
#[tauri::command]
fn reset_status() {
    for session in ai_traffic_lights_core::read_sessions() {
        let _ = clear_status(&session.session_id);
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Bring the terminal running a given session to the front. Clicking a light
/// is the whole point of the caption: you can see which session wants you, so
/// you should be able to get to it.
#[tauri::command]
fn focus_session(session_id: String) -> Result<(), String> {
    let session = read_sessions()
        .into_iter()
        .find(|s| s.session_id == session_id)
        .ok_or_else(|| format!("session {session_id} is no longer running"))?;

    focus::raise(session.console, &session.pids)
}

/// Show the settings window, building it the first time (and after the user
/// closes it, which destroys it).
#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("AI Traffic Lights — Settings")
        .inner_size(430.0, 620.0)
        .min_inner_size(380.0, 380.0)
        .resizable(true)
        .skip_taskbar(false)
        .center()
        .additional_browser_args(BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The light's right-click menu, kept alive for the life of the app so it can be
/// popped up on demand. It is a native menu rather than HTML because the light
/// window is far smaller than the menu, which the webview would clip.
struct LightMenu {
    menu: Menu<Wry>,
    on_top: CheckMenuItem<Wry>,
}

fn build_light_menu(app: &tauri::App) -> tauri::Result<LightMenu> {
    let on_top = CheckMenuItem::with_id(app, "ctx-top", "Always on top", true, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "ctx-settings", "Settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &on_top,
            &MenuItem::with_id(app, "ctx-rotate", "Rotate", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "ctx-small", "Small", true, None::<&str>)?,
            &MenuItem::with_id(app, "ctx-medium", "Medium", true, None::<&str>)?,
            &MenuItem::with_id(app, "ctx-large", "Large", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "ctx-reset", "Reset to green", true, None::<&str>)?,
            &MenuItem::with_id(app, "ctx-hide", "Hide to tray", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "ctx-quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    Ok(LightMenu { menu, on_top })
}

/// The frontend owns the preferences, so it tells us how to draw the checkmark
/// and we hand the chosen action straight back to it.
#[tauri::command]
fn show_context_menu(
    app: tauri::AppHandle,
    window: tauri::Window,
    always_on_top: bool,
) -> Result<(), String> {
    let state = app.state::<LightMenu>();
    state
        .on_top
        .set_checked(always_on_top)
        .map_err(|e| e.to_string())?;
    state.menu.popup(window).map_err(|e| e.to_string())
}

/// Show or hide the light on the user's say-so.
///
/// The window is done here rather than in the frontend so that "Show light"
/// still works if the webview is wedged — it is the only way back from a hidden
/// window. The frontend is told as well, because it is what decides visibility
/// from the session count and would otherwise undo this on the next status
/// change.
fn set_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("main") {
        if visible {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
    }
    let _ = app.emit_to("main", "visibility-forced", visible);
}

fn on_light_menu(app: &tauri::AppHandle, id: &str) {
    match id {
        "ctx-settings" => {
            let _ = open_settings(app.clone());
        }
        "ctx-reset" => reset_status(),
        "ctx-hide" => set_visible(app, false),
        "ctx-quit" => app.exit(0),
        // Everything else changes a preference, which lives in the frontend.
        other => {
            let _ = app.emit_to("main", "menu-action", other.trim_start_matches("ctx-"));
        }
    }
}

fn tooltip(snap: &Snapshot) -> String {
    let label = match snap.status {
        Status::Green => "Finished",
        Status::Yellow => "In progress",
        Status::Red => "Needs your response",
    };
    let mut out = format!("Claude: {label}\n{}", snap.detail);
    // The light shows one lamp column per session, so say when there is more
    // than one behind the winning status.
    if snap.sessions.len() > 1 {
        out.push_str(&format!("\n{} sessions", snap.sessions.len()));
    }
    out
}

/// Everything the light draws: the winning status, and every session's own lamp
/// and caption. Heartbeat timestamps are deliberately left out — they change on
/// every poll, and nothing on screen depends on them. `snapshot` returns the
/// sessions in a stable order, so this does not flap either.
type UiKey = (Status, String, Vec<(String, Status, String)>);

fn ui_key(snap: &Snapshot) -> UiKey {
    (
        snap.status,
        snap.detail.clone(),
        snap.sessions
            .iter()
            .map(|s| {
                (
                    s.state.session_id.clone(),
                    s.state.status,
                    s.state.detail.clone(),
                )
            })
            .collect(),
    )
}

fn main() {
    tauri::Builder::default()
        // Remember where the user parked the light. Size is deliberately left
        // out: it is a preference now, because the short side is derived from
        // the long one and a restored free-form size would break the ratio.
        // Visibility is left out too, so quitting while hidden in the tray does
        // not bring the app back invisible.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .with_denylist(&["settings"])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_status,
            reset_status,
            quit_app,
            open_settings,
            show_context_menu,
            get_prefs,
            set_prefs,
            focus_session
        ])
        .on_menu_event(|app, event| on_light_menu(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();

            app.manage(Prefs::load(app));
            app.manage(build_light_menu(app)?);

            let show = MenuItem::with_id(app, "show", "Show light", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide light", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &settings, &separator, &quit])?;

            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude traffic light")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => set_visible(app, true),
                    "hide" => set_visible(app, false),
                    "settings" => {
                        let _ = open_settings(app.clone());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Poll the session files and push changes to the UI + tray tooltip.
            std::thread::spawn(move || {
                let mut last: Option<UiKey> = None;
                loop {
                    let snap = snapshot();
                    let key = ui_key(&snap);
                    if last.as_ref() != Some(&key) {
                        let _ = tray.set_tooltip(Some(tooltip(&snap)));
                        let _ = handle.emit("status-changed", &snap);
                        last = Some(key);
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Traffic Lights");
}
