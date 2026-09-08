//! One window per Claude Code session.
//!
//! Every live session gets its own borderless always-on-top window holding a
//! single traffic light, so each one can be dragged and parked on its own. The
//! set is kept in step with the session files here: a session appearing opens a
//! window, a session ending closes it, and with nothing running there are no
//! light windows at all.
//!
//! Windows are keyed by *project*, not by session id. Session ids are new every
//! time Claude Code starts, so a position remembered against one would never be
//! found again; the project directory is stable, which is what makes "the light
//! for this project comes back where I left it" possible. Several sessions in
//! one project are told apart by a slot number.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::{
    AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

use ai_traffic_lights_core::snapshot;

use crate::BROWSER_ARGS;

/// Window labels all start with this, which is how a light is told apart from
/// the settings window.
pub const PREFIX: &str = "light-";

/// The one light shown when nothing is running and the user has turned
/// auto-hide off. It stands for no session at all, so it has no project.
const IDLE_KEY: &str = "idle";

/// The size a light window is born at. The frontend sizes itself properly as
/// soon as it has read the preferences; this only has to be close enough that
/// the window does not flash at some absurd size first.
const BIRTH_SIZE: (f64, f64) = (103.0, 292.0);

/// How often positions are written out. `Moved` arrives for every pixel of a
/// drag, so they are collected in memory and flushed on this beat instead.
pub const FLUSH_EVERY: Duration = Duration::from_millis(500);

/// The space left between two lights placed next to each other.
const NEXT_GAP: f64 = 12.0;

/// How far to keep looking for a free spot beside the existing lights before
/// giving up and using the default corner instead.
const MAX_STEPS: usize = 12;

/// One live light window.
struct Light {
    label: String,
    /// The project this light belongs to, and which of that project's lights it
    /// is. Together they name the remembered position — and only these two, so
    /// a project's single light keeps the same name however many *other*
    /// sessions happen to be running alongside it.
    project: String,
    index: usize,
    /// Which light this is among all of them, counting from zero. Used only to
    /// cascade fresh ones, so several starting at once do not land on top of
    /// each other.
    slot: usize,
}

/// The name a light's position is remembered under. The first light of a
/// project is just the project, so the common case — one session in a project —
/// is stable.
fn place_of(project: &str, index: usize) -> String {
    if index == 0 {
        project.to_string()
    } else {
        format!("{project}#{index}")
    }
}

/// The window label, which must be unique and may only hold characters Tauri
/// accepts in a label.
fn label_of(project: &str, index: usize) -> String {
    if index == 0 {
        format!("{PREFIX}{project}")
    } else {
        format!("{PREFIX}{project}-{index}")
    }
}

/// The live windows, and whether the user has hidden them.
pub struct Lights {
    by_session: Mutex<HashMap<String, Light>>,
    hidden: AtomicBool,
    places: Places,
    /// Windows that are where they are meant to be. A light only counts as
    /// something to sit beside once it has been placed — at startup several
    /// windows load at once, and stepping away from one still sitting at its
    /// birth position would scatter them.
    settled: Mutex<Vec<String>>,
}

/// Where each light was last left, by project and slot.
struct Places {
    path: PathBuf,
    value: Mutex<HashMap<String, (f64, f64)>>,
    /// Set when a position has changed and not yet been written. Throttling by
    /// the clock instead — writing only if the last write was long enough ago —
    /// *dropped* the positions in between: when three lights place themselves
    /// at startup they do it within a few milliseconds of each other, so only
    /// the first was ever saved and the rest were re-derived on the next run.
    dirty: AtomicBool,
}

impl Places {
    fn load(dir: Option<PathBuf>) -> Self {
        let path = dir.unwrap_or_else(|| PathBuf::from(".")).join("lights.json");
        let value = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<HashMap<String, (f64, f64)>>(&raw).ok())
            .unwrap_or_default();
        Places {
            path,
            value: Mutex::new(value),
            dirty: AtomicBool::new(false),
        }
    }

    fn get(&self, key: &str) -> Option<(f64, f64)> {
        self.value.lock().ok()?.get(key).copied()
    }

    fn set(&self, key: &str, pos: (f64, f64)) {
        let Ok(mut value) = self.value.lock() else {
            return;
        };
        if value.insert(key.to_string(), pos) != Some(pos) {
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    /// Write out anything that has changed. Called on a beat while the app
    /// runs, when a window goes away, and once more on the way out.
    fn flush(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let snapshot = {
            let Ok(value) = self.value.lock() else {
                return;
            };
            value.clone()
        };

        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        match serde_json::to_vec_pretty(&snapshot) {
            Ok(bytes) => {
                if fs::write(&self.path, bytes).is_err() {
                    // Try again on the next beat rather than losing it.
                    self.dirty.store(true, Ordering::Relaxed);
                }
            }
            Err(_) => self.dirty.store(true, Ordering::Relaxed),
        }
    }
}

impl Lights {
    pub fn load(app: &tauri::App) -> Self {
        Lights {
            by_session: Mutex::new(HashMap::new()),
            hidden: AtomicBool::new(false),
            places: Places::load(app.path().app_config_dir().ok()),
            settled: Mutex::new(Vec::new()),
        }
    }

    /// Where a fresh light should go, for the frontend to apply once it knows
    /// how big it is.
    pub fn slot_of(&self, label: &str) -> usize {
        self.by_session
            .lock()
            .ok()
            .and_then(|lights| {
                lights
                    .values()
                    .find(|light| light.label == label)
                    .map(|light| light.slot)
            })
            .unwrap_or(0)
    }
}

/// A window label and position key for a working directory: the folder name,
/// plus a hash of the whole path so two projects with the same folder name do
/// not share a position.
fn project_key(cwd: &str) -> String {
    let name: String = cwd
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("session")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .take(24)
        .collect();

    // Windows paths are case-insensitive and take either slash, so the same
    // directory can arrive spelled several ways. Normalise before hashing, or a
    // light would lose its remembered position to a stray trailing slash.
    let normal = cwd
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();

    // FNV-1a, so the same path always gives the same key between runs — which
    // is the whole point of keying positions by project.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normal.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }

    let name = if name.is_empty() { "session".into() } else { name };
    format!("{name}-{:08x}", (hash & 0xffff_ffff) as u32)
}

fn read_bool(prefs: &Value, key: &str, fallback: bool) -> bool {
    prefs.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

/// Open a window for every live session, close the ones whose session has gone.
///
/// Must run on the main thread: creating a window off it deadlocks the event
/// loop. `sync_soon` is the way in from the status poller.
pub fn sync(app: &AppHandle) {
    let snap = snapshot();
    let lights = app.state::<Lights>();
    let hidden = lights.hidden.load(Ordering::Relaxed);

    let auto_hide = {
        let prefs = app.state::<crate::Prefs>();
        let value = match prefs.value.lock() {
            Ok(value) => value.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        read_bool(&value, "autoHide", true)
    };

    // (session id, project key). The placeholder stands in for no session when
    // the user has asked to keep a light on screen regardless.
    let mut wanted: Vec<(String, String)> = snap
        .sessions
        .iter()
        .map(|s| (s.state.session_id.clone(), project_key(&s.state.cwd)))
        .collect();
    if wanted.is_empty() && !auto_hide {
        wanted.push((String::new(), IDLE_KEY.to_string()));
    }

    // Nothing left to hide: forget that the user hid the lights, so the next
    // session to start is not invisible.
    if wanted.is_empty() && hidden {
        lights.hidden.store(false, Ordering::Relaxed);
    }

    let mut closing = Vec::new();
    {
        let Ok(mut live) = lights.by_session.lock() else {
            return;
        };

        live.retain(|session, light| {
            if wanted.iter().any(|(id, _)| id == session) {
                return true;
            }
            closing.push(light.label.clone());
            false
        });

        // Both counters are handed out lowest-free-first, so a light closing
        // does not renumber the ones still on screen.
        let mut slots: Vec<usize> = live.values().map(|light| light.slot).collect();
        let mut opening = Vec::new();

        for (session, project) in &wanted {
            if live.contains_key(session) {
                continue;
            }
            let slot = (0..).find(|n| !slots.contains(n)).unwrap_or(0);
            slots.push(slot);

            // Several sessions in one project need one window each, so they are
            // numbered within the project. A project's first light is unnumbered
            // so that the usual case keeps a stable name.
            let index = (0..)
                .find(|n| {
                    !live
                        .values()
                        .any(|light| &light.project == project && light.index == *n)
                })
                .unwrap_or(0);

            let place = place_of(project, index);
            let label = label_of(project, index);
            live.insert(
                session.clone(),
                Light {
                    label: label.clone(),
                    project: project.clone(),
                    index,
                    slot,
                },
            );
            opening.push((session.clone(), label, place));
        }

        drop(live);

        for label in &closing {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.close();
            }
        }
        if let Ok(mut settled) = lights.settled.lock() {
            settled.retain(|label| !closing.contains(label));
        }
        if !closing.is_empty() {
            lights.places.flush();
        }

        for (session, label, place) in opening {
            open(app, &session, &label, &place, hidden);
        }
    }
}

fn open(app: &AppHandle, session: &str, label: &str, place: &str, hidden: bool) {
    let lights = app.state::<Lights>();
    let remembered = lights.places.get(place);

    // The frontend needs to know two things it cannot work out for itself:
    // which session it is showing, and whether this window has ever been
    // placed. A window with no remembered position puts itself in the default
    // corner once it knows its own size.
    let url = format!(
        "index.html?session={}&fresh={}&hidden={}",
        urlencode(session),
        u8::from(remembered.is_none()),
        u8::from(hidden),
    );

    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Claude Traffic Light")
        .inner_size(BIRTH_SIZE.0, BIRTH_SIZE.1)
        .min_inner_size(12.0, 12.0)
        // Resizing is driven from the frontend, which moves both axes together;
        // see the note in `main.js`.
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .additional_browser_args(BROWSER_ARGS);

    if let Some((x, y)) = remembered {
        builder = builder.position(x, y);
        // Already where it belongs, so the next light can measure from it.
        if let Ok(mut settled) = lights.settled.lock() {
            settled.push(label.to_string());
        }
    }

    let window = match builder.build() {
        Ok(window) => window,
        Err(err) => {
            eprintln!("could not open a light for session {session}: {err}");
            return;
        }
    };

    // Remember where the user drags it, against the project rather than the
    // session, so it comes back here next time.
    let handle = app.clone();
    let moved_label = label.to_string();
    let moved_place = place.to_string();
    window.on_window_event(move |event| {
        if let WindowEvent::Moved(position) = event {
            let Some(window) = handle.get_webview_window(&moved_label) else {
                return;
            };
            let Ok(scale) = window.scale_factor() else {
                return;
            };
            let logical = position.to_logical::<f64>(scale);
            handle
                .state::<Lights>()
                .places
                .set(&moved_place, (logical.x, logical.y));
        }
    });
}

/// Percent-encode the little that can appear in a session id but not in a URL
/// query. Session ids are uuids in practice, so this is belt and braces.
fn urlencode(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect()
}

/// Every light window, in slot order so callers can treat them as a row.
pub fn windows(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(PREFIX))
        .map(|(_, window)| window)
        .collect()
}

/// Show or hide every light, and remember which the user asked for so that a
/// session starting while they are hidden does not pop one up.
pub fn set_visible(app: &AppHandle, visible: bool) {
    app.state::<Lights>()
        .hidden
        .store(!visible, Ordering::Relaxed);

    for window in windows(app) {
        if visible {
            let _ = window.unminimize();
            let _ = window.show();
        } else {
            let _ = window.hide();
        }
    }
}

pub fn hidden(app: &AppHandle) -> bool {
    app.state::<Lights>().hidden.load(Ordering::Relaxed)
}

/// One light's rectangle, in logical pixels relative to the work area, with the
/// slot that says how long it has been there.
struct Spot {
    slot: usize,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Spot {
    fn overlaps(&self, x: f64, y: f64, w: f64, h: f64) -> bool {
        // A hair of tolerance, so two lights sitting exactly edge to edge are
        // not called an overlap.
        self.x < x + w - 1.0
            && x < self.x + self.w - 1.0
            && self.y < y + h - 1.0
            && y < self.y + self.h - 1.0
    }
}

/// Move a light to where it belongs.
///
/// With `beside`, a light that has never been placed joins the lights already
/// on screen — one step along from the one that has been there longest — so a
/// new session appears next to the row the user has arranged. Without it, and
/// when there is nothing to sit beside, it goes to the default corner.
///
/// The corner is worked out here rather than in the frontend because it has to
/// be measured against the monitor's *work area*, the screen minus the taskbar,
/// which the webview cannot see: a light placed bottom-right from JS would sit
/// behind the taskbar.
pub fn place(
    app: &AppHandle,
    label: &str,
    corner: &str,
    margin: f64,
    beside: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no window {label}"))?;

    // `current_monitor` is the one the light is on now; a window that has not
    // been shown yet has none, so fall back to the primary.
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or_else(|| "no monitor".to_string())?;

    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let screen = area.size.to_logical::<f64>(scale);
    let origin = area.position.to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);

    // Never let the margin push a light off a screen too small for it.
    let free_x = (screen.width - size.width).max(0.0);
    let free_y = (screen.height - size.height).max(0.0);

    let horizontal = orientation_is_horizontal(app);
    let neighbours = settled_spots(app, label, origin.x, origin.y, scale);

    let spot = if beside {
        beside_neighbours(&neighbours, size.width, size.height, free_x, free_y, horizontal)
    } else {
        None
    };

    let (x, y) = spot.unwrap_or_else(|| {
        corner_spot(
            corner,
            margin,
            free_x,
            free_y,
            size.width,
            size.height,
            horizontal,
            app.state::<Lights>().slot_of(label),
        )
    });

    window
        .set_position(LogicalPosition::new(origin.x + x, origin.y + y))
        .map_err(|e| e.to_string())?;

    if let Ok(mut settled) = app.state::<Lights>().settled.lock() {
        if !settled.iter().any(|other| other == label) {
            settled.push(label.to_string());
        }
    }
    Ok(())
}

fn orientation_is_horizontal(app: &AppHandle) -> bool {
    let prefs = app.state::<crate::Prefs>();
    let value = match prefs.value.lock() {
        Ok(value) => value.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    value.get("orientation").and_then(Value::as_str) == Some("horizontal")
}

/// Every other light that is already where it belongs, relative to the work
/// area so the numbers can be compared with a candidate position.
fn settled_spots(app: &AppHandle, label: &str, ox: f64, oy: f64, scale: f64) -> Vec<Spot> {
    let lights = app.state::<Lights>();
    let settled = match lights.settled.lock() {
        Ok(settled) => settled.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };

    let mut out = Vec::new();
    for window in windows(app) {
        let other = window.label().to_string();
        if other == label || !settled.contains(&other) {
            continue;
        }
        let Some(spot) = spot_of(&window, ox, oy, scale, lights.slot_of(&other)) else {
            continue;
        };
        out.push(spot);
    }
    out
}

fn spot_of(window: &WebviewWindow, ox: f64, oy: f64, scale: f64, slot: usize) -> Option<Spot> {
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.outer_size().ok()?.to_logical::<f64>(scale);
    Some(Spot {
        slot,
        x: position.x - ox,
        y: position.y - oy,
        w: size.width,
        h: size.height,
    })
}

/// One step along from the light that has been on screen longest, in the
/// direction that keeps the row on screen: lights tile sideways when they are
/// vertical and downwards when they are horizontal.
fn beside_neighbours(
    neighbours: &[Spot],
    w: f64,
    h: f64,
    free_x: f64,
    free_y: f64,
    horizontal: bool,
) -> Option<(f64, f64)> {
    let anchor = neighbours.iter().min_by_key(|spot| spot.slot)?;

    let step = if horizontal { h + NEXT_GAP } else { w + NEXT_GAP };
    // Step away from the nearer edge, so a light parked on the right builds its
    // row leftwards instead of walking off the screen.
    let towards_start = if horizontal {
        anchor.y > free_y / 2.0
    } else {
        anchor.x > free_x / 2.0
    };

    // The whole of one direction before trying the other: a row that grows one
    // way is predictable, whereas filling in on alternate sides puts a new
    // light behind the ones already there.
    for forwards in [!towards_start, towards_start] {
        for n in 1..=MAX_STEPS {
            let delta = step * n as f64 * if forwards { 1.0 } else { -1.0 };
            let (x, y) = if horizontal {
                (anchor.x, anchor.y + delta)
            } else {
                (anchor.x + delta, anchor.y)
            };
            if x < 0.0 || x > free_x || y < 0.0 || y > free_y {
                break;
            }
            if neighbours.iter().any(|spot| spot.overlaps(x, y, w, h)) {
                continue;
            }
            return Some((x, y));
        }
    }
    None
}

/// The default corner, with several lights stepped along it so they do not
/// stack up when there is nothing already placed to measure from.
#[allow(clippy::too_many_arguments)]
fn corner_spot(
    corner: &str,
    margin: f64,
    free_x: f64,
    free_y: f64,
    w: f64,
    h: f64,
    horizontal: bool,
    slot: usize,
) -> (f64, f64) {
    let inset_x = margin.clamp(0.0, free_x);
    let inset_y = margin.clamp(0.0, free_y);

    let (mut x, mut y) = match corner {
        "top-left" => (inset_x, inset_y),
        "bottom-left" => (inset_x, free_y - inset_y),
        "bottom-right" => (free_x - inset_x, free_y - inset_y),
        "centre" => (free_x / 2.0, free_y / 2.0),
        // Anything unrecognised lands top-right, which is the default.
        _ => (free_x - inset_x, inset_y),
    };

    if slot > 0 {
        let shift = slot as f64 * (NEXT_GAP + if horizontal { h } else { w });
        if horizontal {
            y = (y + shift).clamp(0.0, free_y);
        } else {
            x = if x > free_x / 2.0 { x - shift } else { x + shift };
            x = x.clamp(0.0, free_x);
        }
    }

    (x, y)
}

/// Write out any position still only held in memory. Moves are written at most
/// once every 800ms, so the last one of a burst can be sitting unsaved when the
/// app quits.
pub fn flush(app: &AppHandle) {
    app.state::<Lights>().places.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_key_is_the_folder_name_plus_a_hash_of_the_path() {
        let key = project_key(r"C:\work\ai-traffic-lights");
        assert!(key.starts_with("ai-traffic-lights-"), "{key}");
    }

    #[test]
    fn the_same_directory_always_gives_the_same_key() {
        let path = r"C:\Users\someone\Documents\project";
        assert_eq!(project_key(path), project_key(path));
    }

    #[test]
    fn same_folder_name_in_two_places_does_not_share_a_position() {
        let a = project_key(r"C:\one\api");
        let b = project_key(r"C:\two\api");
        assert!(a.starts_with("api-") && b.starts_with("api-"));
        assert_ne!(a, b, "two different projects would share a remembered spot");
    }

    #[test]
    fn slashes_both_ways_and_a_trailing_one_find_the_same_folder() {
        let expected = project_key(r"C:\work\thing");
        assert_eq!(project_key("C:/work/thing"), expected);
        assert_eq!(project_key(r"C:\work\thing\"), expected);
    }

    #[test]
    fn the_same_directory_in_a_different_case_is_the_same_project() {
        // Windows paths are case-insensitive, so these are one directory and
        // must share the position the user chose for it.
        assert_eq!(
            project_key(r"C:\Work\Thing"),
            project_key(r"c:\work\thing")
        );
    }

    #[test]
    fn a_session_with_no_directory_still_gets_a_usable_key() {
        let key = project_key("");
        assert!(key.starts_with("session-"), "{key}");
        // Must be safe in a window label, which allows only these characters.
        assert!(
            key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "{key}"
        );
    }

    #[test]
    fn a_label_never_contains_a_character_tauri_rejects() {
        for cwd in [
            r"C:\work\My Project (v2)",
            "/home/someone/über",
            r"D:\a\b\c#d",
        ] {
            let label = label_of(&project_key(cwd), 0);
            assert!(
                label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '/'),
                "{label}"
            );
        }
    }

    #[test]
    fn a_projects_only_light_keeps_the_same_name_whatever_else_is_running() {
        // The name must not depend on how many other sessions happen to be
        // open, or a light would lose the position the user chose for it as
        // soon as they started work somewhere else.
        let project = project_key(r"C:\workpi");
        assert_eq!(place_of(&project, 0), project);
        assert_eq!(label_of(&project, 0), format!("{PREFIX}{project}"));
    }

    #[test]
    fn several_sessions_in_one_project_get_a_window_each() {
        let project = project_key(r"C:\workpi");
        let names: Vec<String> = (0..3).map(|n| place_of(&project, n)).collect();
        let labels: Vec<String> = (0..3).map(|n| label_of(&project, n)).collect();
        for set in [&names, &labels] {
            let mut unique = set.clone();
            unique.sort();
            unique.dedup();
            assert_eq!(unique.len(), set.len(), "{set:?} collide");
        }
    }

    // A vertical light at the default size, on a 1920x1032 work area.
    const W: f64 = 103.0;
    const H: f64 = 292.0;
    const FREE_X: f64 = 1920.0 - W;
    const FREE_Y: f64 = 1032.0 - H;

    fn spot(slot: usize, x: f64, y: f64) -> Spot {
        Spot { slot, x, y, w: W, h: H }
    }

    #[test]
    fn a_new_light_joins_the_row_where_the_user_put_it() {
        // The user dragged their light to the middle of the screen. The new one
        // belongs next to it, not off in the default corner.
        let placed = vec![spot(0, 700.0, 400.0)];
        let next = beside_neighbours(&placed, W, H, FREE_X, FREE_Y, false).unwrap();
        assert_eq!(next, (700.0 + W + NEXT_GAP, 400.0));
    }

    #[test]
    fn a_third_light_goes_past_the_second_rather_than_on_top_of_it() {
        let placed = vec![spot(0, 700.0, 400.0), spot(1, 700.0 + W + NEXT_GAP, 400.0)];
        let next = beside_neighbours(&placed, W, H, FREE_X, FREE_Y, false).unwrap();
        assert_eq!(next, (700.0 + 2.0 * (W + NEXT_GAP), 400.0));
        assert!(
            !placed.iter().any(|s| s.overlaps(next.0, next.1, W, H)),
            "landed on an existing light"
        );
    }

    #[test]
    fn a_light_parked_on_the_right_builds_its_row_leftwards() {
        // Stepping right would walk off the screen, so the row grows inwards.
        let placed = vec![spot(0, FREE_X - 20.0, 40.0)];
        let next = beside_neighbours(&placed, W, H, FREE_X, FREE_Y, false).unwrap();
        assert!(next.0 < FREE_X - 20.0, "stepped the wrong way: {next:?}");
        assert!(next.0 >= 0.0);
    }

    #[test]
    fn horizontal_lights_stack_downwards_instead() {
        // Lamps run left to right, so the next light goes below, not beside.
        let placed = vec![Spot { slot: 0, x: 300.0, y: 200.0, w: H, h: W }];
        let next = beside_neighbours(&placed, H, W, FREE_Y, FREE_X, true).unwrap();
        assert_eq!(next, (300.0, 200.0 + W + NEXT_GAP));
    }

    #[test]
    fn with_nothing_placed_yet_there_is_nothing_to_sit_beside() {
        assert!(beside_neighbours(&[], W, H, FREE_X, FREE_Y, false).is_none());
    }

    #[test]
    fn the_row_is_measured_from_the_oldest_light_not_whichever_comes_first() {
        // Slot order is how long a light has been there; the newest one must
        // not become the anchor just because it is first in the list.
        let placed = vec![spot(3, 1200.0, 600.0), spot(0, 200.0, 100.0)];
        let next = beside_neighbours(&placed, W, H, FREE_X, FREE_Y, false).unwrap();
        assert_eq!(next.1, 100.0, "measured from the wrong light: {next:?}");
    }

    #[test]
    fn the_default_corner_respects_the_margin_and_the_work_area() {
        let (x, y) = corner_spot("top-right", 40.0, FREE_X, FREE_Y, W, H, false, 0);
        assert_eq!((x, y), (FREE_X - 40.0, 40.0));

        let (x, y) = corner_spot("bottom-left", 40.0, FREE_X, FREE_Y, W, H, false, 0);
        assert_eq!((x, y), (40.0, FREE_Y - 40.0));
    }

    #[test]
    fn lights_sent_to_the_same_corner_step_along_it() {
        let first = corner_spot("top-left", 40.0, FREE_X, FREE_Y, W, H, false, 0);
        let second = corner_spot("top-left", 40.0, FREE_X, FREE_Y, W, H, false, 1);
        assert_eq!(second.0 - first.0, W + NEXT_GAP);
        assert_eq!(second.1, first.1);
    }

    #[test]
    fn a_margin_larger_than_the_screen_cannot_push_a_light_off_it() {
        let (x, y) = corner_spot("bottom-right", 5000.0, FREE_X, FREE_Y, W, H, false, 0);
        assert!((0.0..=FREE_X).contains(&x), "x={x}");
        assert!((0.0..=FREE_Y).contains(&y), "y={y}");
    }

    #[test]
    fn a_session_id_is_safe_to_put_in_a_url() {
        assert_eq!(urlencode("3ad7594a-be44-4c1c"), "3ad7594a-be44-4c1c");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencode(""), "");
    }
}
