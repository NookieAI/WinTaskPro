// ─────────────────────────────────────────────────────────────────────────────
// WinTaskPro — Dev-Level Logger (devlog)
// ─────────────────────────────────────────────────────────────────────────────
//
// Goal: every meaningful action the app takes (IPC call, COM call, file IO,
//       errors) writes a timestamped, levelled, function-tagged line to a
//       persistent log file the user can open from Settings.
//
// Format:  [2026-04-19T15:23:01.456Z] [INFO ] [scheduler::create_task] msg
//
// File:    Resolved at startup via this fallback chain:
//            1. %LOCALAPPDATA%\WinTaskPro\logs\wintaskpro.log
//            2. <exe-directory>\logs\wintaskpro.log     (portable next-to-exe)
//            3. %TEMP%\WinTaskPro\logs\wintaskpro.log   (last resort)
//          The chosen path is announced in the log itself as the first line of
//          every session: "── session start | log_path=... ──"
//          Rotated when > 5 MB → wintaskpro.log.1, oldest dropped.
//
// Levels:  TRACE < DEBUG < INFO < WARN < ERROR
//          Default: INFO. Set higher verbosity via Settings toggle (writes the
//          envvar WINTASKPRO_LOG_LEVEL=DEBUG to the .level file in logs dir).
//
// Macros:  log_trace!, log_debug!, log_info!, log_warn!, log_error!
//          All accept format-string syntax: log_info!("scheduler::run_task",
//          "started: {}", path);
//
// Design rationale:
//   - No external log crate (env_logger/tracing) — keeps binary smaller,
//     avoids dependency churn, and gives us total control over the format
//     and rotation.
//   - File mutex serialises writes so concurrent IPC handlers can't
//     interleave bytes mid-line.
//   - Lazy init via OnceLock — no log file is touched if logging never fires
//     (e.g. headless --version invocation).
//   - Log level is read once at startup AND re-read on each line if the
//     `.level` marker file's mtime changed; the Settings toggle writes that
//     file, so changes apply within ~1 line of write without a restart.
//
// ─────────────────────────────────────────────────────────────────────────────

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

// ── Log levels ───────────────────────────────────────────────────────────────
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Trace = 0,
    Debug = 1,
    Info  = 2,
    Warn  = 3,
    Error = 4,
}

impl Level {
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_ascii_uppercase().as_str() {
            "TRACE" => Level::Trace,
            "DEBUG" => Level::Debug,
            "INFO"  => Level::Info,
            "WARN"  => Level::Warn,
            "ERROR" => Level::Error,
            _       => Level::Info,
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info  => "INFO ",
            Level::Warn  => "WARN ",
            Level::Error => "ERROR",
        }
    }
}

// ── Internal state ───────────────────────────────────────────────────────────
struct LogState {
    file:           Mutex<Option<File>>,
    path:           PathBuf,
    level_path:     PathBuf,
    /// (last seen mtime as nanos, level)
    cached_level:   Mutex<(u128, Level)>,
}

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;  // 5 MB rotation threshold

static STATE: OnceLock<Option<LogState>> = OnceLock::new();

// Determine the logs directory using a layered fallback so portable users
// always get a usable log file regardless of how they launched the exe.
//
// Order:
//   1. %LOCALAPPDATA%\WinTaskPro\logs\          (per-user, survives reinstalls)
//   2. <exe-directory>\logs\                    (portable next-to-the-exe)
//   3. %TEMP%\WinTaskPro\logs\                  (last resort — always writable)
//
// First successful create wins. The chosen path is announced via stderr at
// init time so a developer running with a console attached can see it; the
// path is also returned by the get_log_file_path IPC for the in-app
// "Settings → Developer Logs → Log File Path" display.
fn resolve_logs_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. %LOCALAPPDATA%\WinTaskPro\logs
    if let Some(local_app) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app).join("WinTaskPro").join("logs"));
    }

    // 2. <exe_dir>\logs — important for portable runs, especially when the
    //    user expects logs next to the .exe like other portable apps do.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("logs"));
        }
    }

    // 3. %TEMP%\WinTaskPro\logs — always writable, but volatile
    candidates.push(std::env::temp_dir().join("WinTaskPro").join("logs"));

    for dir in candidates {
        if fs::create_dir_all(&dir).is_ok() {
            // Verify we can actually WRITE to it — create_dir_all can succeed
            // for a dir that exists but is read-only (e.g. a USB drive in
            // write-protect mode). A throwaway probe file confirms write access.
            let probe = dir.join(".write_probe");
            match OpenOptions::new().create(true).write(true).truncate(true).open(&probe) {
                Ok(_) => {
                    let _ = fs::remove_file(&probe);
                    eprintln!("[wintaskpro::devlog] logs → {}", dir.display());
                    return Some(dir);
                }
                Err(e) => {
                    eprintln!("[wintaskpro::devlog] {} not writable: {}", dir.display(), e);
                }
            }
        }
    }
    None
}

fn state() -> Option<&'static LogState> {
    STATE.get_or_init(|| {
        let logs_dir = match resolve_logs_dir() {
            Some(d) => d,
            None => {
                eprintln!("[wintaskpro::devlog] no writable logs directory found — logging disabled");
                return None;
            }
        };

        let path       = logs_dir.join("wintaskpro.log");
        let level_path = logs_dir.join(".level");

        // Read initial level from envvar OR .level file. Envvar wins so a
        // developer launching from terminal can override without touching files.
        let initial_level = std::env::var("WINTASKPRO_LOG_LEVEL")
            .ok()
            .or_else(|| fs::read_to_string(&level_path).ok())
            .map(|s| Level::from_str(&s))
            .unwrap_or(Level::Info);

        // Open append-mode handle (created if missing)
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();

        // Stamp the file with a clear "session start" line so users grep'ing
        // the log can find where each launch begins.
        if let Some(mut f) = file.as_ref().and_then(|f| f.try_clone().ok()) {
            let stamp = format!(
                "\n[{}] [INFO ] [devlog] ── session start | log_path={} ──\n",
                now_iso8601(),
                path.display()
            );
            let _ = f.write_all(stamp.as_bytes());
            let _ = f.flush();
        }

        let now_nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);

        Some(LogState {
            file:         Mutex::new(file),
            path,
            level_path,
            cached_level: Mutex::new((now_nanos, initial_level)),
        })
    }).as_ref()
}

// ── Level resolution (cheap re-check) ────────────────────────────────────────
fn current_level(s: &LogState) -> Level {
    // Check .level file mtime; if it changed, re-read.
    let new_mtime = fs::metadata(&s.level_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut cache = s.cached_level.lock().expect("level cache poisoned");
    if new_mtime != cache.0 && new_mtime > 0 {
        if let Ok(s2) = fs::read_to_string(&s.level_path) {
            cache.1 = Level::from_str(&s2);
        }
        cache.0 = new_mtime;
    }
    cache.1
}

// ── Timestamp ────────────────────────────────────────────────────────────────
fn now_iso8601() -> String {
    // Format: 2026-04-19T15:23:01.456Z (UTC)
    // We avoid the chrono crate; manual computation keeps deps minimal.
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs   = now.as_secs() as i64;
    let millis = now.subsec_millis();

    // Days since epoch and seconds within day
    let days  = secs.div_euclid(86_400);
    let sod   = secs.rem_euclid(86_400);
    let h     = sod / 3600;
    let m     = (sod % 3600) / 60;
    let s     = sod % 60;

    // Convert days to Y/M/D using a known algorithm (Howard Hinnant's civil_from_days)
    let (y, mo, d) = civil_from_days(days);

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, mo, d, h, m, s, millis)
}

/// Converts days since Unix epoch (1970-01-01) to (year, month, day).
/// Algorithm by Howard Hinnant, valid for proleptic Gregorian calendar.
fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;                              // [0, 146096]
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;        // [0, 399]
    let y   = yoe as i64 + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);                      // [0, 365]
    let mp  = (5*doy + 2) / 153;                                      // [0, 11]
    let d   = (doy - (153*mp + 2)/5 + 1) as u32;                      // [1, 31]
    let m   = if mp < 10 { mp + 3 } else { mp - 9 } as u32;           // [1, 12]
    let y   = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

// ── Rotation ─────────────────────────────────────────────────────────────────
fn maybe_rotate(s: &LogState, file_guard: &mut Option<File>) {
    let len = file_guard.as_ref()
        .and_then(|f| f.metadata().ok())
        .map(|m| m.len())
        .unwrap_or(0);
    if len < MAX_LOG_BYTES { return; }

    // Drop the file handle before renaming on Windows (else rename fails)
    *file_guard = None;
    let rotated = s.path.with_file_name("wintaskpro.log.1");
    let _ = fs::remove_file(&rotated);
    let _ = fs::rename(&s.path, &rotated);

    // Re-open fresh
    *file_guard = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&s.path)
        .ok();
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Internal: write a single log line. Public so the macros can call it; users
/// should prefer the macros below.
pub fn log_line(level: Level, target: &str, msg: &str) {
    let Some(s) = state() else { return; };
    if level < current_level(s) { return; }

    let line = format!(
        "[{}] [{}] [{}] {}\n",
        now_iso8601(),
        level.label(),
        target,
        msg.replace('\n', " ¶ "),  // keep one line per event; preserve newlines as ¶
    );

    let mut guard = match s.file.lock() {
        Ok(g)  => g,
        Err(_) => return,
    };
    maybe_rotate(s, &mut guard);
    if let Some(f) = guard.as_mut() {
        let _ = f.write_all(line.as_bytes());
        // Flush on EVERY line. Volume is low (a few hundred lines per session
        // peak), and the previous "WARN+ only" policy meant a crash mid-session
        // could lose the last few INFO lines including the boot snapshot —
        // exactly the diagnostics most useful for bug reports.
        let _ = f.flush();
    }
}

/// Returns the absolute path to the logs directory, creating it if needed.
/// Used by the "Open Logs Folder" button.
pub fn logs_dir() -> Option<PathBuf> {
    state().map(|s| s.path.parent().unwrap_or(&s.path).to_path_buf())
}

/// Returns the absolute path to the active log file.
pub fn log_file_path() -> Option<PathBuf> {
    state().map(|s| s.path.clone())
}

/// Set the active log level and persist it to the .level file so the next
/// launch starts with the same verbosity. Called from the IPC `set_log_level`.
pub fn set_level(level: Level) -> Result<(), String> {
    let s = state().ok_or_else(|| "log state not initialised".to_string())?;
    fs::write(&s.level_path, level.label().trim()).map_err(|e| e.to_string())?;
    let now_nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    *s.cached_level.lock().expect("level cache poisoned") = (now_nanos, level);
    log_line(Level::Info, "log::set_level", &format!("level changed to {}", level.label().trim()));
    Ok(())
}

/// Returns the currently active log level.
pub fn get_level() -> Level {
    state().map(current_level).unwrap_or(Level::Info)
}

/// Read the most recent N lines of the log file (newest first), used by the
/// in-app "Recent Logs" viewer.
pub fn read_tail(n: usize) -> Vec<String> {
    let Some(s) = state() else { return Vec::new(); };
    let Ok(text) = fs::read_to_string(&s.path) else { return Vec::new(); };
    text.lines().rev().take(n).map(|l| l.to_string()).collect()
}

// ── Macros ───────────────────────────────────────────────────────────────────

#[macro_export]
macro_rules! log_trace { ($t:expr, $($arg:tt)*) => { $crate::devlog::log_line($crate::devlog::Level::Trace, $t, &format!($($arg)*)) }; }
#[macro_export]
macro_rules! log_debug { ($t:expr, $($arg:tt)*) => { $crate::devlog::log_line($crate::devlog::Level::Debug, $t, &format!($($arg)*)) }; }
#[macro_export]
macro_rules! log_info  { ($t:expr, $($arg:tt)*) => { $crate::devlog::log_line($crate::devlog::Level::Info,  $t, &format!($($arg)*)) }; }
#[macro_export]
macro_rules! log_warn  { ($t:expr, $($arg:tt)*) => { $crate::devlog::log_line($crate::devlog::Level::Warn,  $t, &format!($($arg)*)) }; }
#[macro_export]
macro_rules! log_error { ($t:expr, $($arg:tt)*) => { $crate::devlog::log_line($crate::devlog::Level::Error, $t, &format!($($arg)*)) }; }
