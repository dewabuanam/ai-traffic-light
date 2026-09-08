//! Tiny helper invoked from Claude Code hooks:
//!
//!   claude-light-hook red|yellow|green
//!   claude-light-hook clear
//!   claude-light-hook status   (prints what the light currently shows)
//!
//! Claude Code pipes the hook payload as JSON on stdin, so we pick up
//! `session_id`, `cwd` and the human-readable `message` from there when present.

use std::io::{IsTerminal, Read};

use ai_traffic_lights_core::{clear_status, now_secs, snapshot, write_status, SessionState, Status};

mod session_host;

fn read_payload() -> serde_json::Value {
    // Only read stdin when something is actually piped in, otherwise a manual
    // run from a terminal would block forever.
    if std::io::stdin().is_terminal() {
        return serde_json::Value::Null;
    }
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() {
        return serde_json::Value::Null;
    }
    serde_json::from_str(&buf).unwrap_or(serde_json::Value::Null)
}

fn field<'a>(payload: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();

    if arg.eq_ignore_ascii_case("status") {
        let snap = snapshot();
        println!("light: {}  ({})", snap.status.as_str(), snap.detail);
        for s in &snap.sessions {
            println!(
                "  {} {} [{}] {}",
                s.state.status.as_str(),
                s.title,
                s.state.session_id,
                s.state.cwd
            );
        }
        return;
    }

    let payload = read_payload();

    let session_id = field(&payload, "session_id")
        .map(str::to_string)
        .or_else(|| std::env::var("CLAUDE_SESSION_ID").ok())
        .unwrap_or_else(|| "default".to_string());

    if arg.eq_ignore_ascii_case("clear") {
        let _ = clear_status(&session_id);
        return;
    }

    let Some(status) = Status::parse(&arg) else {
        eprintln!("usage: claude-light-hook <red|yellow|green|clear>");
        std::process::exit(2);
    };

    // `message` is set on Notification, `tool_name` on PreToolUse.
    let detail = field(&payload, "message")
        .map(str::to_string)
        .or_else(|| field(&payload, "tool_name").map(|t| format!("Running {t}")))
        .or_else(|| std::env::args().nth(2))
        .unwrap_or_default();

    let (console, pids) = session_host::hints();

    let state = SessionState {
        status,
        session_id,
        cwd: field(&payload, "cwd").unwrap_or_default().to_string(),
        detail,
        console,
        pids,
        updated_at: now_secs(),
    };

    // A hook must never break the session, so failures stay silent-ish.
    if let Err(e) = write_status(&state) {
        eprintln!("claude-light-hook: {e}");
    }
}
