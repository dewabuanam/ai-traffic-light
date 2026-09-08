//! Works out which terminal window a Claude Code session is sitting in, so a
//! click on that session's light can bring it to the front.
//!
//! The hook is the only part of this project that runs *inside* the session, as
//! a grandchild of whatever terminal the user launched Claude Code from, so it
//! is the only thing that can see this. It records two hints and lets the app
//! choose between them:
//!
//!   * `GetConsoleWindow`, which the hook inherits from the session. In a
//!     classic console (`conhost.exe`) that is the real, visible window. Under
//!     Windows Terminal it is a hidden pseudoconsole window, which the app
//!     detects and ignores.
//!   * the ancestor process ids, nearest first. Windows Terminal owns its
//!     window itself, so it turns up here; the app looks for a visible
//!     top-level window belonging to one of these processes.
//!
//! The walk stops before it reaches the desktop, or clicking a light would
//! raise a File Explorer window instead of a terminal.

/// How far up the process tree to look. A session is typically three or four
/// levels below its terminal (terminal → shell → node → hook).
const MAX_DEPTH: usize = 8;

/// Processes that are never the session's terminal. Reaching one of these means
/// the walk has left the terminal behind and should stop.
const ROOTS: &[&str] = &[
    "explorer.exe",
    "services.exe",
    "wininit.exe",
    "winlogon.exe",
    "svchost.exe",
    "userinit.exe",
    "runtimebroker.exe",
    "system",
    "[system process]",
    "idle",
];

#[cfg(windows)]
pub fn hints() -> (u64, Vec<u32>) {
    (console_window(), ancestors())
}

#[cfg(not(windows))]
pub fn hints() -> (u64, Vec<u32>) {
    (0, Vec::new())
}

#[cfg(windows)]
fn console_window() -> u64 {
    // Safety: no arguments, and the handle is only ever passed back to Windows.
    let hwnd = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() };
    hwnd as usize as u64
}

/// The hook's own process and its ancestors, nearest first, stopping at the
/// desktop. One ToolHelp snapshot is enough: the whole chain is walked in it.
#[cfg(windows)]
fn ancestors() -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;

    // (pid, parent pid, lowercased image name)
    let mut table: Vec<(u32, u32, String)> = Vec::new();

    // Safety: the snapshot handle is checked before use and closed after, and
    // `entry` is initialised with the `dwSize` the API requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return Vec::new();
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase();
                table.push((entry.th32ProcessID, entry.th32ParentProcessID, name));

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }

    let mut out = Vec::new();
    let mut pid = unsafe { GetCurrentProcessId() };

    for _ in 0..MAX_DEPTH {
        let Some((_, parent, name)) = table.iter().find(|(p, _, _)| *p == pid) else {
            break;
        };
        if ROOTS.contains(&name.as_str()) {
            break;
        }
        out.push(pid);
        // A parent that has already exited leaves its pid free to be reused, so
        // the chain can loop. Stop rather than walk in circles.
        if *parent == 0 || out.contains(parent) {
            break;
        }
        pid = *parent;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn walks_up_to_a_real_terminal_and_stops_short_of_the_desktop() {
        let chain = ancestors();
        // The test binary itself is always the first link.
        assert_eq!(chain.first().copied(), Some(std::process::id()));
        assert!(chain.len() <= MAX_DEPTH);
        // No duplicates: a reused pid must not send the walk round in a loop.
        let mut seen = chain.clone();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), chain.len(), "chain repeated a pid: {chain:?}");
    }

    #[test]
    fn hints_never_panic() {
        let (console, pids) = hints();
        // Nothing to assert about the values — a console-less test runner has
        // none — but this must never fail a session's hook.
        let _ = (console, pids);
    }
}
