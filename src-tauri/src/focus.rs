//! Bringing the terminal a session is running in to the front, so clicking a
//! light takes you to the Claude Code that lit it.
//!
//! The hook records two hints per session (see `session_host.rs` in the hook
//! crate) and this picks between them:
//!
//!   * `console` — what `GetConsoleWindow` reported inside the session. In a
//!     classic console that is the visible window and the job is done. Windows
//!     Terminal hands out a hidden pseudoconsole window instead, which is why
//!     the handle is checked for visibility rather than trusted.
//!   * `pids` — the session's process and its ancestors, nearest first. The
//!     first one that owns a visible, titled top-level window wins, which is
//!     how hosts that own their own window (Windows Terminal, VS Code) are
//!     found.
//!
//! `SetForegroundWindow` only obeys a process that already holds the
//! foreground, which is exactly the case here: the user just clicked our
//! window, so we have it.

/// Raise the window a session belongs to. `Err` carries something worth
/// logging, not something worth showing the user.
#[cfg(windows)]
pub fn raise(console: u64, pids: &[u32]) -> Result<(), String> {
    let console_hwnd = console as usize as HWND;
    if usable(console_hwnd) && show(console_hwnd) {
        return Ok(());
    }

    for &pid in pids {
        if let Some(hwnd) = window_of(pid) {
            if show(hwnd) {
                return Ok(());
            }
        }
    }

    Err(format!(
        "no window found for this session (console {console:#x}, pids {pids:?})"
    ))
}

#[cfg(not(windows))]
pub fn raise(_console: u64, _pids: &[u32]) -> Result<(), String> {
    Err("focusing a session's terminal is only implemented on Windows".to_string())
}

#[cfg(windows)]
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, SetForegroundWindow, ShowWindow, GA_ROOT, SW_RESTORE,
};

/// A window worth switching to: one that exists, is on screen, and has a title.
/// The untitled ones belong to message-only and helper windows, and a
/// pseudoconsole is invisible, which is what rules it out.
#[cfg(windows)]
fn usable(hwnd: HWND) -> bool {
    if hwnd.is_null() {
        return false;
    }
    // Safety: every call takes only the handle, and a stale handle is exactly
    // what `IsWindow` is for.
    unsafe {
        IsWindow(hwnd) != 0 && IsWindowVisible(hwnd) != 0 && GetWindowTextLengthW(hwnd) > 0
    }
}

/// Un-minimise if needed, then take the foreground.
#[cfg(windows)]
fn show(hwnd: HWND) -> bool {
    // Safety: `hwnd` has just been checked by `usable`, or came from
    // `EnumWindows` in this same call.
    unsafe {
        // A tab in a terminal is a child of the frame; the frame is what the
        // user wants raised.
        let root = GetAncestor(hwnd, GA_ROOT);
        let target = if root.is_null() { hwnd } else { root };

        if IsIconic(target) != 0 {
            ShowWindow(target, SW_RESTORE);
        }
        SetForegroundWindow(target) != 0
    }
}

#[cfg(windows)]
struct Hunt {
    pid: u32,
    found: HWND,
}

#[cfg(windows)]
unsafe extern "system" fn consider(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // Safety: `lparam` is the `&mut Hunt` handed to `EnumWindows` below, which
    // outlives the enumeration.
    let hunt = unsafe { &mut *(lparam as *mut Hunt) };

    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid != hunt.pid || !usable(hwnd) {
        return 1; // keep looking
    }

    hunt.found = hwnd;
    0 // stop
}

#[cfg(windows)]
fn window_of(pid: u32) -> Option<HWND> {
    let mut hunt = Hunt {
        pid,
        found: std::ptr::null_mut(),
    };
    // Safety: `consider` matches `WNDENUMPROC`, and `hunt` is borrowed for the
    // duration of the (synchronous) enumeration.
    unsafe { EnumWindows(Some(consider), &mut hunt as *mut Hunt as LPARAM) };

    if hunt.found.is_null() {
        None
    } else {
        Some(hunt.found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn a_pid_that_owns_no_window_is_not_found() {
        // Pid 0 is the idle process and never owns a window.
        assert!(window_of(0).is_none());
    }

    #[test]
    #[cfg(windows)]
    fn a_null_or_stale_handle_is_never_usable() {
        assert!(!usable(std::ptr::null_mut()));
        // A handle this far out of range has never been a window.
        assert!(!usable(0x7fff_0000_usize as HWND));
    }

    #[test]
    #[cfg(windows)]
    fn raise_reports_when_a_session_has_no_window_to_show() {
        let err = raise(0, &[]).unwrap_err();
        assert!(err.contains("no window found"), "{err}");
    }
}
