//! Shared status-file logic used by both the GUI app and the `claude-light-hook`
//! helper that Claude Code invokes from its hooks.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Sessions whose last heartbeat is older than this are ignored and pruned.
const STALE_AFTER_SECS: u64 = 12 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Claude finished and is idle.
    Green,
    /// Claude is working on the task.
    Yellow,
    /// Claude is blocked waiting for you (permission prompt / question).
    Red,
}

impl Status {
    pub fn parse(raw: &str) -> Option<Status> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "green" | "done" | "finished" | "idle" => Some(Status::Green),
            "yellow" | "amber" | "working" | "busy" => Some(Status::Yellow),
            "red" | "waiting" | "input" | "attention" => Some(Status::Red),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Green => "green",
            Status::Yellow => "yellow",
            Status::Red => "red",
        }
    }

    /// Higher wins when several sessions are active at once.
    fn rank(self) -> u8 {
        match self {
            Status::Green => 0,
            Status::Yellow => 1,
            Status::Red => 2,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub status: Status,
    pub session_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub detail: String,
    /// The console window this session is running in, so clicking its light can
    /// bring that terminal to the front. `0` when the hook could not find one.
    #[serde(default)]
    pub console: u64,
    /// The session's process and its ancestors, nearest first. A classic
    /// console window belongs to a `conhost.exe` *child* of the shell rather
    /// than to any of these, which is why `console` is tried first; this is the
    /// fallback for hosts that own their window themselves, such as Windows
    /// Terminal. Written by the hook, which is the only thing that runs inside
    /// the session and can see its process tree.
    #[serde(default)]
    pub pids: Vec<u32>,
    pub updated_at: u64,
}

impl SessionState {
    /// The label the light is captioned with: the working directory's folder
    /// name, which is how the user recognises which session is which. Falls
    /// back to a slice of the session id when there is no `cwd`.
    pub fn title(&self) -> String {
        match self
            .cwd
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty())
        {
            Some(name) => name.to_string(),
            None => self.session_id.chars().take(6).collect(),
        }
    }
}

/// One session as the UI sees it: its stored state plus the derived title, so
/// the caption has a single definition rather than one per window.
#[derive(Debug, Clone, Serialize)]
pub struct SessionView {
    #[serde(flatten)]
    pub state: SessionState,
    pub title: String,
}

impl From<SessionState> for SessionView {
    fn from(state: SessionState) -> Self {
        let title = state.title();
        SessionView { state, title }
    }
}

/// Aggregate of every live session, plus the winning status.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub status: Status,
    pub detail: String,
    pub sessions: Vec<SessionView>,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `%USERPROFILE%\.claude\ai-traffic-lights\sessions`
pub fn sessions_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("ai-traffic-lights").join("sessions")
}

fn sanitize(session_id: &str) -> String {
    let cleaned: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

/// Atomically write one session's status.
pub fn write_status(state: &SessionState) -> std::io::Result<()> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{}.json", sanitize(&state.session_id)));
    let tmp = dir.join(format!(".{}.tmp", sanitize(&state.session_id)));
    fs::write(&tmp, serde_json::to_vec(state)?)?;
    // On Windows `rename` replaces an existing file, so this stays atomic.
    fs::rename(&tmp, &target)
}

pub fn clear_status(session_id: &str) -> std::io::Result<()> {
    let target = sessions_dir().join(format!("{}.json", sanitize(session_id)));
    match fs::remove_file(target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Read every session file, dropping (and deleting) stale ones.
pub fn read_sessions() -> Vec<SessionState> {
    let dir = sessions_dir();
    let now = now_secs();
    let mut out = Vec::new();

    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else { continue };
        let Ok(state) = serde_json::from_str::<SessionState>(&raw) else { continue };

        if now.saturating_sub(state.updated_at) > STALE_AFTER_SECS {
            let _ = fs::remove_file(&path);
            continue;
        }
        out.push(state);
    }

    // Most recently touched first.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// Red beats yellow beats green: if any session needs you, the light is red.
pub fn snapshot() -> Snapshot {
    let states = read_sessions();
    let winner = states
        .iter()
        .max_by_key(|s| (s.status.rank(), s.updated_at))
        .cloned();

    // Stable order for the UI: one light per session, and they must not swap
    // places every time a heartbeat lands. Grouped by directory so lights from
    // the same project sit together.
    let mut sessions: Vec<SessionView> = states.into_iter().map(SessionView::from).collect();
    sessions.sort_by(|a, b| {
        a.state
            .cwd
            .cmp(&b.state.cwd)
            .then_with(|| a.state.session_id.cmp(&b.state.session_id))
    });

    match winner {
        Some(s) => Snapshot {
            status: s.status,
            detail: if s.detail.is_empty() {
                default_detail(s.status).to_string()
            } else {
                s.detail.clone()
            },
            sessions,
        },
        None => Snapshot {
            status: Status::Green,
            detail: "No active Claude session".to_string(),
            sessions,
        },
    }
}

pub fn default_detail(status: Status) -> &'static str {
    match status {
        Status::Green => "Task finished",
        Status::Yellow => "Claude is working",
        Status::Red => "Claude needs your response",
    }
}
