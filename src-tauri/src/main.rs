#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, State};

#[cfg(windows)]
mod scheduler;
#[cfg(windows)]
use scheduler::{CreateTaskParams, RunningTaskInfo, SchedulerEngine, TaskInfo, TaskRunRecord};

// Dev-level logger — see src-tauri/src/devlog.rs for the full design notes.
// Available macros (all from this crate root via #[macro_export]):
//   log_trace!, log_debug!, log_info!, log_warn!, log_error!
// Each takes a `target` string (typically "module::function") and format args.
mod devlog;

// Stub for non-Windows builds
#[cfg(not(windows))]
struct SchedulerEngine;

// ── App state ─────────────────────────────────────────────────────────────────
// sysinfo::System is held persistently so cpu_usage() returns accurate deltas
// between successive get_processes() calls rather than always reporting 0%.
//
// Phase 5 (expert process manager) added two more persistent state members:
//   - io_snapshots: previous I/O byte counts per PID, used to compute KB/s
//     rate between successive get_processes calls. Cleared as PIDs die.
//   - user_cache: PID → username string. Looking up usernames via Win32
//     OpenProcessToken+LookupAccountSid is ~1ms per process; cached because
//     a process's owner doesn't change after creation. Cache cleared as
//     PIDs die.
struct AppState {
    scheduler:    Mutex<Option<SchedulerEngine>>,
    sysinfo:      Mutex<sysinfo::System>,
    io_snapshots: Mutex<std::collections::HashMap<u32, IoSnapshot>>,
    user_cache:   Mutex<std::collections::HashMap<u32, String>>,
}

// ── Scheduler commands ────────────────────────────────────────────────────────

#[tauri::command]
#[cfg(windows)]
fn get_folders(state: State<AppState>) -> Result<Vec<String>, String> {
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.get_folders().map_err(|e| e.to_string()),
        None    => Err("Run as Administrator to access Task Scheduler.".into()),
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn get_folders(_state: State<AppState>) -> Result<Vec<String>, String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
async fn get_tasks(folder: String) -> Result<Vec<TaskInfo>, String> {
    // Async + off-thread (see get_all_tasks below for the full rationale): a folder
    // enumeration is a COM walk that, as a SYNC command on the shared main-thread
    // engine, blocked the UI. Run a throwaway STA engine on a blocking thread.
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TaskInfo>, String> {
        let engine = SchedulerEngine::new()
            .map_err(|e| format!("Run as Administrator to access Task Scheduler. ({e})"))?;
        engine.get_tasks(&folder).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Folder enumeration failed: {e}"))?
}
#[tauri::command]
#[cfg(not(windows))]
async fn get_tasks(_folder: String) -> Result<Vec<String>, String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
async fn get_all_tasks(skip_system: Option<bool>) -> Result<Vec<TaskInfo>, String> {
    // PERF (1.16.0) — THE launch-freeze fix. This walks every task via COM and
    // takes seconds; as a SYNCHRONOUS command it ran on the main thread and froze
    // the ENTIRE WebView UI (~15 s unclickable on launch). It is now `async` and
    // runs on a dedicated blocking thread with its OWN STA apartment — a throwaway
    // SchedulerEngine that CoInitializes itself and CoUninitializes on Drop, so it
    // never touches the main-thread engine. The UI thread stays responsive the
    // whole time; the task list just populates when the walk completes.
    //
    // GOTCHA: do NOT use the shared AppState engine here — it is STA-bound to the
    //         main thread, so calling it from this blocking thread would be an
    //         apartment violation. A fresh per-call engine is the correct pattern.
    let skip = skip_system.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TaskInfo>, String> {
        let engine = SchedulerEngine::new()
            .map_err(|e| format!("Run as Administrator to access Task Scheduler. ({e})"))?;
        // When the caller hides system tasks, skip the \Microsoft\ and \Windows\
        // subtrees entirely rather than enumerating ~250 system tasks via COM.
        let is_system = |p: &str| {
            p == "\\Microsoft" || p.starts_with("\\Microsoft\\")
                || p == "\\Windows" || p.starts_with("\\Windows\\")
        };
        let folders = engine.get_folders().map_err(|e| e.to_string())?;
        let mut all: Vec<TaskInfo> = Vec::new();
        for f in &folders {
            if skip && is_system(f) { continue; }
            if let Ok(tasks) = engine.get_tasks(f) { all.extend(tasks); }
        }
        let mut seen = std::collections::HashSet::new();
        all.retain(|t| seen.insert(t.path.clone()));
        Ok(all)
    })
    .await
    .map_err(|e| format!("Task enumeration failed: {e}"))?
}
#[tauri::command]
#[cfg(not(windows))]
async fn get_all_tasks(_skip_system: Option<bool>) -> Result<Vec<String>, String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn run_task(path: String, state: State<AppState>) -> Result<(), String> {
    log_info!("ipc::run_task", "path={}", path);
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.run_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }.map_err(|err| { log_error!("ipc::run_task", "failed: {}", err); err })
}
#[tauri::command]
#[cfg(not(windows))]
fn run_task(_path: String, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn stop_task(path: String, state: State<AppState>) -> Result<(), String> {
    log_info!("ipc::stop_task", "path={}", path);
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.stop_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }.map_err(|err| { log_error!("ipc::stop_task", "failed: {}", err); err })
}
#[tauri::command]
#[cfg(not(windows))]
fn stop_task(_path: String, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn set_task_enabled(path: String, enabled: bool, state: State<AppState>) -> Result<(), String> {
    log_info!("ipc::set_task_enabled", "path={} enabled={}", path, enabled);
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.set_enabled(&path, enabled).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }.map_err(|err| { log_error!("ipc::set_task_enabled", "failed: {}", err); err })
}
#[tauri::command]
#[cfg(not(windows))]
fn set_task_enabled(_path: String, _enabled: bool, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn delete_task(path: String, state: State<AppState>) -> Result<(), String> {
    log_warn!("ipc::delete_task", "path={}", path);
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.delete_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }.map_err(|err| { log_error!("ipc::delete_task", "failed: {}", err); err })
}
#[tauri::command]
#[cfg(not(windows))]
fn delete_task(_path: String, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn export_task_xml(path: String, state: State<AppState>) -> Result<String, String> {
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.export_xml(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn export_task_xml(_path: String, _state: State<AppState>) -> Result<String, String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn import_task_xml(folder: String, name: String, xml: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.import_xml(&folder, &name, &xml).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn import_task_xml(_folder: String, _name: String, _xml: String, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

// ── Move task between folders (Phase 2 feature) ─────────────────────────────
// There is no atomic "move task" primitive in the Windows Task Scheduler COM
// API. We compose one from three existing operations with explicit rollback
// semantics: export XML, import to new folder, delete from old. If the
// import succeeds and delete fails, we end up with a duplicate (caller can
// retry the delete). If import fails, the original task is untouched. We
// NEVER delete first — that would leave the user with no task on any
// failure of the import step.
//
// Returns the new full task path on success (e.g. "\NewFolder\TaskName")
// so the caller can re-select the moved task in the UI.
//
// Trade-off accepted: this re-registers the task. Run-history tied to the
// old task path is lost (Windows tracks history by `\folder\name` identity).
// If we wanted to preserve history we'd need to hand-edit the XML registry,
// which is fragile and not officially supported by Microsoft.
#[tauri::command]
#[cfg(windows)]
fn move_task(
    src_path: String,
    dest_folder: String,
    state: State<AppState>,
) -> Result<String, String> {
    log_info!("ipc::move_task", "src={} dest_folder={}", src_path, dest_folder);

    // Parse source path to get the task name. Windows uses backslash separators
    // and tasks always live at "\folder\subfolder\TaskName".
    let task_name = src_path.rsplit('\\').next()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| format!("Invalid source path: {}", src_path))?
        .to_string();

    // Compute the source folder: everything before the final \taskname
    let src_folder = if let Some(idx) = src_path.rfind('\\') {
        if idx == 0 { "\\".to_string() } else { src_path[..idx].to_string() }
    } else {
        return Err(format!("Source path missing folder: {}", src_path));
    };

    // Normalize destination folder: ensure leading backslash, no trailing
    let dest_folder_norm = {
        let mut f = dest_folder.trim().to_string();
        if !f.starts_with('\\') { f.insert(0, '\\'); }
        if f.len() > 1 && f.ends_with('\\') { f.pop(); }
        f
    };

    if src_folder == dest_folder_norm {
        return Err("Source and destination folders are the same".into());
    }

    // Construct expected new path so we can return it
    let new_path = if dest_folder_norm == "\\" {
        format!("\\{}", task_name)
    } else {
        format!("{}\\{}", dest_folder_norm, task_name)
    };

    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    let engine = lock.as_ref().ok_or("Run as Administrator.")?;

    // Step 1: Export
    let xml = engine.export_xml(&src_path)
        .map_err(|e| format!("Export failed: {}", e))?;
    log_info!("ipc::move_task", "exported {} bytes from {}", xml.len(), src_path);

    // Step 2: Import to destination
    engine.import_xml(&dest_folder_norm, &task_name, &xml)
        .map_err(|e| format!("Import to {} failed: {}", dest_folder_norm, e))?;
    log_info!("ipc::move_task", "imported into {}", dest_folder_norm);

    // Step 3: Delete original. If this fails we have a duplicate but the
    // user has the moved version where they wanted it — return success
    // with a warning rather than confusing them with a hard failure.
    if let Err(e) = engine.delete_task(&src_path) {
        log_error!("ipc::move_task",
            "delete of original {} failed: {} — duplicate exists at {}",
            src_path, e, new_path);
        return Err(format!(
            "Move partially succeeded — task copied to {} but original at {} could not be deleted: {}",
            new_path, src_path, e));
    }
    log_info!("ipc::move_task", "deleted original {}, move complete", src_path);

    Ok(new_path)
}
#[tauri::command]
#[cfg(not(windows))]
fn move_task(_src_path: String, _dest_folder: String, _state: State<AppState>) -> Result<String, String> {
    Err("Windows only".into())
}

// ── File hash for integrity check (Phase 3 feature) ─────────────────────────
// Computes SHA-256 of a file. Used by the integrity-check feature to detect
// whether a task's referenced executable has been modified since the user
// last "trusted" it (e.g. malware replacing a legitimate scheduled-task
// payload).
//
// Reads the file in chunks rather than slurping into memory because some
// task targets are large (multi-megabyte installer EXEs). 64KB chunks are
// the sweet spot for `sha2` crate's update method.
//
// Returns "" (empty) on file-not-found rather than erroring — a non-existent
// file is a meaningful integrity signal ("the executable disappeared")
// that the UI surfaces differently from a hash mismatch.
#[tauri::command]
fn hash_file(path: String) -> Result<String, String> {
    use sha2::{Sha256, Digest};
    use std::io::Read;

    if path.trim().is_empty() {
        return Ok(String::new());
    }
    let p = std::path::Path::new(&path);
    // Reject relative paths and parent-dir traversal. Not extension-restricted
    // (its purpose is hashing arbitrary task-target executables for the
    // integrity feature), and it returns only a digest, never file contents.
    if !p.is_absolute() || p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("hash_file requires an absolute path without '..' components".into());
    }
    if !p.exists() || !p.is_file() {
        log_info!("ipc::hash_file", "missing or not-a-file: {}", path);
        return Ok(String::new());
    }
    let mut file = std::fs::File::open(p).map_err(|e| format!("open: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{:02x}", b)).collect::<String>())
}

// Spawns the task's program directly with captured stdout/stderr so the user
// can SEE what their script outputs. This is fundamentally different from
// `run_task` which calls `IRegisteredTask::Run()` (asynchronous, no output
// capture).
//
// Crucial limitations the UI must surface:
//   - Runs as the CURRENT user, not the task's run_as principal. If the
//     task is configured to run as SYSTEM, this won't reproduce that
//     environment.
//   - Doesn't honor task conditions (idle, AC power, network, etc.) —
//     it just runs the program.
//   - Doesn't apply the task's exec time limit. We enforce a 60-second
//     hard cap here so a misbehaving script can't hang the IPC.
//
// Trade-off accepted: 95% of "why isn't my task working?" debugging is
// "what does the script output?" which the real Run command never shows.
// This closes that gap. For the other 5% (impersonation issues, scheduler
// conditions), users still need to look at the event log via the new
// search_event_history IPC.
#[derive(serde::Serialize)]
struct TestRunResult {
    exit_code:    Option<i32>,
    stdout:       String,
    stderr:       String,
    duration_ms:  u64,
    timed_out:    bool,
    program:      String,
    args:         String,
    working_dir:  String,
}

#[tauri::command]
#[cfg(windows)]
fn run_task_test(
    program: String,
    args: String,
    working_dir: String,
) -> Result<TestRunResult, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use std::os::windows::process::CommandExt;

    log_info!("ipc::run_task_test", "program={} args={} cwd={}",
              program, args, working_dir);

    if program.trim().is_empty() {
        return Err("Program path is empty — task has no executable action.".into());
    }

    // Build the command. We use Command::new(program) and pass args as a
    // single raw string via .raw_arg() which preserves quoting exactly as
    // the user typed it. Splitting on spaces would mangle paths-with-spaces.
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new(&program);
    if !args.trim().is_empty() {
        // raw_arg appends literally without re-quoting. Required because the
        // task's args are already user-typed shell-style strings.
        cmd.raw_arg(&args);
    }
    if !working_dir.trim().is_empty() {
        cmd.current_dir(&working_dir);
    }
    cmd.stdout(Stdio::piped())
       .stderr(Stdio::piped())
       .stdin(Stdio::null())
       .creation_flags(CREATE_NO_WINDOW);

    let started = Instant::now();
    let mut child = cmd.spawn()
        .map_err(|e| format!("Spawn failed: {}", e))?;

    // Hard timeout: 60s. If the program is still running after that we
    // kill it and return what we have. Reading stdout/stderr is blocking,
    // so we use a thread-based timeout pattern: spawn readers, wait on
    // child with timeout, kill on exceeded.
    use std::sync::{Arc, Mutex};
    use std::thread;

    let stdout_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));

    // Return a clean Err instead of panicking the IPC worker if a pipe handle
    // is unexpectedly absent (kill the child so it is not left orphaned).
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None    => { let _ = child.kill(); return Err("stdout pipe missing".into()); }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None    => { let _ = child.kill(); return Err("stderr pipe missing".into()); }
    };
    let so_clone = stdout_buf.clone();
    let se_clone = stderr_buf.clone();

    let so_thread = thread::spawn(move || {
        use std::io::Read;
        let mut s = stdout;
        let mut buf = Vec::with_capacity(8192);
        let _ = s.read_to_end(&mut buf);
        if let Ok(mut g) = so_clone.lock() { *g = buf; }
    });
    let se_thread = thread::spawn(move || {
        use std::io::Read;
        let mut s = stderr;
        let mut buf = Vec::with_capacity(8192);
        let _ = s.read_to_end(&mut buf);
        if let Ok(mut g) = se_clone.lock() { *g = buf; }
    });

    let timeout = Duration::from_secs(60);
    let deadline = started + timeout;
    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();   // reap zombie
                    timed_out = true;
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Wait failed: {}", e)),
        }
    }

    // Drain reader threads — they exit naturally when pipes close after
    // the child terminates. If the kill above just happened, this should
    // return within milliseconds.
    let _ = so_thread.join();
    let _ = se_thread.join();

    let duration_ms = started.elapsed().as_millis() as u64;
    let stdout_str = stdout_buf.lock().map(|g|
        String::from_utf8_lossy(&g).to_string()
    ).unwrap_or_default();
    let stderr_str = stderr_buf.lock().map(|g|
        String::from_utf8_lossy(&g).to_string()
    ).unwrap_or_default();

    log_info!("ipc::run_task_test",
        "completed | exit={:?} timed_out={} duration_ms={} stdout_bytes={} stderr_bytes={}",
        exit_code, timed_out, duration_ms, stdout_str.len(), stderr_str.len());

    Ok(TestRunResult {
        exit_code,
        stdout: stdout_str,
        stderr: stderr_str,
        duration_ms,
        timed_out,
        program,
        args,
        working_dir,
    })
}
#[tauri::command]
#[cfg(not(windows))]
fn run_task_test(_program: String, _args: String, _working_dir: String) -> Result<serde_json::Value, String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn create_task(params: CreateTaskParams, state: State<AppState>) -> Result<(), String> {
    log_info!("ipc::create_task", "name={} folder={} trigger={} program={}", params.name, params.folder_path, params.trigger_type, params.program_path);
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.create_task(&params).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }.map_err(|err| { log_error!("ipc::create_task", "failed: {}", err); err })
}
#[tauri::command]
#[cfg(not(windows))]
fn create_task(_params: CreateTaskParams, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn update_task(path: String, params: CreateTaskParams, state: State<AppState>) -> Result<(), String> {
    log_info!("ipc::update_task", "path={} new_name={} trigger={} program={}", path, params.name, params.trigger_type, params.program_path);
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.update_task(&path, &params).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }.map_err(|err| { log_error!("ipc::update_task", "failed: {}", err); err })
}
#[tauri::command]
#[cfg(not(windows))]
fn update_task(_path: String, _params: CreateTaskParams, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

// PERF (perf-1): get_running_tasks runs blocking COM (ITaskService::GetRunningTasks)
// and the Live Monitor polls it every 3s. As a SYNC command it executed on the UI
// thread and could micro-freeze the WebView each tick. Now async + spawn_blocking
// with a throwaway per-call STA engine (same pattern as get_all_tasks) — never the
// shared main-thread engine, which would be an apartment violation off-thread.
#[tauri::command]
#[cfg(windows)]
async fn get_running_tasks() -> Result<Vec<RunningTaskInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<RunningTaskInfo>, String> {
        let engine = SchedulerEngine::new()
            .map_err(|e| format!("Run as Administrator to access Task Scheduler. ({e})"))?;
        engine.get_running_tasks().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Running-task query failed: {e}"))?
}
#[tauri::command]
#[cfg(not(windows))]
async fn get_running_tasks() -> Result<Vec<String>, String> { Err("Windows only".into()) }

// PERF (perf-2): same treatment — get_task_history does blocking COM
// (GetFolder/GetTask/GetRunTimes). async + spawn_blocking + fresh STA engine.
#[tauri::command]
#[cfg(windows)]
async fn get_task_history(path: String, max_records: u32) -> Result<Vec<TaskRunRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TaskRunRecord>, String> {
        let engine = SchedulerEngine::new()
            .map_err(|e| format!("Run as Administrator to access Task Scheduler. ({e})"))?;
        engine.get_task_history(&path, max_records).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task history query failed: {e}"))?
}
#[tauri::command]
#[cfg(not(windows))]
async fn get_task_history(_path: String, _max_records: u32) -> Result<Vec<String>, String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn create_folder(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.create_folder(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn create_folder(_path: String, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn delete_folder(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.scheduler.lock().map_err(|e| format!("State mutex poisoned: {e}"))?;
    match lock.as_ref() {
        Some(e) => e.delete_folder(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn delete_folder(_path: String, _state: State<AppState>) -> Result<(), String> { Err("Windows only".into()) }

// ── Filesystem allow-list helper ─────────────────────────────────────────────
// read_file / write_file are used by the script editor and XML import/export.
// We restrict them to paths that are either:
//   (a) the user explicitly browsed to via browse_for_file / browse_for_folder,
//   (b) script files with known safe extensions, OR
//   (c) temp files inside the system temp directory.
// This prevents an XSS-to-IPC attack from reading arbitrary files (e.g. SSH
// keys, credential stores) or writing anywhere the elevated process can reach.
fn is_safe_read_path(path: &str) -> bool {
    let p = std::path::Path::new(path);
    // Must be absolute — no relative traversal tricks
    if !p.is_absolute() { return false; }
    // Reject paths containing ".." components
    if p.components().any(|c| c == std::path::Component::ParentDir) { return false; }
    // Allow: known script / config extensions only
    let allowed_exts = ["xml", "txt", "ps1", "bat", "cmd", "json", "log", "csv"];
    // Resolve symlinks / junctions / 8.3 short-names so the extension check
    // cannot be bypassed by a link named foo.txt whose real target is, e.g.,
    // %USERPROFILE%\.ssh\id_rsa. If the file does not exist, canonicalize fails
    // and we fall back to the lexical path (the read then simply fails).
    let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    match resolved.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            // Bind to a named variable so the String temporary lives long enough
            // for the borrow — `contains(&temp.as_str())` borrows from a dropped
            // temporary in some Rust editions.
            let lower = ext.to_lowercase();
            allowed_exts.contains(&lower.as_str())
        }
        None      => false,
    }
}

fn is_safe_write_path(path: &str) -> bool {
    let p = std::path::Path::new(path);
    if !p.is_absolute() { return false; }
    if p.components().any(|c| c == std::path::Component::ParentDir) { return false; }
    // Write is additionally restricted: only .xml, .ps1, .bat, .cmd, .txt, .json
    // Not .log or .csv — those are read-only formats for this app
    let allowed_exts = ["xml", "txt", "ps1", "bat", "cmd", "json"];
    let ext_ok = |path: &std::path::Path| match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            // Bind to a named variable so the String temporary lives long enough
            // for the borrow — `contains(&temp.as_str())` borrows from a dropped
            // temporary in some Rust editions.
            let lower = ext.to_lowercase();
            allowed_exts.contains(&lower.as_str())
        }
        None      => false,
    };
    // The literal target extension must be allowed...
    if !ext_ok(p) { return false; }
    // ...and if the target already exists (e.g. a planted symlink/junction whose
    // name ends in .xml), its RESOLVED extension must also be allowed, so a
    // writable link cannot redirect the write onto a different real file. If it
    // does not exist yet, canonicalize fails and the lexical checks above stand.
    match std::fs::canonicalize(p) {
        Ok(resolved) => ext_ok(&resolved),
        Err(_)       => true,
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    if !is_safe_read_path(&path) {
        return Err(format!("Access denied: '{}' is not a permitted file type or path", path));
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if !is_safe_write_path(&path) {
        return Err(format!("Access denied: '{}' is not a permitted write target", path));
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ── Event Log execution history ───────────────────────────────────────────────
// Queries Microsoft-Windows-TaskScheduler/Operational for real run records.
// Event 200 = completed, 201 = failed. Falls back silently if log is disabled.
#[tauri::command]
#[cfg(windows)]
async fn get_event_log_history(task_path: String, max_records: u32) -> Result<Vec<serde_json::Value>, String> {
    // PERF (1.16.0): powershell.exe Get-WinEvent can take MANY seconds on a busy
    // event log. As a SYNC command this blocked the main UI thread (the real
    // launch freeze — the dashboard's Activity digest calls search_event_history
    // below on boot). Now async + spawn_blocking so the PowerShell runs off the
    // UI thread; the digest/history just fills in when it finishes.
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
    use std::process::Command;

    // Use -FilterHashtable for source-side filtering — much faster than
    // loading all events and filtering in memory on large event logs.
    let ps_script = format!(r#"
$log  = 'Microsoft-Windows-TaskScheduler/Operational'
$path = '{path}'
$max  = {max}
try {{
  $filter = @{{ LogName = $log; Id = 200,201 }}
  $events = Get-WinEvent -FilterHashtable $filter -MaxEvents ($max * 2) -ErrorAction Stop |
    Where-Object {{ $_.Message -match [regex]::Escape($path) }} |
    Select-Object -First $max
  $results = $events | ForEach-Object {{
    $rc = if ($_.Id -eq 200) {{ 0 }} else {{ 1 }}
    if ($_.Message -match 'result code was (0x[0-9A-Fa-f]+|\d+)') {{ $rc = $Matches[1] }}
    [PSCustomObject]@{{
      time    = $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
      id      = $_.Id
      result  = $rc
      success = ($_.Id -eq 200)
    }}
  }}
  if ($results) {{ $results | ConvertTo-Json -Compress }} else {{ '[]' }}
}} catch {{ '[]' }}
"#,
        path = task_path.replace('\'', "''"),
        max  = max_records,
    );

    // CREATE_NO_WINDOW (0x08000000) suppresses the brief console flash that
    // PowerShell would otherwise show. Required for the headless updater
    // requirement and good UX in general — users should not see flashing
    // cmd/PS windows during normal app activity.
    use std::os::windows::process::CommandExt;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
               "-ExecutionPolicy", "Bypass",
               "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("PowerShell failed: {e}"))?;

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() || raw == "[]" { return Ok(vec![]); }

    // PowerShell returns a single object (not array) for one result
    let json_str = if raw.starts_with('{') { format!("[{}]", raw) } else { raw };
    serde_json::from_str::<Vec<serde_json::Value>>(&json_str)
        .map_err(|e| format!("JSON parse error: {e}"))
    })
    .await
    .map_err(|e| format!("Event-log query thread failed: {e}"))?
}
#[tauri::command]
#[cfg(not(windows))]
async fn get_event_log_history(_task_path: String, _max_records: u32) -> Result<Vec<serde_json::Value>, String> { Ok(vec![]) }

// ── History-wide search (Phase 1 feature) ───────────────────────────────────
// Searches the Task Scheduler operational event log across ALL tasks for
// matches against a substring filter, optionally constrained by a date
// range. Returns up to `max_records` event rows in reverse chronological
// order.
//
// Use cases:
//   - "Find me the task that failed at 14:32 yesterday"
//   - "Show all backup-related task runs in the last 7 days"
//   - "Has any task ever logged event 102 (start failed)?"
//
// We use Get-WinEvent with FilterHashtable for source-side filtering. Adding
// a -StartTime/-EndTime to the hashtable pushes the date filter into the
// kernel-mode event log query, which is much faster than post-filtering on
// thousands of records.
//
// `query` is matched as a CASE-INSENSITIVE substring against the Message
// field (which contains both the task path and any error text). Empty
// query = match all events in the date range.
#[tauri::command]
#[cfg(windows)]
async fn search_event_history(
    query: String,
    start_iso: String,    // "" or "YYYY-MM-DDTHH:mm:ss"
    end_iso: String,      // "" or "YYYY-MM-DDTHH:mm:ss"
    event_ids: Vec<u32>,  // [] = all default IDs (100,102,103,106,140,141,200,201)
    max_records: u32,
) -> Result<Vec<serde_json::Value>, String> {
    log_info!("ipc::search_event_history",
        "query={:?} start={} end={} ids={:?} max={}",
        query, start_iso, end_iso, event_ids, max_records);

    // PERF (1.16.0) — THE launch-freeze fix. This is the dashboard's Activity
    // digest query: Get-WinEvent over the 24h Task Scheduler log can take ~20s on
    // a busy machine, and as a SYNC command it ran on and FROZE the main UI thread
    // on boot. Now async + spawn_blocking so the PowerShell runs off the UI thread;
    // the digest just fills in when it finishes.
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
    use std::process::Command;

    // Build the FilterHashtable contents. Empty = no constraint on that key.
    let id_clause = if event_ids.is_empty() {
        // Default: events that represent execution lifecycle.
        // 100=task started, 102=task completed, 103=action failed,
        // 106=registered, 140=registration changed, 141=deleted,
        // 200=action started, 201=action completed.
        // Most users only care about start/complete/fail; default to those.
        "Id = 100,102,103,200,201".to_string()
    } else {
        format!("Id = {}", event_ids.iter().map(|i| i.to_string())
            .collect::<Vec<_>>().join(","))
    };

    let start_clause = if !start_iso.is_empty() {
        format!("StartTime = [datetime]'{}'", start_iso.replace('\'', "''"))
    } else { String::new() };

    let end_clause = if !end_iso.is_empty() {
        format!("EndTime = [datetime]'{}'", end_iso.replace('\'', "''"))
    } else { String::new() };

    let mut filter_parts = vec![
        "LogName = 'Microsoft-Windows-TaskScheduler/Operational'".to_string(),
        id_clause,
    ];
    if !start_clause.is_empty() { filter_parts.push(start_clause); }
    if !end_clause.is_empty()   { filter_parts.push(end_clause); }
    let filter_inner = filter_parts.join("; ");

    // Match query as case-insensitive substring against Message.
    // PowerShell's -match is regex; use [regex]::Escape to literal-match.
    let where_clause = if !query.is_empty() {
        format!(r#"| Where-Object {{ $_.Message -imatch [regex]::Escape('{}') }}"#,
                query.replace('\'', "''"))
    } else { String::new() };

    let ps_script = format!(r#"
try {{
  $events = Get-WinEvent -FilterHashtable @{{ {filter} }} -MaxEvents ({max} * 2) -ErrorAction Stop {where} | Select-Object -First {max}
  $results = $events | ForEach-Object {{
    # Extract task path from Message — formats vary by event ID but the
    # path is always present in some recognizable form.
    $taskPath = ''
    if ($_.Message -match '"(\\\\?[^"]*?)"') {{ $taskPath = $Matches[1] }}
    elseif ($_.Properties -and $_.Properties.Count -gt 0) {{
      $taskPath = ($_.Properties | Where-Object {{ $_.Value -match '^\\\\' }} | Select-Object -First 1 -ExpandProperty Value) -as [string]
    }}
    [PSCustomObject]@{{
      time     = $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
      id       = $_.Id
      task     = $taskPath
      level    = $_.LevelDisplayName
      message  = ($_.Message -replace '[\r\n]+', ' ').Substring(0, [Math]::Min(220, $_.Message.Length))
    }}
  }}
  if ($results) {{ $results | ConvertTo-Json -Compress }} else {{ '[]' }}
}} catch {{
  Write-Output '[]'
}}
"#, filter = filter_inner, where = where_clause, max = max_records);

    use std::os::windows::process::CommandExt;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
               "-ExecutionPolicy", "Bypass",
               "-Command", &ps_script])
        .creation_flags(0x08000000)  // CREATE_NO_WINDOW — silent PS spawn
        .output()
        .map_err(|e| format!("PowerShell failed: {e}"))?;

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() || raw == "[]" { return Ok(vec![]); }

    // PowerShell returns a single object (not array) for one result
    let json_str = if raw.starts_with('{') { format!("[{}]", raw) } else { raw };
    serde_json::from_str::<Vec<serde_json::Value>>(&json_str)
        .map_err(|e| format!("JSON parse error: {e}"))
    })
    .await
    .map_err(|e| format!("Event-log search thread failed: {e}"))?
}
#[tauri::command]
#[cfg(not(windows))]
async fn search_event_history(_query: String, _start_iso: String, _end_iso: String,
                        _event_ids: Vec<u32>, _max_records: u32)
    -> Result<Vec<serde_json::Value>, String> { Ok(vec![]) }

// ── Process Manager ───────────────────────────────────────────────────────────
// Uses the sysinfo crate — no PowerShell spawn per refresh.
// AppState holds a persistent System so cpu_usage() returns accurate deltas
// between successive calls rather than always reporting 0%.
//
// ── Process Manager (Phase 5: Expert level) ────────────────────────────────
// Major rewrite for the enriched process manager. The original sysinfo-only
// implementation gave us pid/name/cpu/memory and called it done. The expert
// version adds:
//   - Parent PID (for tree view)
//   - Command line (full arg vector)
//   - User (owner)
//   - Start time (Unix epoch seconds)
//   - Run time (seconds since start)
//   - Threads, handles
//   - Working set + private bytes (separate memory metrics)
//   - I/O read/write byte counters (cumulative)
//   - Disk read/write rate (bytes/sec since last refresh)
//   - Executable path (for "Open file location")
//   - Status (Running/Suspended/Stopped/etc)
//
// Most fields come from sysinfo. Three need Win32 calls:
//   - Username: OpenProcessToken + GetTokenInformation(TokenUser) + LookupAccountSid
//   - Handle count: NtQuerySystemInformation (system-wide) or GetProcessHandleCount (per-process)
//   - Elevation: GetTokenInformation(TokenElevation)
//
// Fields are populated best-effort. If a Win32 call fails (denied access for
// protected processes like csrss.exe, System, etc.), we leave the field empty
// rather than failing the whole snapshot. The UI displays "—" for empties.
//
// PERFORMANCE NOTE: collecting username + handle count per-process via Win32
// is ~1-2ms per process due to OpenProcess + token + SID lookup. With 250
// processes that's 250-500ms per refresh. We do this synchronously in the
// IPC; if it gets slow on busy machines we'd need to cache usernames (they
// don't change after process start) and only refresh handle counts.
#[derive(serde::Serialize, Clone)]
struct ProcessInfo {
    pid:           u32,
    parent_pid:    u32,        // 0 if none / unknown
    name:          String,
    exe_path:      String,
    command_line:  String,
    user:          String,
    cpu_usage:     f32,
    mem_working_kb:u64,        // working set (RAM in use)
    mem_private_kb:u64,        // private bytes (committed virtual memory)
    threads:       u32,
    handles:       u32,        // Win32 GetProcessHandleCount, 0 if unavailable
    start_time:    u64,        // Unix epoch seconds, 0 if unavailable
    run_secs:      u64,        // seconds since start
    status:        String,
    elevated:      bool,       // running as elevated/admin
    disk_read_kb_s:  u64,      // approximate KB/s read (0 if unavailable)
    disk_write_kb_s: u64,      // approximate KB/s written
}

#[cfg(windows)]
fn get_process_username(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::Security::{LookupAccountSidW, SID_NAME_USE};
    use windows::core::PWSTR;

    unsafe {
        let proc_h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut token_h = HANDLE::default();
        if OpenProcessToken(proc_h, TOKEN_QUERY, &mut token_h).is_err() {
            let _ = CloseHandle(proc_h);
            return None;
        }

        // Two-call dance: first call with NULL buffer to get required size,
        // then allocate and call again.
        let mut needed: u32 = 0;
        let _ = GetTokenInformation(token_h, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token_h);
            let _ = CloseHandle(proc_h);
            return None;
        }

        let mut buf = vec![0u8; needed as usize];
        let buf_ptr = buf.as_mut_ptr() as *mut std::ffi::c_void;
        if GetTokenInformation(
            token_h,
            TokenUser,
            Some(buf_ptr),
            needed,
            &mut needed,
        ).is_err() {
            let _ = CloseHandle(token_h);
            let _ = CloseHandle(proc_h);
            return None;
        }

        let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid = token_user.User.Sid;

        // Resolve SID -> "DOMAIN\\name"
        let mut name_buf = vec![0u16; 256];
        let mut domain_buf = vec![0u16; 256];
        let mut name_len = name_buf.len() as u32;
        let mut domain_len = domain_buf.len() as u32;
        let mut sid_use = SID_NAME_USE::default();

        let lookup = LookupAccountSidW(
            None,
            sid,
            // Output buffer params for LookupAccountSidW are Option<PWSTR>
            // in `windows = "0.61"`. Confirmed by compile error:
            //   `expected Option<PWSTR>, found PWSTR`.
            // This differs from input-only string params on functions like
            // ShellExecuteW, which take a generic `P0: Param<PCWSTR>` that
            // can accept a bare PCWSTR. The pattern: any output buffer
            // typed Option<PWSTR> means "optional output — pass None to
            // get just the required length, pass Some(buf) to get content."
            // For our case we always want the content, so always Some.
            Some(PWSTR(name_buf.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain_buf.as_mut_ptr())),
            &mut domain_len,
            &mut sid_use,
        );

        let _ = CloseHandle(token_h);
        let _ = CloseHandle(proc_h);

        if lookup.is_err() {
            // LookupAccountSidW failed — typically means the SID belongs to
            // a domain we can't reach or a deleted account. Previously this
            // path called ConvertSidToStringSidW + LocalFree as a fallback
            // to display the raw SID string ("S-1-5-18" etc.). Removed
            // because:
            //   1. The frontend already displays "—" for missing users,
            //      which is fine for the protected-process case (csrss,
            //      System, etc.) — those rows look like every other row
            //      whose username we couldn't resolve.
            //   2. Removing ConvertSidToStringSidW also removes the need
            //      for LocalFree, which moves between modules between
            //      windows-rs versions and was a build-break source.
            //   3. The fallback path was rare in practice (most failed
            //      lookups are for protected processes, where the
            //      OpenProcess at the top of this fn already returned None
            //      before we got here).
            return None;
        }

        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let domain = String::from_utf16_lossy(&domain_buf[..domain_len as usize]);
        if domain.is_empty() {
            Some(name)
        } else {
            Some(format!("{}\\{}", domain, name))
        }
    }
}

#[cfg(windows)]
fn get_process_handle_count(pid: u32) -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetProcessHandleCount, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut count: u32 = 0;
        let ok = GetProcessHandleCount(h, &mut count).is_ok();
        let _ = CloseHandle(h);
        if ok { Some(count) } else { None }
    }
}

// Build a HashMap of pid → thread_count for every running process in ONE
// CreateToolhelp32Snapshot call. Cost is O(N processes) for the single
// snapshot (~5ms for 300 processes), versus O(N) OpenProcess+NtQuery calls
// at ~0.5ms each = 150ms+ if we did it per-process. The snapshot returns
// PROCESSENTRY32W structs whose `cntThreads` field is exactly what we need.
//
// 1.14.2: this replaces the broken `process.tasks().map(|t| t.len())` path
// from sysinfo, which returns None on Windows when the crate is built
// without the thread-tracking feature (and we can't enable that feature
// without bloating refresh time). PROCESSENTRY32W::cntThreads gives us
// the count cheaply and accurately.
// Build a PID → thread-count map. Used by list_processes to populate
// ProcessInfo.threads, since sysinfo's `process.tasks()` returns None on
// Windows with our build configuration.
//
// Two strategies, primary then fallback:
//
//   A) TH32CS_SNAPPROCESS — single snapshot of the process list, where each
//      PROCESSENTRY32W record carries `cntThreads` directly. Fastest path.
//      Used by Task Manager and most monitoring tools.
//
//   B) TH32CS_SNAPTHREAD — snapshot of every thread system-wide, count by
//      th32OwnerProcessID. Slower (one record per thread vs one per process)
//      but doesn't depend on `cntThreads` populating correctly. Diagnostic
//      use revealed this works in environments where (A) returns an empty
//      map — likely a Defender ASR rule or AppLocker policy that blocks
//      TH32CS_SNAPPROCESS while leaving TH32CS_SNAPTHREAD alone.
//
// Errors at any step are logged but don't abort — we return whatever we
// got. Empty result → frontend displays "—" in the Threads column, which
// is at least honest.
#[cfg(windows)]
fn get_all_thread_counts() -> std::collections::HashMap<u32, u32> {
    let map = get_thread_counts_via_process_snapshot();
    if !map.is_empty() {
        return map;
    }
    log_warn!("get_all_thread_counts",
        "TH32CS_SNAPPROCESS returned empty map — falling back to TH32CS_SNAPTHREAD enumeration");
    get_thread_counts_via_thread_snapshot()
}

#[cfg(windows)]
fn get_thread_counts_via_process_snapshot() -> std::collections::HashMap<u32, u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut map = std::collections::HashMap::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(e) => {
                log_error!("get_thread_counts_via_process_snapshot",
                    "CreateToolhelp32Snapshot(SNAPPROCESS) failed: {e}");
                return map;
            }
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        match Process32FirstW(snapshot, &mut entry) {
            Ok(()) => {
                loop {
                    map.insert(entry.th32ProcessID, entry.cntThreads);
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                log_error!("get_thread_counts_via_process_snapshot",
                    "Process32FirstW failed: {e}");
            }
        }

        let _ = CloseHandle(snapshot);
    }
    map
}

#[cfg(windows)]
fn get_thread_counts_via_thread_snapshot() -> std::collections::HashMap<u32, u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next,
        THREADENTRY32, TH32CS_SNAPTHREAD,
    };

    let mut map: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) {
            Ok(h) => h,
            Err(e) => {
                log_error!("get_thread_counts_via_thread_snapshot",
                    "CreateToolhelp32Snapshot(SNAPTHREAD) failed: {e}");
                return map;
            }
        };

        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };

        match Thread32First(snapshot, &mut entry) {
            Ok(()) => {
                loop {
                    *map.entry(entry.th32OwnerProcessID).or_insert(0) += 1;
                    if Thread32Next(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                log_error!("get_thread_counts_via_thread_snapshot",
                    "Thread32First failed: {e}");
            }
        }

        let _ = CloseHandle(snapshot);
    }
    log_debug!("get_thread_counts_via_thread_snapshot",
        "enumerated threads for {} distinct PIDs", map.len());
    map
}

#[cfg(windows)]
fn get_process_elevated(pid: u32) -> Option<bool> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_QUERY, TOKEN_ELEVATION,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let proc_h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut token_h = HANDLE::default();
        if OpenProcessToken(proc_h, TOKEN_QUERY, &mut token_h).is_err() {
            let _ = CloseHandle(proc_h);
            return None;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size: u32 = 0;
        let result = GetTokenInformation(
            token_h,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        );
        let _ = CloseHandle(token_h);
        let _ = CloseHandle(proc_h);
        if result.is_ok() {
            Some(elevation.TokenIsElevated != 0)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn get_process_username(_pid: u32) -> Option<String> { None }
#[cfg(not(windows))]
fn get_process_handle_count(_pid: u32) -> Option<u32> { None }
#[cfg(not(windows))]
fn get_process_elevated(_pid: u32) -> Option<bool> { None }

// Track previous I/O byte counters per-PID so we can compute rate (bytes/sec)
// between successive get_processes calls.
struct IoSnapshot {
    read_bytes:  u64,
    write_bytes: u64,
    timestamp:   std::time::Instant,
}

impl Default for IoSnapshot {
    fn default() -> Self {
        IoSnapshot { read_bytes: 0, write_bytes: 0, timestamp: std::time::Instant::now() }
    }
}

#[tauri::command]
fn get_processes(state: State<AppState>) -> Result<Vec<ProcessInfo>, String> {
    let mut sys = state.sysinfo.lock()
        .map_err(|e| format!("sysinfo lock poisoned: {e}"))?;

    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    // I/O delta tracking. We keep a per-PID snapshot in AppState so we can
    // compute KB/s between successive calls. Cleared periodically so dead
    // processes' entries don't leak.
    let mut io_snapshots = state.io_snapshots.lock()
        .map_err(|e| format!("io_snapshots lock poisoned: {e}"))?;
    let now = std::time::Instant::now();

    let procs_iter = sys.processes();
    let live_pids: std::collections::HashSet<u32> = procs_iter.keys().map(|p| p.as_u32()).collect();
    // Drop dead-process entries
    io_snapshots.retain(|pid, _| live_pids.contains(pid));

    let mut procs: Vec<ProcessInfo> = procs_iter
        .iter()
        .map(|(pid, process)| {
            let pid_u = pid.as_u32();
            let parent_pid = process.parent().map(|p| p.as_u32()).unwrap_or(0);

            let cmd = {
                // sysinfo 0.32: cmd() returns &[OsString]
                let parts: Vec<String> = process.cmd().iter()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect();
                if parts.is_empty() {
                    String::new()
                } else {
                    parts.join(" ")
                }
            };
            let exe = process.exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let mem_working = process.memory();         // bytes (working set on Windows)
            let mem_virtual = process.virtual_memory(); // bytes (private + shared)

            let start_time = process.start_time();
            let run_secs = process.run_time();

            // sysinfo's DiskUsage gives total bytes since process start.
            // We compute rate as (current - previous) / dt.
            let du = process.disk_usage();
            let total_read  = du.total_read_bytes;
            let total_write = du.total_written_bytes;

            let (rd_rate, wr_rate) = match io_snapshots.get(&pid_u) {
                Some(prev) => {
                    let dt = now.saturating_duration_since(prev.timestamp).as_secs_f64();
                    if dt > 0.001 {
                        let rd = ((total_read.saturating_sub(prev.read_bytes)) as f64 / dt / 1024.0) as u64;
                        let wr = ((total_write.saturating_sub(prev.write_bytes)) as f64 / dt / 1024.0) as u64;
                        (rd, wr)
                    } else { (0, 0) }
                }
                None => (0, 0),
            };
            io_snapshots.insert(pid_u, IoSnapshot {
                read_bytes:  total_read,
                write_bytes: total_write,
                timestamp:   now,
            });

            ProcessInfo {
                pid:            pid_u,
                parent_pid,
                name:           process.name().to_string_lossy().to_string(),
                exe_path:       exe,
                command_line:   cmd,
                user:           String::new(), // populated below
                cpu_usage:      process.cpu_usage(),
                mem_working_kb: mem_working / 1024,
                mem_private_kb: mem_virtual / 1024,
                threads:        process.tasks().map(|t| t.len() as u32).unwrap_or(0),
                handles:        0, // populated below
                start_time,
                run_secs,
                status:         format!("{:?}", process.status()),
                elevated:       false, // populated below
                disk_read_kb_s:  rd_rate,
                disk_write_kb_s: wr_rate,
            }
        })
        .collect();

    drop(io_snapshots);
    drop(sys);

    // Populate Win32-only fields (user, handles, elevation, threads) per
    // process. Best-effort — protected processes (csrss, System, etc.) will
    // return None for some of these; we leave the field empty in that case.
    //
    // PERFORMANCE: username lookup is per-process and cached. Handle count
    // and elevation are per-process and dynamic. Thread counts are obtained
    // in a single Toolhelp snapshot pass before the loop, so we just look
    // them up by pid (O(1) per process).
    #[cfg(windows)]
    {
        // Single-pass thread-count enumeration. Replaces sysinfo's
        // `process.tasks().len()` which returns None on Windows in our
        // sysinfo build configuration (was the cause of "0 threads" in the
        // overview card and "—" in the Threads column).
        let thread_counts = get_all_thread_counts();

        let mut user_cache = state.user_cache.lock()
            .map_err(|e| format!("user_cache lock poisoned: {e}"))?;
        // Drop dead-process cache entries
        user_cache.retain(|pid, _| live_pids.contains(pid));

        for p in procs.iter_mut() {
            // Username — cache by PID since it doesn't change after process
            // creation. Lookup is the expensive Win32 call.
            if let Some(cached) = user_cache.get(&p.pid) {
                p.user = cached.clone();
            } else if let Some(u) = get_process_username(p.pid) {
                user_cache.insert(p.pid, u.clone());
                p.user = u;
            }

            // Handle count is dynamic, can't cache. But it's still per-call
            // expensive (~0.5ms each); we do it for every process.
            if let Some(h) = get_process_handle_count(p.pid) {
                p.handles = h;
            }

            // Elevation. Doesn't change after process start; cache via tag
            // appended to user_cache value would conflate with username.
            // Just always query — same cost as handle count.
            if let Some(e) = get_process_elevated(p.pid) {
                p.elevated = e;
            }

            // Thread count from the toolhelp snapshot. Free lookup — just
            // a HashMap get. Falls through to whatever sysinfo gave us
            // (typically 0) if the snapshot didn't include this PID.
            if let Some(&n) = thread_counts.get(&p.pid) {
                p.threads = n;
            }
        }
    }

    procs.sort_by(|a, b| {
        b.cpu_usage.partial_cmp(&a.cpu_usage)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(procs)
}

#[tauri::command]
#[cfg(windows)]
fn kill_process(pid: u32) -> Result<(), String> {
    log_warn!("ipc::kill_process", "pid={}", pid);
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid)
            .map_err(|e| format!("OpenProcess failed: {e}"))?;
        let ok = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        ok.map_err(|e| format!("TerminateProcess failed: {e}"))
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn kill_process(_pid: u32) -> Result<(), String> { Err("Windows only".into()) }

// ── Kill process tree (Phase 5+) ────────────────────────────────────────────
// Kills the target process AND all of its descendants (children, grandchildren,
// etc.). Useful for build/dev scenarios where parent processes spawn many
// children that wouldn't be cleaned up by a single kill.
//
// Implementation: BFS from the root PID using sysinfo's parent->child
// relationships (refreshed on the same call so we get an up-to-date view).
// We collect the descendant PIDs first, then issue terminate calls — in
// reverse depth order so children die before parents (gives parents a
// chance to clean up their own bookkeeping; not strictly required but
// reduces zombie warnings in event logs).
//
// Returns the number of processes that were terminated (best-effort —
// if some kills fail due to access denied, we still report the count
// of successful ones and a list of failure messages).
#[derive(serde::Serialize)]
struct TreeKillReport {
    killed:   u32,
    failed:   Vec<String>,
    pids:     Vec<u32>,   // every PID we attempted, in kill order
}

#[tauri::command]
#[cfg(windows)]
fn kill_process_tree(pid: u32, state: State<AppState>) -> Result<TreeKillReport, String> {
    log_warn!("ipc::kill_process_tree", "root_pid={}", pid);

    // Build child→pids map from a fresh sysinfo snapshot. We use the sysinfo
    // already-held in AppState (don't allocate a new one — it'd lose the CPU
    // delta state for the GUI's next refresh).
    let mut sys = state.sysinfo.lock()
        .map_err(|e| format!("sysinfo lock poisoned: {e}"))?;
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut children_of: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (cpid, proc) in sys.processes() {
        if let Some(parent) = proc.parent() {
            children_of.entry(parent.as_u32())
                .or_insert_with(Vec::new)
                .push(cpid.as_u32());
        }
    }
    drop(sys);

    // BFS to collect every descendant. Track visited to guard against cycles
    // (shouldn't happen in a well-formed process tree, but handle it
    // defensively rather than infinite-looping).
    let mut to_kill: Vec<u32> = Vec::new();
    let mut visited: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<u32> = std::collections::VecDeque::new();
    queue.push_back(pid);
    visited.insert(pid);
    while let Some(cur) = queue.pop_front() {
        to_kill.push(cur);
        if let Some(kids) = children_of.get(&cur) {
            for k in kids {
                if visited.insert(*k) {
                    queue.push_back(*k);
                }
            }
        }
    }
    // Reverse so leaves die first.
    to_kill.reverse();
    log_info!("ipc::kill_process_tree", "tree size = {} processes", to_kill.len());

    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let mut killed = 0u32;
    let mut failed: Vec<String> = Vec::new();
    let pids_attempted = to_kill.clone();

    for cpid in to_kill {
        unsafe {
            match OpenProcess(PROCESS_TERMINATE, false, cpid) {
                Ok(handle) => {
                    let term_result = TerminateProcess(handle, 1);
                    let _ = CloseHandle(handle);
                    match term_result {
                        Ok(_)  => killed += 1,
                        Err(e) => failed.push(format!("PID {}: {}", cpid, e)),
                    }
                }
                Err(e) => failed.push(format!("PID {}: OpenProcess: {}", cpid, e)),
            }
        }
    }

    Ok(TreeKillReport {
        killed,
        failed,
        pids: pids_attempted,
    })
}
#[tauri::command]
#[cfg(not(windows))]
fn kill_process_tree(_pid: u32, _state: State<AppState>) -> Result<TreeKillReport, String> { Err("Windows only".into()) }

// ── Set process CPU affinity (Phase 5+) ─────────────────────────────────────
// Pins a process to a subset of CPU cores via SetProcessAffinityMask. The
// mask is a bitfield where bit N == 1 means core N is allowed. Passing a
// mask of 0 fails — we reject this in the IPC because it's a programming
// error (would orphan the process from all CPUs).
//
// Maximum supported core count: 64 (mask is u64). Almost all client systems
// are well under that; high-core servers > 64 cores need processor groups
// which is a much bigger surface and not exposed here.
#[tauri::command]
#[cfg(windows)]
fn set_process_affinity(pid: u32, mask: u64) -> Result<(), String> {
    log_warn!("ipc::set_process_affinity", "pid={} mask=0x{:X}", pid, mask);
    if mask == 0 {
        return Err("Affinity mask cannot be zero — process would have no CPUs to run on".into());
    }
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, SetProcessAffinityMask,
        PROCESS_SET_INFORMATION, PROCESS_QUERY_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION,
            false, pid,
        ).map_err(|e| format!("OpenProcess failed: {e}"))?;
        let r = SetProcessAffinityMask(h, mask as usize);
        let _ = CloseHandle(h);
        r.map_err(|e| format!("SetProcessAffinityMask failed: {e}"))
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn set_process_affinity(_pid: u32, _mask: u64) -> Result<(), String> { Err("Windows only".into()) }

// ── Get system CPU core count (Phase 5+) ────────────────────────────────────
// Used by the Affinity dialog to render a checkbox per core. We use sysinfo's
// list rather than GetSystemInfo to stay consistent with the rest of the app.
#[tauri::command]
fn get_cpu_count(state: State<AppState>) -> Result<u32, String> {
    let sys = state.sysinfo.lock()
        .map_err(|e| format!("sysinfo lock poisoned: {e}"))?;
    Ok(sys.cpus().len() as u32)
}

// ── System-wide overview (1.14.2) ───────────────────────────────────────────
// Returns true system-level metrics, NOT the sum of per-process values. Used
// by the Process Manager overview cards.
//
// Why this exists: previously the frontend computed "Total CPU" by summing
// `cpu_usage` across every ProcessInfo. On Windows, sysinfo reports per-process
// CPU as % of one core, so summing on a 16-core machine could show 1600%
// before any normalization. Total Memory was the sum of working sets, which
// double-counts shared/copy-on-write pages and overstates real usage.
//
// This IPC returns the proper aggregates:
//   • cpu_pct: 0..100 — fraction of total CPU capacity in use, regardless
//     of core count.
//   • mem_used_bytes / mem_total_bytes — physical memory actually in use vs.
//     installed RAM (matches what Task Manager calls "In use").
//   • cpu_count — convenience so the frontend doesn't need a separate call.
#[derive(serde::Serialize, Clone)]
struct SystemOverview {
    cpu_pct:         f32,
    mem_used_bytes:  u64,
    mem_total_bytes: u64,
    cpu_count:       u32,
}

#[tauri::command]
fn get_system_overview(state: State<AppState>) -> Result<SystemOverview, String> {
    let mut sys = state.sysinfo.lock()
        .map_err(|e| format!("sysinfo lock poisoned: {e}"))?;

    // sysinfo requires two samples to compute CPU usage. We do TWO refreshes
    // ~250ms apart on the very first call, then one refresh per subsequent
    // call. The frontend polls this every 1.5s, so steady-state cost is just
    // the single refresh. The 250ms delay only happens once per app session.
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    // System-wide CPU usage: average of per-core values from sys.cpus().
    // Each core's cpu_usage() is documented as 0..100, so averaging gives a
    // 0..100 system-wide value. We use this rather than sysinfo's
    // global_cpu_usage() because the latter's existence varies across
    // 0.31/0.32/0.33 patch versions of sysinfo, but cpus() is stable.
    //
    // 1.14.3 hardening: defensive against per-core values that exceed 100.
    // Reports from the field showed system overview displaying 299%, which
    // means at least one of:
    //   (a) cpu_usage() returned >100 for some cores (unusual but seen with
    //       hyperthreaded cores under specific scheduler conditions),
    //   (b) the iteration produced more entries than the physical core
    //       count (sysinfo bug? phantom cores?),
    //   (c) the user's binary predated the clamp().
    // Belt-and-braces: clamp PER-CORE before summing (caps each entry at
    // 100), then average, then re-clamp. Any single bad reading can no
    // longer push the average above 100.
    let cpus = sys.cpus();
    let cpu_count = cpus.len() as u32;
    let cpu_pct = if cpus.is_empty() {
        0.0
    } else {
        let sum: f32 = cpus.iter()
            .map(|c| c.cpu_usage().clamp(0.0, 100.0))
            .sum();
        sum / cpu_count.max(1) as f32
    };
    let cpu_pct = cpu_pct.clamp(0.0, 100.0);

    if cpu_pct > 99.5 || cpus.iter().any(|c| c.cpu_usage() > 100.0) {
        // Diagnostic — happens if sysinfo emits a bogus per-core reading.
        // Logs at debug so it's only visible when WINTASKPRO_LOG_LEVEL=DEBUG
        // and doesn't spam the default INFO log.
        log_debug!("get_system_overview",
            "cpu reading extreme: avg={:.1}% per_core={:?}",
            cpu_pct,
            cpus.iter().map(|c| c.cpu_usage()).collect::<Vec<_>>());
    }

    Ok(SystemOverview {
        cpu_pct,
        mem_used_bytes:  sys.used_memory(),
        mem_total_bytes: sys.total_memory(),
        cpu_count,
    })
}

// ── Suspend / Resume process (Phase 5) ──────────────────────────────────────
// Uses NtSuspendProcess / NtResumeProcess from ntdll. These are documented
// well enough for our purposes despite being technically NT private API —
// Process Hacker, Process Explorer, and basically every process manager
// uses them. Win32 doesn't expose a process-level suspend; only thread-level
// SuspendThread which would require enumerating all threads.
#[tauri::command]
#[cfg(windows)]
fn suspend_process(pid: u32) -> Result<(), String> {
    log_warn!("ipc::suspend_process", "pid={}", pid);
    use windows::Win32::Foundation::{CloseHandle, NTSTATUS};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SUSPEND_RESUME,
    };
    type NtSuspendProcessFn = unsafe extern "system" fn(windows::Win32::Foundation::HANDLE) -> NTSTATUS;
    unsafe {
        let h = OpenProcess(PROCESS_SUSPEND_RESUME, false, pid)
            .map_err(|e| format!("OpenProcess failed: {e}"))?;

        // Resolve NtSuspendProcess from ntdll
        use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
        let ntdll = GetModuleHandleA(windows::core::s!("ntdll.dll"))
            .map_err(|e| { let _ = CloseHandle(h); format!("ntdll.dll: {e}") })?;
        let proc_addr = GetProcAddress(ntdll, windows::core::s!("NtSuspendProcess"));
        let func = match proc_addr {
            Some(p) => std::mem::transmute::<_, NtSuspendProcessFn>(p),
            None => { let _ = CloseHandle(h); return Err("NtSuspendProcess not found".into()); }
        };
        let status = func(h);
        let _ = CloseHandle(h);
        if status.0 < 0 {
            Err(format!("NtSuspendProcess failed: 0x{:08X}", status.0 as u32))
        } else {
            Ok(())
        }
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn suspend_process(_pid: u32) -> Result<(), String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn resume_process(pid: u32) -> Result<(), String> {
    log_warn!("ipc::resume_process", "pid={}", pid);
    use windows::Win32::Foundation::{CloseHandle, NTSTATUS};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SUSPEND_RESUME,
    };
    type NtResumeProcessFn = unsafe extern "system" fn(windows::Win32::Foundation::HANDLE) -> NTSTATUS;
    unsafe {
        let h = OpenProcess(PROCESS_SUSPEND_RESUME, false, pid)
            .map_err(|e| format!("OpenProcess failed: {e}"))?;
        use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
        let ntdll = GetModuleHandleA(windows::core::s!("ntdll.dll"))
            .map_err(|e| { let _ = CloseHandle(h); format!("ntdll.dll: {e}") })?;
        let proc_addr = GetProcAddress(ntdll, windows::core::s!("NtResumeProcess"));
        let func = match proc_addr {
            Some(p) => std::mem::transmute::<_, NtResumeProcessFn>(p),
            None => { let _ = CloseHandle(h); return Err("NtResumeProcess not found".into()); }
        };
        let status = func(h);
        let _ = CloseHandle(h);
        if status.0 < 0 {
            Err(format!("NtResumeProcess failed: 0x{:08X}", status.0 as u32))
        } else {
            Ok(())
        }
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn resume_process(_pid: u32) -> Result<(), String> { Err("Windows only".into()) }

// ── Set process priority class (Phase 5) ────────────────────────────────────
// Maps a 0-5 integer to a Win32 PRIORITY_CLASS:
//   0 = Idle              (IDLE_PRIORITY_CLASS)
//   1 = Below Normal      (BELOW_NORMAL_PRIORITY_CLASS)
//   2 = Normal            (NORMAL_PRIORITY_CLASS)         ← default
//   3 = Above Normal      (ABOVE_NORMAL_PRIORITY_CLASS)
//   4 = High              (HIGH_PRIORITY_CLASS)
//   5 = Realtime          (REALTIME_PRIORITY_CLASS)       ← requires admin, dangerous
// Returns the previously-set priority class as a string label.
#[tauri::command]
#[cfg(windows)]
fn set_process_priority(pid: u32, priority: u8) -> Result<String, String> {
    log_warn!("ipc::set_process_priority", "pid={} priority={}", pid, priority);
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, PROCESS_SET_INFORMATION,
        IDLE_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS,
        NORMAL_PRIORITY_CLASS, ABOVE_NORMAL_PRIORITY_CLASS,
        HIGH_PRIORITY_CLASS, REALTIME_PRIORITY_CLASS,
        PROCESS_CREATION_FLAGS,
    };
    let (cls, label) = match priority {
        0 => (IDLE_PRIORITY_CLASS,         "Idle"),
        1 => (BELOW_NORMAL_PRIORITY_CLASS, "Below Normal"),
        2 => (NORMAL_PRIORITY_CLASS,       "Normal"),
        3 => (ABOVE_NORMAL_PRIORITY_CLASS, "Above Normal"),
        4 => (HIGH_PRIORITY_CLASS,         "High"),
        5 => (REALTIME_PRIORITY_CLASS,     "Realtime"),
        _ => return Err(format!("Invalid priority value: {}", priority)),
    };
    unsafe {
        let h = OpenProcess(PROCESS_SET_INFORMATION, false, pid)
            .map_err(|e| format!("OpenProcess failed: {e}"))?;
        let result = SetPriorityClass(h, PROCESS_CREATION_FLAGS(cls.0));
        let _ = CloseHandle(h);
        result.map_err(|e| format!("SetPriorityClass failed: {e}"))?;
    }
    Ok(label.to_string())
}
#[tauri::command]
#[cfg(not(windows))]
fn set_process_priority(_pid: u32, _priority: u8) -> Result<String, String> { Err("Windows only".into()) }

// ── Get loaded modules (DLLs) for a process (Phase 5) ───────────────────────
// Uses CreateToolhelp32Snapshot with TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32
// to enumerate every DLL the process has loaded. Useful for forensic analysis
// (does this innocent-looking process load suspicious DLLs?).
//
// Returns a list of (module_name, module_path, base_addr_hex, size_bytes).
// Capped at 500 modules — even Chrome with 100 tabs typically loads <300.
#[derive(serde::Serialize)]
struct ModuleInfo {
    name:      String,
    path:      String,
    base_addr: String,  // hex string for display
    size:      u32,
}

#[tauri::command]
#[cfg(windows)]
fn get_process_modules(pid: u32) -> Result<Vec<ModuleInfo>, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW,
        MODULEENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(
            TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32,
            pid,
        ).map_err(|e| format!("CreateToolhelp32Snapshot failed: {e}"))?;

        let mut entry = MODULEENTRY32W {
            dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
            ..Default::default()
        };

        let mut modules = Vec::new();
        if Module32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name_len = entry.szModule.iter().position(|&c| c == 0).unwrap_or(entry.szModule.len());
                let path_len = entry.szExePath.iter().position(|&c| c == 0).unwrap_or(entry.szExePath.len());

                modules.push(ModuleInfo {
                    name:      String::from_utf16_lossy(&entry.szModule[..name_len]),
                    path:      String::from_utf16_lossy(&entry.szExePath[..path_len]),
                    base_addr: format!("0x{:016X}", entry.modBaseAddr as usize),
                    size:      entry.modBaseSize,
                });
                if modules.len() >= 500 { break; }
                if Module32NextW(snapshot, &mut entry).is_err() { break; }
            }
        }
        let _ = CloseHandle(snapshot);
        Ok(modules)
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn get_process_modules(_pid: u32) -> Result<Vec<ModuleInfo>, String> { Err("Windows only".into()) }

// ── Open file location for a process (Phase 5) ──────────────────────────────
// Opens Explorer with the process's exe selected. Frontend uses this for the
// "Open file location" right-click action.
#[tauri::command]
#[cfg(windows)]
fn open_file_location(path: String) -> Result<(), String> {
    // Pattern matches the open_in_browser fn below (line ~1727) which has
    // compiled cleanly since v1.8.0. Earlier draft used `HSTRING` here but
    // ShellExecuteW's parameters are `PCWSTR` in windows = 0.61, and the
    // `&HSTRING → PCWSTR` conversion is not automatic across all 0.61.x
    // patches. Use the explicit Vec<u16> + PCWSTR pattern that's known to
    // build, instead of relying on a trait conversion that may not exist.
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // SECURITY: reject embedded double quotes so the path cannot break out of
    // the /select,"<path>" quoting and inject additional explorer.exe switches.
    if path.contains('"') {
        return Err("Path contains an unsupported character (\")".into());
    }
    // Build the parameter string Explorer expects: `/select,"<path>"`
    // The quotes are literal characters in the wide buffer — they survive
    // the round-trip into Explorer's argv parser.
    let params_str = format!("/select,\"{}\"", path);
    let params_wide: Vec<u16> = params_str.encode_utf16().chain(std::iter::once(0)).collect();
    let app_wide:    Vec<u16> = "explorer.exe".encode_utf16().chain(std::iter::once(0)).collect();
    // Verb null = use the default action ("open" for explorer.exe)

    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR::null(),
            PCWSTR(app_wide.as_ptr()),
            PCWSTR(params_wide.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns a value > 32 on success per MSDN
    if (result.0 as isize) > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecuteW failed ({})", result.0 as isize))
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn open_file_location(_path: String) -> Result<(), String> { Err("Windows only".into()) }

// ── Network connections owned by a process (Phase 5) ────────────────────────
// Uses GetExtendedTcpTable / GetExtendedUdpTable to map (local_addr, port)
// pairs to owning PIDs. We filter to entries owned by the requested PID.
//
// Returns connections with state (Listening, Established, etc.) for TCP;
// UDP is connectionless so just shows the bound address/port.
#[derive(serde::Serialize, Clone)]
struct NetConnection {
    protocol:    String,    // "TCP" or "UDP"
    local_addr:  String,
    local_port:  u16,
    remote_addr: String,    // empty for UDP / listening TCP
    remote_port: u16,
    state:       String,    // "LISTENING", "ESTABLISHED", etc; empty for UDP
}

#[tauri::command]
#[cfg(windows)]
fn get_process_connections(pid: u32) -> Result<Vec<NetConnection>, String> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable,
        TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
        MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    let mut connections = Vec::new();

    unsafe {
        // ── TCP ──────────────────────────────────────────────────────────
        let mut tcp_size: u32 = 0;
        let _ = GetExtendedTcpTable(
            None, &mut tcp_size, false, AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL, 0,
        );
        if tcp_size > 0 {
            let mut tcp_buf = vec![0u8; tcp_size as usize];
            let result = GetExtendedTcpTable(
                Some(tcp_buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut tcp_size, false, AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL, 0,
            );
            if result == 0 {
                let table = &*(tcp_buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    &table.table[0] as *const MIB_TCPROW_OWNER_PID,
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    if row.dwOwningPid != pid { continue; }
                    let local_addr = format_ipv4(row.dwLocalAddr);
                    let remote_addr = if row.dwRemoteAddr == 0 { String::new() } else { format_ipv4(row.dwRemoteAddr) };
                    let local_port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
                    let remote_port = u16::from_be((row.dwRemotePort & 0xFFFF) as u16);
                    let state = match row.dwState {
                        1 => "CLOSED",      2 => "LISTENING", 3 => "SYN_SENT",
                        4 => "SYN_RCVD",    5 => "ESTABLISHED", 6 => "FIN_WAIT1",
                        7 => "FIN_WAIT2",   8 => "CLOSE_WAIT", 9 => "CLOSING",
                        10 => "LAST_ACK",   11 => "TIME_WAIT", 12 => "DELETE_TCB",
                        _ => "UNKNOWN",
                    };
                    connections.push(NetConnection {
                        protocol: "TCP".into(),
                        local_addr, local_port,
                        remote_addr, remote_port: if state == "LISTENING" { 0 } else { remote_port },
                        state: state.to_string(),
                    });
                }
            }
        }

        // ── UDP ──────────────────────────────────────────────────────────
        let mut udp_size: u32 = 0;
        let _ = GetExtendedUdpTable(
            None, &mut udp_size, false, AF_INET.0 as u32,
            UDP_TABLE_OWNER_PID, 0,
        );
        if udp_size > 0 {
            let mut udp_buf = vec![0u8; udp_size as usize];
            let result = GetExtendedUdpTable(
                Some(udp_buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut udp_size, false, AF_INET.0 as u32,
                UDP_TABLE_OWNER_PID, 0,
            );
            if result == 0 {
                let table = &*(udp_buf.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    &table.table[0] as *const MIB_UDPROW_OWNER_PID,
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    if row.dwOwningPid != pid { continue; }
                    let local_addr = format_ipv4(row.dwLocalAddr);
                    let local_port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
                    connections.push(NetConnection {
                        protocol: "UDP".into(),
                        local_addr, local_port,
                        remote_addr: String::new(), remote_port: 0,
                        state: String::new(),
                    });
                }
            }
        }
    }

    Ok(connections)
}
#[tauri::command]
#[cfg(not(windows))]
fn get_process_connections(_pid: u32) -> Result<Vec<NetConnection>, String> { Err("Windows only".into()) }

#[cfg(windows)]
fn format_ipv4(addr: u32) -> String {
    let octets = addr.to_le_bytes();
    format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3])
}

// ── Find process by port (Phase 5) ──────────────────────────────────────────
// "What process is using port 8080?" — invaluable for debugging port
// conflicts. Walks the TCP+UDP tables looking for any owner of that port.
#[tauri::command]
#[cfg(windows)]
fn find_process_by_port(port: u16) -> Result<Vec<u32>, String> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable,
        TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
        MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    let mut owners = Vec::new();
    unsafe {
        // TCP
        let mut tcp_size: u32 = 0;
        let _ = GetExtendedTcpTable(None, &mut tcp_size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0);
        if tcp_size > 0 {
            let mut tcp_buf = vec![0u8; tcp_size as usize];
            if GetExtendedTcpTable(
                Some(tcp_buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut tcp_size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0,
            ) == 0 {
                let table = &*(tcp_buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    &table.table[0] as *const MIB_TCPROW_OWNER_PID,
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    let lp = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
                    if lp == port && !owners.contains(&row.dwOwningPid) {
                        owners.push(row.dwOwningPid);
                    }
                }
            }
        }
        // UDP
        let mut udp_size: u32 = 0;
        let _ = GetExtendedUdpTable(None, &mut udp_size, false, AF_INET.0 as u32, UDP_TABLE_OWNER_PID, 0);
        if udp_size > 0 {
            let mut udp_buf = vec![0u8; udp_size as usize];
            if GetExtendedUdpTable(
                Some(udp_buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut udp_size, false, AF_INET.0 as u32, UDP_TABLE_OWNER_PID, 0,
            ) == 0 {
                let table = &*(udp_buf.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
                let rows = std::slice::from_raw_parts(
                    &table.table[0] as *const MIB_UDPROW_OWNER_PID,
                    table.dwNumEntries as usize,
                );
                for row in rows {
                    let lp = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
                    if lp == port && !owners.contains(&row.dwOwningPid) {
                        owners.push(row.dwOwningPid);
                    }
                }
            }
        }
    }
    Ok(owners)
}
#[tauri::command]
#[cfg(not(windows))]
fn find_process_by_port(_port: u16) -> Result<Vec<u32>, String> { Err("Windows only".into()) }


// ── Open URL in system browser ────────────────────────────────────────────────
// Used by the in-app update banner to open the GitHub release page.
// No plugin needed — just ShellExecuteW with the URL as the file argument.
#[tauri::command]
#[cfg(windows)]
fn open_in_browser(url: String) -> Result<(), String> {
    // SECURITY: Restrict to http/https only — ShellExecuteW will happily execute
    // file:// paths, .bat files, and arbitrary executables if given a filesystem
    // path. This guard prevents XSS-to-IPC from running arbitrary programs.
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("Blocked: only http/https URLs are permitted (got: {})",
            url.chars().take(80).collect::<String>()));
    }
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    // Encode with null terminator for PCWSTR
    let url_wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    // Use null verb — ShellExecuteW defaults to "open" which is what we want,
    // and avoids the embedded-null string literal anti-pattern.
    let result = unsafe {
        ShellExecuteW(None, PCWSTR::null(),
                      PCWSTR(url_wide.as_ptr()), PCWSTR::null(),
                      PCWSTR::null(), SW_SHOWNORMAL)
    };
    if (result.0 as isize) <= 32 {
        Err(format!("ShellExecuteW failed ({})", result.0 as isize))
    } else {
        Ok(())
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn open_in_browser(_url: String) -> Result<(), String> { Err("Windows only".into()) }

// ── Admin elevation ───────────────────────────────────────────────────────────
#[tauri::command]
fn is_admin() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() { return false; }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret_len   = 0u32;
        let ok = GetTokenInformation(
            token, TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
    #[cfg(not(windows))]
    { false }
}


// ── Dev mode detection ────────────────────────────────────────────────────────
#[tauri::command]
fn is_dev() -> bool { cfg!(debug_assertions) }

// ── Flash taskbar (native "look at me" signal) ──────────────────────────────
// Browser Notification API is blocked in WebView2 by default — there's no
// graceful way to override that without registering an MSIX manifest or
// adopting tauri-plugin-notification. As a portable, no-permissions
// alternative we use Tauri's request_user_attention which wraps Win32
// FlashWindowEx on Windows: the taskbar icon flashes orange to draw the
// user's attention. Standard Windows convention for "background app needs
// you to look at it" since Windows 95.
//
// Used by:
//   - Test Notification button in Settings (sanity check)
//   - Future task-failure notification path (replaces browser API)
//
// On non-Windows: tauri's request_user_attention is a no-op or platform
// equivalent — fail soft.
#[tauri::command]
fn flash_taskbar(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    win.request_user_attention(Some(tauri::UserAttentionType::Informational))
        .map_err(|e| format!("request_user_attention failed: {e}"))?;
    log_debug!("ipc::flash_taskbar", "taskbar flashed");
    Ok(())
}

// ── Restart as Administrator ──────────────────────────────────────────────
// Re-launches the exe with the Windows runas verb so UAC prompts for elevation.
// The dev server continues running. Simple ShellExecuteW.
#[tauri::command]
fn restart_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    log_warn!("ipc::restart_as_admin", "elevation requested");
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        use std::os::windows::ffi::OsStrExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_wide: Vec<u16> = exe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let verb: Vec<u16>     = "runas".encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(exe_wide.as_ptr()),
                          PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
        };
        if (result.0 as isize) <= 32 {
            return Err(format!("ShellExecuteW failed with code {}", result.0 as isize));
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = app; Err("Windows only".into()) }
}

// ── Browse dialogs ────────────────────────────────────────────────────────────
#[tauri::command]
#[cfg(windows)]
fn browse_for_file(filter: String) -> Result<String, String> {
    use windows::Win32::UI::Controls::Dialogs::{GetOpenFileNameW, OPENFILENAMEW, OFN_FILEMUSTEXIST, OFN_PATHMUSTEXIST};
    use windows::core::PCWSTR;
    let raw_filter: Vec<u16> = if filter.is_empty() {
        "All Files (*.*)\0*.*\0\0".encode_utf16().collect()
    } else {
        let mut v: Vec<u16> = filter.encode_utf16().collect();
        while v.last().copied() == Some(0) { v.pop(); }
        v.push(0); v.push(0); v
    };
    let mut file_buf: Vec<u16> = vec![0u16; 32768];
    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        lpstrFilter: PCWSTR(raw_filter.as_ptr()),
        nFilterIndex: 1,
        lpstrFile: windows::core::PWSTR(file_buf.as_mut_ptr()),
        nMaxFile: file_buf.len() as u32,
        Flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST,
        ..Default::default()
    };
    if unsafe { GetOpenFileNameW(&mut ofn).as_bool() } {
        let end = file_buf.iter().position(|&c| c == 0).unwrap_or(file_buf.len());
        Ok(String::from_utf16_lossy(&file_buf[..end]))
    } else {
        Err("cancelled".into())
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn browse_for_file(_filter: String) -> Result<String, String> { Err("Windows only".into()) }

#[tauri::command]
#[cfg(windows)]
fn browse_for_folder() -> Result<String, String> {
    use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH, FOS_PICKFOLDERS};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    // CoUninitialize is referenced by its full path inside ComGuard::drop()
    // (inner item impls don't see the enclosing function's use statements).

    // RAII guard: calls CoUninitialize() when dropped, but only if we own the init.
    // This guarantees cleanup in all exit paths including early returns via `?`.
    // Must be a local struct because Drop on a type-alias is not allowed in Rust.
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) {
            // CoUninitialize is unsafe — explicit block required inside a safe fn.
            if self.0 { unsafe { windows::Win32::System::Com::CoUninitialize(); } }
        }
    }

    unsafe {
        // S_OK (.0 == 0)  → we own this apartment; guard must uninitialise.
        // S_FALSE or RPC_E_CHANGED_MODE → already initialised; do NOT uninitialise.
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _guard = ComGuard(hr.0 == 0);

        // All COM calls are inside the same unsafe{} block as CoInitializeEx —
        // no closure needed, so no "calling unsafe fn in safe context" ambiguity.
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_ALL)
            .map_err(|e| e.to_string())?;
        let mut options = dialog.GetOptions().map_err(|e| e.to_string())?;
        options |= FOS_PICKFOLDERS;
        dialog.SetOptions(options).map_err(|e| e.to_string())?;
        if dialog.Show(None).is_err() { return Err("cancelled".into()); }
        let item  = dialog.GetResult().map_err(|e| e.to_string())?;
        let pwstr = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|e| e.to_string())?;
        // _guard dropped here → CoUninitialize() called if we own the init
        pwstr.to_string().map_err(|_| "Failed to convert folder path".to_string())
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn browse_for_folder() -> Result<String, String> { Err("Windows only".into()) }

// ── Entry point ───────────────────────────────────────────────────────────────

// ── Logging IPC commands ──────────────────────────────────────────────────────
// All four are safe to call from JS; none require Windows-specific deps.

#[tauri::command]
fn log_event(level: String, target: String, message: String) {
    // Mirrors a JS-side log line into the same file the Rust side writes to.
    // JS calls this via the dlog() helper in app.js so frontend and backend
    // events appear interleaved in chronological order in the log file.
    let lvl = devlog::Level::from_str(&level);
    devlog::log_line(lvl, &target, &message);
}

#[tauri::command]
fn set_log_level(level: String) -> Result<(), String> {
    let lvl = devlog::Level::from_str(&level);
    devlog::set_level(lvl)
}

#[tauri::command]
fn get_log_level() -> String {
    devlog::get_level().label().trim().to_string()
}

#[tauri::command]
fn get_log_tail(lines: Option<usize>) -> Vec<String> {
    devlog::read_tail(lines.unwrap_or(200))
}

#[tauri::command]
fn open_logs_folder() -> Result<String, String> {
    let dir = devlog::logs_dir().ok_or_else(|| "log directory unavailable".to_string())?;
    let path_str = dir.to_string_lossy().to_string();

    // Open in Explorer on Windows; on other platforms (dev), just return the path.
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::ffi::OsStr;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        use windows::core::PCWSTR;

        let wide: Vec<u16> = OsStr::new(&path_str)
            .encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            // open verb (default action for a folder = Explorer).
            let _ = ShellExecuteW(
                None,
                PCWSTR::null(),
                PCWSTR(wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            );
        }
        log_info!("ipc::open_logs_folder", "opened {}", path_str);
    }
    Ok(path_str)
}

#[tauri::command]
fn get_log_file_path() -> Option<String> {
    devlog::log_file_path().map(|p| p.to_string_lossy().to_string())
}

// ── Update failure marker ─────────────────────────────────────────────────────
// The swap helper writes to %LOCALAPPDATA%\WinTaskPro\update_failed.txt when
// any step of the in-place update fails. The frontend reads this on boot — if
// present, it shows a "previous update failed" banner with the contents so
// the user can immediately see WHY without having to dig through filesystem.
//
// This is the missing diagnostic loop: 1.8.0's helper could fail silently
// (e.g. blocked by ExecutionPolicy, AV-locked exe) and the user would just
// see "the app didn't update" with no explanation. Surfacing the marker
// closes that loop.
#[cfg(windows)]
fn update_failed_marker_path() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|local| {
        std::path::PathBuf::from(local)
            .join("WinTaskPro")
            .join("update_failed.txt")
    })
}
#[cfg(not(windows))]
fn update_failed_marker_path() -> Option<std::path::PathBuf> { None }

#[derive(serde::Serialize)]
struct UpdateFailureMarker {
    path:     String,
    contents: String,
    /// Last-modified time as ISO-8601 UTC (best-effort; "" if not available)
    modified: String,
}

#[tauri::command]
fn read_update_failed_marker() -> Result<Option<UpdateFailureMarker>, String> {
    let path = match update_failed_marker_path() {
        Some(p) => p,
        None    => return Ok(None),
    };
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("read marker: {e}"))?;
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| {
            // Reuse the same ISO-8601 formatter style devlog uses
            let secs = d.as_secs() as i64;
            let _ms  = d.subsec_millis();
            let days = secs.div_euclid(86_400);
            let sod  = secs.rem_euclid(86_400);
            let h    = sod / 3600;
            let m    = (sod % 3600) / 60;
            let s    = sod % 60;
            // Quick civil-from-days (cribbed from devlog.rs::civil_from_days)
            let z = days + 719468;
            let era = if z >= 0 { z } else { z - 146096 } / 146097;
            let doe = (z - era * 146097) as u64;
            let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
            let y   = yoe as i64 + era * 400;
            let doy = doe - (365*yoe + yoe/4 - yoe/100);
            let mp  = (5*doy + 2) / 153;
            let d   = (doy - (153*mp + 2)/5 + 1) as u32;
            let mo  = if mp < 10 { (mp + 3) as u32 } else { (mp - 9) as u32 };
            let y   = if mo <= 2 { y + 1 } else { y };
            format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, s)
        })
        .unwrap_or_default();

    log_info!("ipc::read_update_failed_marker",
        "marker present | path={} | bytes={} | modified={}",
        path.display(), contents.len(), modified);

    Ok(Some(UpdateFailureMarker {
        path:     path.to_string_lossy().to_string(),
        contents,
        modified,
    }))
}

#[tauri::command]
fn clear_update_failed_marker() -> Result<bool, String> {
    let path = match update_failed_marker_path() {
        Some(p) => p,
        None    => return Ok(false),
    };
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path).map_err(|e| {
        log_error!("ipc::clear_update_failed_marker", "remove failed: {}", e);
        format!("remove marker: {e}")
    })?;
    log_info!("ipc::clear_update_failed_marker", "removed {}", path.display());
    Ok(true)
}

// ── Helper trace file ────────────────────────────────────────────────────────
// The cmd.exe swap helper writes a heartbeat-style trace to
// %LOCALAPPDATA%\WinTaskPro\update_helper.log on every run, OVERWRITING the
// previous run's content. This is distinct from update_failed.txt which is
// append-only and survives across attempts.
//
// Reading this file tells us exactly what the most recent helper attempt did:
// which steps ran, where it stopped, and any error messages from cmd.exe.
// If the file doesn't exist at all, the helper never ran (PowerShell or
// cmd.exe couldn't be spawned, AV killed it before the first echo, etc.).
#[cfg(windows)]
fn update_helper_log_path() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|local| {
        std::path::PathBuf::from(local)
            .join("WinTaskPro")
            .join("update_helper.log")
    })
}
#[cfg(not(windows))]
fn update_helper_log_path() -> Option<std::path::PathBuf> { None }

#[tauri::command]
fn read_update_helper_log() -> Result<Option<String>, String> {
    let path = match update_helper_log_path() {
        Some(p) => p,
        None    => return Ok(None),
    };
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read helper log: {e}"))
}

// ── Log self-test ────────────────────────────────────────────────────────────
// Writes a known marker line to the log, then reads back the last 20 lines
// to confirm the marker is present. This is the simplest possible "are logs
// working" check the frontend can run on demand. Returns the resolved log
// path + whether the round-trip succeeded.
#[derive(serde::Serialize)]
struct LogSelfTestResult {
    log_path:   Option<String>,
    write_ok:   bool,
    read_ok:    bool,
    found_marker: bool,
    /// Last 20 log lines for visual inspection by the user
    recent:     String,
}

#[tauri::command]
fn log_self_test() -> Result<LogSelfTestResult, String> {
    let marker = format!("LOG_SELFTEST_{}", std::process::id());
    log_info!("log_self_test", "marker={}", marker);

    let log_path = devlog::log_file_path().map(|p| p.to_string_lossy().to_string());
    let write_ok = log_path.is_some();

    // Read back the tail to confirm
    let recent_lines = devlog::read_tail(20);
    let recent = recent_lines.join("\n");
    let read_ok = !recent_lines.is_empty();
    let found_marker = recent.contains(&marker);

    log_info!("log_self_test", "write_ok={} read_ok={} found_marker={}",
              write_ok, read_ok, found_marker);

    Ok(LogSelfTestResult {
        log_path,
        write_ok,
        read_ok,
        found_marker,
        recent,
    })
}

// ── Diagnostic snapshot ───────────────────────────────────────────────────────
// Captures a one-shot view of the runtime environment for bug reports.
// Used both at startup (via boot_snapshot) and on-demand from the Settings panel
// "Copy diagnostics" button. Cheap to call — no enumeration of tasks/processes.
#[derive(serde::Serialize)]
struct DiagnosticSnapshot {
    app_version:    &'static str,
    build_profile:  &'static str,
    os:             String,
    os_version:     String,
    kernel_version: String,
    host_name:      String,
    cpu_arch:       String,
    cpu_count:      usize,
    total_memory_mb: u64,
    is_admin:       bool,
    webview2:       Option<String>,
    log_file:       Option<String>,
    log_level:      String,
}

#[tauri::command]
fn get_diagnostic_snapshot(state: State<AppState>) -> Result<DiagnosticSnapshot, String> {
    // sysinfo's System::name/os_version/host_name are static-ish; we don't need
    // a fresh refresh for them. CPU count and total RAM are stable per boot.
    let mut sys = state.sysinfo.lock().map_err(|e| format!("sysinfo lock poisoned: {e}"))?;
    // Refresh memory before reading — sysinfo 0.32's total_memory() returns the
    // value from the last refresh (or 0 if never refreshed). We don't refresh CPU
    // here because cpu_count is only the topology, not the load (which would need
    // a 200ms pause between two refreshes).
    sys.refresh_memory();
    let snap = DiagnosticSnapshot {
        app_version:    env!("CARGO_PKG_VERSION"),
        build_profile:  if cfg!(debug_assertions) { "debug" } else { "release" },
        os:             sysinfo::System::name().unwrap_or_else(|| "unknown".into()),
        os_version:     sysinfo::System::long_os_version().unwrap_or_else(|| "unknown".into()),
        kernel_version: sysinfo::System::kernel_version().unwrap_or_else(|| "unknown".into()),
        host_name:      sysinfo::System::host_name().unwrap_or_else(|| "unknown".into()),
        // sysinfo 0.32: cpu_arch() returns Option<String> (some platforms can't
        // determine it). Fall back to "unknown" so the diagnostic struct stays
        // a flat String shape that's easy to read in bug reports.
        cpu_arch:       sysinfo::System::cpu_arch().unwrap_or_else(|| "unknown".into()),
        cpu_count:      sys.cpus().len(),
        total_memory_mb: sys.total_memory() / 1024 / 1024,
        is_admin:        is_admin(),
        webview2:        webview2_version(),
        log_file:        devlog::log_file_path().map(|p| p.to_string_lossy().to_string()),
        log_level:       devlog::get_level().label().trim().to_string(),
    };
    Ok(snap)
}

// ── Portable in-place auto-update ─────────────────────────────────────────────
// Implements the same portable-self-replace pattern used by sister apps
// (Kura, PS5 Vault). The pattern:
//
//   1. Download the new WinTaskPro.exe from a GitHub release URL to %TEMP%
//   2. Verify it is a real PE file (MZ header + minimum size + signature
//      check is intentionally skipped — see UPDATER.md security notes)
//   3. Write a swap-helper PS script to %TEMP%
//   4. Spawn the helper as a detached process so it survives this exe's exit
//   5. Call app.exit(0) — the helper waits for our PID to die, then
//      Move-Items the new exe over the current one and re-launches it.
//
// Failure modes the helper handles:
//   - Destination locked → retry up to 10 times with 500ms delay
//   - Download bytes don't roundtrip (partial download) → caught by PE check
//   - Helper itself crashes → user sees no relaunch; can run the old exe
//     manually. A marker file in %LOCALAPPDATA%\WinTaskPro\update_failed.txt
//     records why so they can include it in a bug report.
//
// What this command DOES NOT do (by design):
//   - Verify a cryptographic signature on the download. We accept GitHub's
//     HTTPS certificate as the trust anchor. To upgrade to Ed25519 verify,
//     follow the steps in UPDATER.md (Path B/C).
//   - Roll back on failed launch of the new exe. If the new exe crashes on
//     start, we don't know — we've already exited.
#[tauri::command]
#[cfg(windows)]
fn download_and_install_update(url: String, expected_version: String) -> Result<(), String> {
    use std::process::Command;

    log_info!("update::install", "starting | url={} | target_version={}",
              url, expected_version);

    // ── Sanity-check the URL — only trust THIS repo's GitHub Releases ────
    // Defence-in-depth: even though the URL comes from our own checkForUpdate
    // (which itself reads from api.github.com), an XSS-via-WebView attacker
    // could call this IPC directly with a hostile URL. AUDIT FIX 2026-06-11:
    // the previous check pinned only the hostname ("https://github.com/" +
    // contains "/releases/"), which admitted ANY repository's release assets
    // — an attacker-controlled fork would pass and its payload survives the
    // PE format check by construction. The frontend's error diagnosis already
    // told users "the release was published to a fork", assuming this
    // repo-level pin existed. Now it does. checkForUpdate only ever supplies
    // browser_download_url values of the form
    // https://github.com/NookieAI/WinTaskPro/releases/download/<tag>/<asset>
    // so legitimate updates are unaffected.
    if !url.starts_with("https://github.com/NookieAI/WinTaskPro/releases/") {
        log_error!("update::install", "rejected URL outside canonical repo releases: {}", url);
        return Err(format!("Update URL must be a NookieAI/WinTaskPro GitHub release: got {}", url));
    }

    // ── Resolve target paths ──────────────────────────────────────────────
    let cur_exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {e}"))?;
    let cur_exe_str = cur_exe.to_string_lossy().to_string();
    let temp_dir = std::env::temp_dir();
    let new_exe  = temp_dir.join(format!("WinTaskPro_v{}_new.exe", expected_version));
    let new_exe_str = new_exe.to_string_lossy().to_string();
    let swap_script = temp_dir.join("wintaskpro_swap.bat");
    let swap_str    = swap_script.to_string_lossy().to_string();

    log_info!("update::install", "current_exe={} | new_exe={} | swap_script={}",
              cur_exe_str, new_exe_str, swap_str);

    // ── Pre-flight: disk space ────────────────────────────────────────────
    // We need ~30 MB free in %TEMP% to safely stage the download. Bail early
    // with a clear message if the user's temp drive is full — Invoke-WebRequest
    // would otherwise fail mid-download with a cryptic "stream is closed".
    if let Some(free_mb) = temp_free_space_mb(&temp_dir) {
        log_info!("update::install", "temp dir free space: {} MB", free_mb);
        if free_mb < 30 {
            log_error!("update::install", "insufficient disk space: {} MB", free_mb);
            return Err(format!(
                "Not enough free disk space in %TEMP% ({} MB available; 30 MB required). \
                 Free up some space and try again.",
                free_mb
            ));
        }
    }
    // If we couldn't determine free space, proceed and let the download fail
    // with whatever error Invoke-WebRequest produces. The check is best-effort.

    // ── Step 1: Download via PowerShell Invoke-WebRequest ────────────────
    // -UseBasicParsing avoids loading the IE engine (much faster startup).
    // $ProgressPreference='SilentlyContinue' makes Invoke-WebRequest 50× faster
    // because the default progress bar is implemented as an EXTREMELY slow
    // VT100 redraw on each chunk.
    let download_ps = format!(r#"
        $ErrorActionPreference = 'Stop'
        $ProgressPreference    = 'SilentlyContinue'
        try {{
            Invoke-WebRequest -Uri '{url}' -OutFile '{out}' -UseBasicParsing -TimeoutSec 120
            $f = Get-Item -LiteralPath '{out}'
            if ($f.Length -lt 1MB) {{
                throw "Download too small: $($f.Length) bytes"
            }}
            Write-Host "OK $($f.Length)"
            exit 0
        }} catch {{
            Write-Host "ERR $($_.Exception.Message)"
            exit 1
        }}
    "#,
        url = url.replace('\'', "''"),
        out = new_exe_str.replace('\'', "''"),
    );

    log_info!("update::install", "downloading (this can take 30-60s)…");
    use std::os::windows::process::CommandExt;
    let dl_out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
               "-ExecutionPolicy", "Bypass",
               "-Command", &download_ps])
        .creation_flags(0x08000000)  // CREATE_NO_WINDOW — silent download
        .output()
        .map_err(|e| {
            log_error!("update::install", "spawn PowerShell failed: {}", e);
            format!("Could not spawn PowerShell: {e}")
        })?;

    let dl_stdout = String::from_utf8_lossy(&dl_out.stdout).trim().to_string();
    let dl_stderr = String::from_utf8_lossy(&dl_out.stderr).trim().to_string();

    if !dl_out.status.success() || dl_stdout.starts_with("ERR") {
        let msg = if !dl_stdout.is_empty() { dl_stdout } else { dl_stderr };
        log_error!("update::install", "download failed: {}", msg);
        // Best-effort: clean up partial download
        let _ = std::fs::remove_file(&new_exe);
        return Err(format!("Download failed: {msg}"));
    }
    log_info!("update::install", "download ok | {}", dl_stdout);

    // ── Step 2: Verify the file is a real PE binary ──────────────────────
    if let Err(e) = verify_pe_file(&new_exe) {
        log_error!("update::install", "PE verify failed: {}", e);
        let _ = std::fs::remove_file(&new_exe);
        return Err(format!("Downloaded file is not a valid Windows binary: {e}"));
    }
    log_info!("update::install", "PE verification ok");

    // ── Step 3: Write the swap-and-relaunch helper script ────────────────
    if let Err(e) = write_swap_helper(&swap_script) {
        log_error!("update::install", "write swap helper failed: {}", e);
        return Err(format!("Could not write swap script: {e}"));
    }
    log_info!("update::install", "swap helper written");

    // ── Step 4: Spawn the helper as a detached, headless process ─────────
    // 1.9.0 (consolidated): switched from PowerShell to cmd.exe batch script
    //                       because cmd has no ExecutionPolicy concept,
    //                       Defender treats .bat as less suspicious than
    //                       .ps1, and cmd + robocopy is the most
    //                       battle-tested file-replacement primitive on
    //                       Windows.
    // 1.14.2 (silent updater): simplified the spawn invocation.
    //
    // Previously we used:   cmd.exe /C start /B "" cmd.exe /C <script>
    // Now we use:           cmd.exe /C <script>
    //
    // The old form was layered: the outer cmd.exe used `start /B` to
    // launch a second cmd.exe that ran the script. This was meant to
    // belt-and-braces hide the window, but with the spawn flags below
    // already invisible, the `start /B` layer added a third cmd hop and
    // a potential window-flash race during process creation. The simpler
    // form below has fewer moving parts and is verifiably headless.
    //
    // 1.14.3 (real silent updater): dropped DETACHED_PROCESS.
    //
    // Earlier code used `creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)`
    // believing both flags were additive. They aren't — they CONFLICT, and
    // their combination is undefined per Microsoft. Worse, in practice the
    // combination meant the cmd process had no console attached at all.
    // The batch script then runs CONSOLE SUBSYSTEM child programs:
    //
    //   tasklist /FI "PID eq %PARENT_PID%"   ← console subsystem
    //   timeout /t 1 /nobreak                ← console subsystem
    //   robocopy ...                         ← console subsystem
    //
    // Each of these, on finding no console attached to its parent, calls
    // AllocConsole() at startup to allocate one of its OWN. AllocConsole
    // creates a VISIBLE console window. The user sees a brief cmd-style
    // popup for each of these programs during the swap.
    //
    // The fix: use CREATE_NO_WINDOW alone. This gives cmd a console
    // (hidden, attached). Every console-subsystem child program inherits
    // that hidden console. Nothing visible appears.
    //
    // We don't NEED DETACHED_PROCESS for the helper to outlive us. Rust's
    // std::process::Command::spawn() is fire-and-forget on Windows by
    // default — the child is not in a job object that would close with
    // the parent. The helper's tasklist loop polls our PID and proceeds
    // once we're gone (we exit immediately after spawn).
    //
    // The batch script itself ends with `start "" "%CUR_EXE%"` which
    // correctly launches the new (GUI subsystem) exe without a console
    // window. GUI apps spawned via `start` get their own top-level
    // window regardless of whether the parent had a console — so the
    // user sees the new WinTaskPro window come up after the swap, but
    // never sees a cmd window during it.
    // (CommandExt already imported earlier in this fn for the PS download)
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let pid = std::process::id();
    // BUGFIX (cmd-1, HIGH): cmd.exe's /C parser strips the OUTER pair of quotes from
    // the whole command string when it begins with a quote AND contains 2+ quoted
    // tokens. Rust's std quotes every arg that contains a space, so when %TEMP%
    // contains a space — i.e. ANY Windows username with a space, like "John Doe" —
    // BOTH the .bat path and the new-exe path get quoted -> 2+ quoted tokens -> cmd
    // strips the outer quotes and splits the .bat path at its first space
    // ('C:\Users\John' is not recognized as a command). The swap then silently never
    // runs and the update is lost (we exit(0) right after). Reproduced on this box.
    // Fix: build the post-/C string as ONE raw arg wrapped in an EXTRA outer quote
    // pair, so cmd's stripping becomes a no-op and each inner-quoted path survives.
    // Windows paths cannot contain '"', so there is no quote-injection risk.
    let cmd_line = format!(
        "\"\"{}\" {} \"{}\" \"{}\"\"",
        swap_str, pid, new_exe_str, cur_exe_str
    );
    let child = Command::new("cmd.exe")
        .arg("/C")
        .raw_arg(&cmd_line)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    match child {
        Ok(_c) => {
            log_info!("update::install",
                "swap helper spawned | helper waits for pid={} to exit | exiting now", pid);
            // Tiny grace period so the child has time to fully detach and the
            // log line above is flushed before we go.
            std::thread::sleep(std::time::Duration::from_millis(150));
            std::process::exit(0);
            // Never returns
        }
        Err(e) => {
            log_error!("update::install", "spawn swap helper failed: {}", e);
            // Don't leave a downloaded but unused exe behind
            let _ = std::fs::remove_file(&new_exe);
            Err(format!("Could not spawn update helper: {e}"))
        }
    }
}
#[tauri::command]
#[cfg(not(windows))]
fn download_and_install_update(_url: String, _expected_version: String) -> Result<(), String> {
    Err("Windows only".into())
}

// ── PE file sanity check ─────────────────────────────────────────────────────
// The minimal sniff test: real Windows .exe files start with "MZ" (0x4D 0x5A,
// the DOS header), and at offset 0x3C contains a u32 pointing to the PE header
// which begins with "PE\0\0" (0x50 0x45 0x00 0x00). A handful of bytes is enough
// to reject 404 HTML pages, partial downloads, and random non-binary garbage.
// A real signature verification would need a code-signing certificate — see
// UPDATER.md for that upgrade path.
#[cfg(windows)]
fn verify_pe_file(path: &std::path::Path) -> Result<(), String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("open: {e}"))?;
    let len = f.metadata().map_err(|e| format!("metadata: {e}"))?.len();
    if len < 1024 * 1024 {
        return Err(format!("file too small ({} bytes; expected at least 1 MB)", len));
    }
    if len > 200 * 1024 * 1024 {
        // sanity ceiling: WinTaskPro is ~10 MB; refuse anything wildly larger
        return Err(format!("file too large ({} bytes)", len));
    }
    let mut head = [0u8; 0x40];
    f.read_exact(&mut head).map_err(|e| format!("read head: {e}"))?;
    if head[0] != 0x4D || head[1] != 0x5A {
        return Err("missing MZ DOS header".into());
    }
    let pe_offset = u32::from_le_bytes([head[0x3C], head[0x3D], head[0x3E], head[0x3F]]) as u64;
    if pe_offset > len - 4 {
        return Err(format!("PE offset out of range ({})", pe_offset));
    }
    use std::io::{Seek, SeekFrom};
    f.seek(SeekFrom::Start(pe_offset)).map_err(|e| format!("seek: {e}"))?;
    let mut sig = [0u8; 4];
    f.read_exact(&mut sig).map_err(|e| format!("read sig: {e}"))?;
    if sig != [0x50, 0x45, 0x00, 0x00] {
        return Err("missing PE\\0\\0 signature".into());
    }
    Ok(())
}

// ── Disk space helper ────────────────────────────────────────────────────────
// Returns the number of MB available on the volume containing `path`, or None
// if the call fails (fallback: skip the pre-flight check). Uses
// GetDiskFreeSpaceExW which respects per-user quotas — the value reflects what
// the current process can actually write, not raw volume capacity.
#[cfg(windows)]
fn temp_free_space_mb(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_bytes_caller: u64 = 0;
    unsafe {
        if GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_bytes_caller),
            None,
            None,
        ).is_err() {
            return None;
        }
    }
    Some(free_bytes_caller / 1024 / 1024)
}
#[cfg(not(windows))]
fn temp_free_space_mb(_path: &std::path::Path) -> Option<u64> { None }

// ── Swap-and-relaunch helper script writer ───────────────────────────────────
// Writes a cmd.exe batch script that does the in-place swap.
//
// Why batch / cmd.exe instead of PowerShell?
//   - cmd.exe has no ExecutionPolicy concept — AppLocker / Group-Policy
//     restrictions on .ps1 files don't apply.
//   - Batch files spawned by exes are treated less suspiciously by Windows
//     Defender than .ps1 (which is heuristically associated with malware
//     tooling). Fewer SmartScreen interactions.
//   - cmd.exe + robocopy is the most battle-tested file-handling primitive
//     on Windows. Robocopy has built-in retry-on-lock with /R (retries) and
//     /W (wait between retries).
//   - Simpler quoting around paths with parens (e.g. "WinTaskPro(1).exe"
//     created by Edge auto-rename of duplicate downloads).
//
// Steps:
//   1. Wait for parent PID to exit (poll tasklist)
//   2. Wait additional 3 seconds for AV scan-on-write to complete
//   3. Strip Mark-of-the-Web ADS from the new exe (defender:wdac quirk)
//   4. Rename current → .bak (60×1s retry budget = 60s)
//   5. Move new → current location with robocopy (built-in retry)
//   6. On full success: delete marker, launch new exe
//   7. On any failure: roll back to .bak, copy new exe to user's Desktop
//      as fallback, launch the (rolled-back) old exe, write structured
//      marker file
//
// The "copy new exe to Desktop on failure" is new — even if the swap fails,
// the user gets the new version sitting somewhere visible they can run
// directly. They're not stuck waiting for a working auto-update.
#[cfg(windows)]
fn write_swap_helper(path: &std::path::Path) -> Result<(), String> {
    // Args: %1=parent_pid  %2=new_exe_path  %3=current_exe_path
    // The script writes BOTH a structured trace to update_failed.txt AND
    // a heartbeat-style trace to update_helper.log so we can confirm the
    // helper ran AT ALL (separate file = won't be confused with stale
    // marker contents from previous runs).
    let script = r#"@echo off
setlocal enabledelayedexpansion

set PARENT_PID=%~1
set NEW_EXE=%~2
set CUR_EXE=%~3
set BAK_EXE=%CUR_EXE%.bak

set LOG_DIR=%LOCALAPPDATA%\WinTaskPro
set MARKER=%LOG_DIR%\update_failed.txt
set TRACE=%LOG_DIR%\update_helper.log

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

:: Heartbeat trace — overwritten each run so the user (and the IPC) can read
:: the LATEST helper attempt. Distinct from update_failed.txt which appends
:: across attempts.
echo [%date% %time%] [start] PID=%PARENT_PID% > "%TRACE%"
echo [%date% %time%] [start] NEW=%NEW_EXE% >> "%TRACE%"
echo [%date% %time%] [start] CUR=%CUR_EXE% >> "%TRACE%"
echo [%date% %time%] [start] BAK=%BAK_EXE% >> "%TRACE%"

:: ── Step 1: Wait for parent process to exit ──────────────────────────────
:wait_parent
tasklist /FI "PID eq %PARENT_PID%" 2>nul | find "%PARENT_PID%" >nul
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul 2>&1
    goto wait_parent
)
echo [%date% %time%] [waited] parent exited >> "%TRACE%"

:: ── Step 2: Wait for AV scan-on-write to complete ────────────────────────
:: Defender holds .exe files open for ~3-10s after they're written. Sleep
:: 3s as a baseline; the retry loops below cover the longer end.
timeout /t 3 /nobreak >nul 2>&1

:: ── Step 3: Strip Mark-of-the-Web from new exe (best effort) ─────────────
:: Files written by Invoke-WebRequest carry a Zone.Identifier ADS that some
:: EDR products use to gate file moves. Delete the ADS via the special
:: "filename:ADSname" syntax. Failure is fine — old systems may not have it.
del "%NEW_EXE%:Zone.Identifier" >nul 2>&1
echo [%date% %time%] [motw] cleared >> "%TRACE%"

:: ── Step 4: Rename current exe to .bak ───────────────────────────────────
:: Retry up to 60 times at 1s = 60s budget for AV / indexer locks on the
:: live exe. del .bak first to handle stale leftovers.
del "%BAK_EXE%" >nul 2>&1
set RENAME_ATTEMPTS=60
:try_rename
move /Y "%CUR_EXE%" "%BAK_EXE%" >nul 2>&1
if not errorlevel 1 (
    echo [%date% %time%] [rename] OK >> "%TRACE%"
    goto rename_done
)
timeout /t 1 /nobreak >nul 2>&1
set /a RENAME_ATTEMPTS-=1
if !RENAME_ATTEMPTS! gtr 0 goto try_rename

:: Rename failed entirely
echo [%date% %time%] [rename] FAILED after 60s >> "%TRACE%"
echo [%date% %time%] [session] PID=%PARENT_PID% NEW=%NEW_EXE% CUR=%CUR_EXE% >> "%MARKER%"
echo [%date% %time%] [rename] Failed to rename %CUR_EXE% to %BAK_EXE% after 60s >> "%MARKER%"
echo [%date% %time%] [hint] Defender Controlled Folder Access blocks writes to Desktop/Downloads/Documents. Try moving WinTaskPro.exe to C:\Tools\WinTaskPro\ >> "%MARKER%"
goto fallback

:rename_done

:: ── Step 5: Move new exe into the live location ──────────────────────────
:: Use robocopy because it has built-in retry-on-lock that's far more
:: reliable than a hand-rolled retry loop. /R:60 retries 60 times,
:: /W:1 waits 1s between retries = 60s budget.
:: Note: robocopy works at directory level — copy the file from its source
:: dir to the dest dir, optionally renaming. If new_exe and cur_exe are in
:: different dirs (typical: %TEMP% vs user's chosen folder), we use
:: /MOV which moves the file (not just copies).
for %%I in ("%NEW_EXE%") do set NEW_DIR=%%~dpI
for %%I in ("%NEW_EXE%") do set NEW_NAME=%%~nxI
for %%I in ("%CUR_EXE%") do set CUR_DIR=%%~dpI
for %%I in ("%CUR_EXE%") do set CUR_NAME=%%~nxI

:: Strip trailing backslash that "%%~dpI" leaves
if "%NEW_DIR:~-1%"=="\" set NEW_DIR=%NEW_DIR:~0,-1%
if "%CUR_DIR:~-1%"=="\" set CUR_DIR=%CUR_DIR:~0,-1%

robocopy "%NEW_DIR%" "%CUR_DIR%" "%NEW_NAME%" /MOV /R:60 /W:1 /NFL /NDL /NJH /NJS /NC /NS /NP >>"%TRACE%" 2>&1
:: Robocopy exit codes: 0=no copy, 1=copied OK, 2=extra files, 4-7=non-fatal warnings.
:: Anything ≥8 = real failure. We want exit ≤7.
if errorlevel 8 (
    echo [%date% %time%] [robocopy] failed exit=%errorlevel% >> "%TRACE%"
    goto swap_failed
)

:: Robocopy moved NEW_EXE to CUR_DIR but kept the new name. Now rename it
:: to the canonical CUR_NAME if they differ.
if /I not "%NEW_NAME%"=="%CUR_NAME%" (
    move /Y "%CUR_DIR%\%NEW_NAME%" "%CUR_EXE%" >nul 2>&1
    if errorlevel 1 (
        echo [%date% %time%] [final-rename] failed >> "%TRACE%"
        goto swap_failed
    )
)
echo [%date% %time%] [swap] OK >> "%TRACE%"
goto swap_ok

:swap_failed
:: ── Step 6: Roll back ─────────────────────────────────────────────────────
:: The new exe never made it into place. Restore the .bak so the user has
:: their working app back. Then copy the new exe to the Desktop as a
:: visible fallback the user can run manually.
move /Y "%BAK_EXE%" "%CUR_EXE%" >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] [rollback] FAILED — backup at %BAK_EXE% >> "%TRACE%"
    echo [%date% %time%] [rollback] FAILED — backup at %BAK_EXE% >> "%MARKER%"
) else (
    echo [%date% %time%] [rollback] OK >> "%TRACE%"
)

:: Best-effort: copy new exe to Desktop as a fallback the user can run
:: manually. Even if the swap failed, they get a usable update.
if exist "%NEW_EXE%" (
    set DESKTOP_FALLBACK=%USERPROFILE%\Desktop\WinTaskPro_NEW_VERSION.exe
    copy /Y "%NEW_EXE%" "!DESKTOP_FALLBACK!" >nul 2>&1
    if not errorlevel 1 (
        echo [%date% %time%] [fallback] copied new exe to Desktop as WinTaskPro_NEW_VERSION.exe >> "%TRACE%"
        echo [%date% %time%] [fallback] new version saved to !DESKTOP_FALLBACK! — run it directly to get the update >> "%MARKER%"
    )
)

echo [%date% %time%] [session] PID=%PARENT_PID% NEW=%NEW_EXE% CUR=%CUR_EXE% >> "%MARKER%"
echo [%date% %time%] [swap] Move/robocopy failed >> "%MARKER%"
goto launch_old

:fallback
:: Rename failed: just copy new to Desktop and relaunch old
if exist "%NEW_EXE%" (
    set DESKTOP_FALLBACK=%USERPROFILE%\Desktop\WinTaskPro_NEW_VERSION.exe
    copy /Y "%NEW_EXE%" "!DESKTOP_FALLBACK!" >nul 2>&1
    if not errorlevel 1 (
        echo [%date% %time%] [fallback] copied new exe to Desktop as WinTaskPro_NEW_VERSION.exe >> "%TRACE%"
        echo [%date% %time%] [fallback] new version saved to !DESKTOP_FALLBACK! — run it directly to get the update >> "%MARKER%"
    )
)
goto launch_old

:swap_ok
:: ── Step 7: Success — clear marker, launch new exe, delete .bak ──────────
echo [%date% %time%] [success] swap complete, launching new version >> "%TRACE%"
del "%MARKER%" >nul 2>&1
start "" "%CUR_EXE%"
:: 1.14.2: delete .bak after successful swap. Until this point .bak was
:: kept as a rollback target. Once the new exe is in place AND has been
:: launched, .bak is no longer needed and was clutter the user could see
:: in their app folder (e.g. "WinTaskPro.exe.bak" sitting next to
:: "WinTaskPro.exe"). Failure to delete here is harmless — next update
:: will overwrite via the "del BAK first" pattern at step 4.
del "%BAK_EXE%" >nul 2>&1
echo [%date% %time%] [cleanup] removed %BAK_EXE% >> "%TRACE%"
goto cleanup

:launch_old
:: Cleanup the staged download since it's no longer at NEW_EXE (robocopy may have moved it)
if exist "%NEW_EXE%" del "%NEW_EXE%" >nul 2>&1
echo [%date% %time%] [launch] starting old exe (rolled back) >> "%TRACE%"
start "" "%CUR_EXE%"
goto cleanup

:cleanup
:: Self-delete this batch script. Use the standard "delete-myself" trick:
:: spawn another cmd that waits then deletes us, while we exit immediately.
:: %~f0 expands to this script's full path.
(goto) 2>nul & del "%~f0" >nul 2>&1
"#;
    std::fs::write(path, script).map_err(|e| format!("write: {e}"))
}
#[cfg(not(windows))]
#[allow(dead_code)]
fn verify_pe_file(_p: &std::path::Path) -> Result<(), String> { Ok(()) }
#[cfg(not(windows))]
#[allow(dead_code)]
fn write_swap_helper(_p: &std::path::Path) -> Result<(), String> { Ok(()) }

// ── WebView2 runtime detection ────────────────────────────────────────────────
// On portable installs without an installer to run a WebView2 bootstrapper,
// the app silently fails to render if WebView2 isn't already installed.
// This probe checks both per-machine and per-user install registry keys and
// returns the version string (or None if not installed).
//
// COMPILE NOTE: this code is written against windows-rs 0.61's registry API,
// which wraps optional pointer params in `Option<*mut T>` and returns
// `Result<()>`. If a future bump to 0.62+ moves these to bare pointers or
// changes `Some(0)` for `uloptions`, the failure will be a clean compile
// error on the affected line — drop the `Some(..)` wrapping or replace with
// `std::ptr::null()` as appropriate.
#[cfg(windows)]
fn webview2_version() -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, KEY_WOW64_32KEY, REG_VALUE_TYPE,
        RegOpenKeyExW, RegQueryValueExW, RegCloseKey,
    };
    // Microsoft documents the EdgeUpdate client GUID for the Evergreen runtime.
    // Both x64 and x86 hosts use the WOW6432Node path under HKLM.
    const GUID: &str =
        r"Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const GUID_USER: &str =
        r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    fn read_pv(root: HKEY, sub: &str) -> Option<String> {
        let sub_w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
        let val_w: Vec<u16> = "pv".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut hkey = HKEY::default();
            let r = RegOpenKeyExW(
                root, PCWSTR(sub_w.as_ptr()),
                Some(0), KEY_READ | KEY_WOW64_32KEY, &mut hkey,
            );
            if r.is_err() { return None; }
            let mut buf = [0u16; 64];
            let mut len = (buf.len() * 2) as u32;
            let mut ty  = REG_VALUE_TYPE(0);
            let qr = RegQueryValueExW(
                hkey, PCWSTR(val_w.as_ptr()), None,
                Some(&mut ty),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut len),
            );
            let _ = RegCloseKey(hkey);
            if qr.is_err() { return None; }
            let chars = (len as usize / 2).saturating_sub(1).min(buf.len());
            let s = String::from_utf16_lossy(&buf[..chars]);
            let trimmed = s.trim_end_matches('\0').trim().to_string();
            if trimmed.is_empty() || trimmed == "0.0.0.0" { None } else { Some(trimmed) }
        }
    }
    read_pv(HKEY_LOCAL_MACHINE, GUID)
        .or_else(|| read_pv(HKEY_CURRENT_USER, GUID_USER))
}
#[cfg(not(windows))]
fn webview2_version() -> Option<String> { None }

// MessageBox shown when WebView2 is missing — failing this in silence is the
// worst outcome for a portable .exe because the user just sees a blank window.
#[cfg(windows)]
fn show_webview2_missing_dialog() {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_OK, MB_ICONERROR,
    };
    let title: Vec<u16> = "WinTaskPro".encode_utf16().chain(std::iter::once(0)).collect();
    let msg = "Microsoft Edge WebView2 Runtime is required but was not detected.\n\n\
               Download and install it from:\n\
               https://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n\
               After installing, relaunch WinTaskPro.";
    let body: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let _ = MessageBoxW(None, PCWSTR(body.as_ptr()),
                            PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR);
    }
}

// ── Native MessageBox (Settings → Test Notification) ────────────────────────
// 1.14.2: Replaces the broken `new Notification(...)` browser API path that
// used to error out with "Notifications are blocked by the browser". WebView2
// does not expose a notification permission UI to the user, so the browser
// API is permanently denied. Real desktop toasts via Tauri's notification
// plugin require adding a new dependency + permission grant which is more
// invasive than this release wants. MessageBoxW gives a clear, native popup
// that proves the messaging path works without any dependency changes.
//
// Used for the Settings → Test Notification button and any future "alert
// the user" cases where in-app toast isn't enough.
#[tauri::command]
#[cfg(windows)]
fn show_native_message(title: String, body: String, kind: String) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_OK, MB_ICONINFORMATION, MB_ICONWARNING, MB_ICONERROR,
        MESSAGEBOX_STYLE,
    };
    // Truncate defensively so a frontend bug can't OOM us via a giant string.
    let safe_title = title.chars().take(200).collect::<String>();
    let safe_body  = body.chars().take(2000).collect::<String>();

    let title_w: Vec<u16> = safe_title.encode_utf16().chain(std::iter::once(0)).collect();
    let body_w:  Vec<u16> = safe_body.encode_utf16().chain(std::iter::once(0)).collect();

    let icon: MESSAGEBOX_STYLE = match kind.as_str() {
        "warning" => MB_ICONWARNING,
        "error"   => MB_ICONERROR,
        _         => MB_ICONINFORMATION,
    };
    unsafe {
        let _ = MessageBoxW(None, PCWSTR(body_w.as_ptr()),
                            PCWSTR(title_w.as_ptr()), MB_OK | icon);
    }
    Ok(())
}
#[tauri::command]
#[cfg(not(windows))]
fn show_native_message(_title: String, _body: String, _kind: String) -> Result<(), String> {
    Err("Windows only".into())
}

// CPU count helper — sys.cpus() may return an empty list before refresh_cpu()
// has run. Fall back to std::thread::available_parallelism in that case so the
// boot snapshot doesn't show "cpus=0".
fn num_cpus_safe(sys: &sysinfo::System) -> usize {
    let n = sys.cpus().len();
    if n > 0 { n } else {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
    }
}

// ── CLI helpers (Phase 4 feature) ───────────────────────────────────────────
// These run BEFORE Tauri initialization, so they cannot use any Tauri state.
// Each command spins up its own SchedulerEngine, executes the action, and
// exits. The engine is not shared with the GUI side — keeps CLI
// invocations from interfering with a running GUI instance, which would
// be confusing if both were active.

fn print_cli_help() {
    let v = env!("CARGO_PKG_VERSION");
    println!("WinTaskPro v{} — Windows Task Scheduler manager", v);
    println!();
    println!("USAGE:");
    println!("  WinTaskPro.exe                       Launch the GUI (default)");
    println!("  WinTaskPro.exe --help                Show this message");
    println!("  WinTaskPro.exe --version             Print version and exit");
    println!();
    println!("CLI COMMANDS (Windows only, require Administrator):");
    println!("  --list                               List all task paths, one per line");
    println!("  --run <task_path>                    Trigger a task immediately");
    println!("  --stop <task_path>                   Stop a running task");
    println!("  --enable <task_path>                 Enable a disabled task");
    println!("  --disable <task_path>                Disable a task");
    println!("  --export <task_path>                 Print task XML to stdout");
    println!("  --export-all                         Print all tasks as JSON array");
    println!();
    println!("EXAMPLES:");
    println!(r#"  WinTaskPro.exe --run "\Microsoft\Windows\UpdateOrchestrator\USO_Broker"#);
    println!(r#"  WinTaskPro.exe --export "\PS4" > backup.xml"#);
    println!(r#"  WinTaskPro.exe --list | findstr /R "Backup"#);
    println!();
    println!("EXIT CODES:");
    println!("  0  success");
    println!("  1  command error (task not found, no admin, etc.)");
    println!("  2  invalid arguments");
}

#[cfg(windows)]
fn run_cli_command(args: &[String]) -> i32 {
    // Get an engine. If this fails we're not Administrator (or COM init
    // failed) — either way we can't do anything useful.
    let engine = match scheduler::SchedulerEngine::new() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("Failed to initialize Task Scheduler engine: {}", e);
            eprintln!("CLI commands require Administrator privileges.");
            return 1;
        }
    };

    let cmd = args[0].as_str();
    let arg = args.get(1).map(|s| s.as_str()).unwrap_or("");

    // Helper: validate that a path-requiring command got a path.
    let need_path = |c: &str| -> Option<i32> {
        if arg.is_empty() {
            eprintln!("Error: '{}' requires a task path argument.", c);
            eprintln!("Run --help for usage.");
            Some(2)
        } else { None }
    };

    match cmd {
        "--list" => {
            // get_folders() returns all folder paths recursively. Iterate
            // through each, collect tasks, sort, print.
            let folders = match engine.get_folders() {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("Could not enumerate folders: {}", e);
                    return 1;
                }
            };
            let mut seen_paths = Vec::new();
            for folder in &folders {
                match engine.get_tasks(folder) {
                    Ok(tasks) => {
                        for t in tasks {
                            seen_paths.push(t.path);
                        }
                    }
                    Err(e) => {
                        eprintln!("Warning: could not enumerate folder '{}': {}", folder, e);
                    }
                }
            }
            seen_paths.sort();
            for p in seen_paths {
                println!("{}", p);
            }
            0
        }
        "--run" => {
            if let Some(c) = need_path(cmd) { return c; }
            match engine.run_task(arg) {
                Ok(_)  => { println!("Started: {}", arg); 0 }
                Err(e) => { eprintln!("Run failed: {}", e); 1 }
            }
        }
        "--stop" => {
            if let Some(c) = need_path(cmd) { return c; }
            match engine.stop_task(arg) {
                Ok(_)  => { println!("Stopped: {}", arg); 0 }
                Err(e) => { eprintln!("Stop failed: {}", e); 1 }
            }
        }
        "--enable" => {
            if let Some(c) = need_path(cmd) { return c; }
            match engine.set_enabled(arg, true) {
                Ok(_)  => { println!("Enabled: {}", arg); 0 }
                Err(e) => { eprintln!("Enable failed: {}", e); 1 }
            }
        }
        "--disable" => {
            if let Some(c) = need_path(cmd) { return c; }
            match engine.set_enabled(arg, false) {
                Ok(_)  => { println!("Disabled: {}", arg); 0 }
                Err(e) => { eprintln!("Disable failed: {}", e); 1 }
            }
        }
        "--export" => {
            if let Some(c) = need_path(cmd) { return c; }
            match engine.export_xml(arg) {
                Ok(xml) => { print!("{}", xml); 0 }
                Err(e)  => { eprintln!("Export failed: {}", e); 1 }
            }
        }
        "--export-all" => {
            // Walk all folders, export each task's XML, emit a JSON array.
            // Memory cost is bounded by total task count × XML size; even on
            // large systems (200 tasks × 5KB XML) this is well under 2MB.
            let folders = match engine.get_folders() {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("Could not enumerate folders: {}", e);
                    return 1;
                }
            };
            let mut entries: Vec<serde_json::Value> = Vec::new();
            for folder in &folders {
                if let Ok(tasks) = engine.get_tasks(folder) {
                    for t in tasks {
                        match engine.export_xml(&t.path) {
                            Ok(xml) => {
                                entries.push(serde_json::json!({
                                    "path": t.path,
                                    "name": t.name,
                                    "folder": t.folder,
                                    "enabled": t.enabled,
                                    "xml": xml,
                                }));
                            }
                            Err(e) => {
                                eprintln!("Warning: could not export '{}': {}", t.path, e);
                            }
                        }
                    }
                }
            }
            match serde_json::to_string_pretty(&entries) {
                Ok(s)  => { println!("{}", s); 0 }
                Err(e) => { eprintln!("JSON serialization failed: {}", e); 1 }
            }
        }
        _ => {
            eprintln!("Unknown CLI command: {}", cmd);
            eprintln!("Run --help for usage.");
            2
        }
    }
}


fn main() {
    // ── CLI passthrough (Phase 4 feature) ──────────────────────────────────
    // Before doing anything else, check if we were invoked with command-line
    // arguments that would short-circuit the GUI. This lets the same .exe
    // serve double duty as a scriptable tool (`WinTaskPro.exe --run "\PS4"`)
    // without running a separate `wintaskpro-cli` binary.
    //
    // Design constraints:
    //   - Must not show the WebView2 missing dialog or any UI in CLI mode.
    //   - Must NOT touch the devlog system at all — even reading the logs
    //     dir would create the directory, which is unwanted side-effect for
    //     a CLI invocation that's just printing the version.
    //   - Output goes to stdout via plain println! so it's pipe-friendly.
    //   - Errors go to stderr with exit code 1.
    //
    // Args we recognize as CLI commands (any other args = launch GUI):
    //   --help / -h        usage message
    //   --version          print version and exit
    //   --list             print task paths, one per line
    //   --run <path>       trigger task immediately
    //   --stop <path>      stop running task
    //   --enable <path>    enable disabled task
    //   --disable <path>   disable task
    //   --export <path>    print task XML to stdout
    //   --export-all       print all tasks as a JSON array of {path, xml}
    //
    // Tauri itself may be passed args (--no-default-features etc.) but
    // those don't conflict with our prefix matching — we only intercept on
    // known commands, otherwise fall through to GUI launch.
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() >= 2 {
            let cmd = args[1].as_str();
            match cmd {
                "--help" | "-h" | "/?" => {
                    print_cli_help();
                    std::process::exit(0);
                }
                "--version" | "-V" => {
                    println!("WinTaskPro v{}", env!("CARGO_PKG_VERSION"));
                    std::process::exit(0);
                }
                #[cfg(windows)]
                "--list" | "--run" | "--stop" | "--enable" | "--disable"
                | "--export" | "--export-all" => {
                    let exit_code = run_cli_command(&args[1..]);
                    std::process::exit(exit_code);
                }
                #[cfg(not(windows))]
                "--list" | "--run" | "--stop" | "--enable" | "--disable"
                | "--export" | "--export-all" => {
                    eprintln!("CLI commands are Windows-only.");
                    std::process::exit(1);
                }
                _ => {
                    // Unknown arg — fall through to GUI launch. Tauri's own
                    // arg handling will catch any of its own flags; everything
                    // else is harmless.
                }
            }
        }
    }

    // NOTE (1.15.4): we deliberately do NOT call SetCurrentProcessExplicitAppUserModelID.
    // An explicit AUMID that has no matching registered Start-Menu shortcut makes
    // Windows show a GENERIC taskbar icon for the portable exe (the title bar still
    // shows the correct window HICON, which is exactly the symptom we saw). With no
    // explicit AUMID, Windows derives identity from the exe and uses the window's own
    // icon (set by tao) for the taskbar button. Earlier builds set this in .setup()
    // and then in main(); both produced the generic icon — removing it is the fix.

    // Boot banner — the first line in every session's log file.
    // Includes version, profile, and PID so multi-launch traces can be told apart.
    log_info!("main", "WinTaskPro starting | version={} | profile={} | pid={}",
        env!("CARGO_PKG_VERSION"),
        if cfg!(debug_assertions) { "debug" } else { "release" },
        std::process::id());

    // ── WebView2 runtime check ────────────────────────────────────────────
    // Portable .exe has no installer to bootstrap WV2 — bail loudly if missing.
    // This MUST run before tauri::Builder, otherwise the WebView fails to attach
    // and the user sees a blank window with zero diagnostic.
    #[cfg(windows)]
    {
        match webview2_version() {
            Some(v) => log_info!("main", "WebView2 runtime detected: {}", v),
            None => {
                log_error!("main", "WebView2 runtime NOT detected — exiting with user-visible dialog");
                show_webview2_missing_dialog();
                std::process::exit(1);
            }
        }
    }

    // CheckNetIsolation: loopback exemption for WebView2 AppContainer (debug/Windows)
    #[cfg(all(debug_assertions, windows))]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("CheckNetIsolation.exe")
            .args(["LoopbackExempt", "-a",
                   "-n=Microsoft.Win32WebViewHost_cw5n1h2txyewy"])
            .creation_flags(0x08000000)  // CREATE_NO_WINDOW — silent
            .output();
        log_debug!("main", "CheckNetIsolation loopback exemption applied (debug build)");
    }

    #[cfg(windows)]
    let engine = SchedulerEngine::new().ok();
    #[cfg(not(windows))]
    let engine: Option<SchedulerEngine> = None;

    #[cfg(windows)]
    log_info!("main", "scheduler engine init: {}",
        if engine.is_some() { "ok" } else { "FAILED (likely not running as Administrator)" });

    // Use System::new() instead of new_all() — new_all() enumerates all processes,
    // CPUs, memory, and network on the main thread before the window opens, causing
    // visible startup lag. The first get_processes() call will do the real refresh.
    let mut sys = sysinfo::System::new();

    // sysinfo 0.32: lazy probes mean total_memory() returns 0 until the corresponding
    // refresh has been called. refresh_memory() is cheap (single GlobalMemoryStatusEx
    // syscall on Windows) and we want a useful ram_mb in the boot snapshot.
    // Without this, every log line has shown `ram_mb=0` since the 0.32 bump.
    sys.refresh_memory();

    // ── Boot snapshot — full diagnostic line so a single log can answer
    //     "what was the user's environment at session start?"
    log_info!("main",
        "boot_snapshot | os={} | kernel={} | host={} | arch={} | cpus={} | ram_mb={} | admin={}",
        sysinfo::System::long_os_version().unwrap_or_else(|| "unknown".into()),
        sysinfo::System::kernel_version().unwrap_or_else(|| "unknown".into()),
        sysinfo::System::host_name().unwrap_or_else(|| "unknown".into()),
        sysinfo::System::cpu_arch().unwrap_or_else(|| "unknown".into()),
        num_cpus_safe(&sys),
        sys.total_memory() / 1024 / 1024,
        is_admin(),
    );

    tauri::Builder::default()
        .manage(AppState {
            scheduler:    Mutex::new(engine),
            sysinfo:      Mutex::new(sys),
            io_snapshots: Mutex::new(std::collections::HashMap::new()),
            user_cache:   Mutex::new(std::collections::HashMap::new()),
        })
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::TrayIconBuilder;

            // NOTE: we intentionally set no explicit AppUserModelID anywhere (see
            // the note at the top of main()). An unregistered AUMID was the cause
            // of the generic taskbar icon; without one, the window's own icon is
            // used for the taskbar button.

            let show_item = MenuItem::with_id(app, "show", "🪟 Open WinTaskPro", true, None::<&str>)?;
            let sep       = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "❌ Quit", true, None::<&str>)?;
            let menu      = Menu::with_items(app, &[&show_item, &sep, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon()
                    .expect("App icon not found")
                    .clone())
                .tooltip("WinTaskPro — Windows Task Scheduler")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            if let Some(win) = app.get_webview_window("main") {
                let app_handle = win.app_handle().clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        app_handle.exit(0);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_folders,
            get_tasks,
            get_all_tasks,
            run_task,
            stop_task,
            set_task_enabled,
            delete_task,
            export_task_xml,
            import_task_xml,
            move_task,
            run_task_test,
            hash_file,
            create_task,
            update_task,
            get_running_tasks,
            get_task_history,
            create_folder,
            delete_folder,
            read_file,
            write_file,
            is_admin,
            is_dev,
            restart_as_admin,
            flash_taskbar,
            open_in_browser,
            browse_for_file,
            browse_for_folder,
            get_event_log_history,
            search_event_history,
            get_processes,
            kill_process,
            kill_process_tree,
            set_process_affinity,
            get_cpu_count,
            get_system_overview,
            suspend_process,
            resume_process,
            set_process_priority,
            get_process_modules,
            get_process_connections,
            find_process_by_port,
            open_file_location,
            show_native_message,
            // — Dev logging (see devlog.rs)
            log_event,
            set_log_level,
            get_log_level,
            get_log_tail,
            open_logs_folder,
            get_log_file_path,
            get_diagnostic_snapshot,
            // — Auto-update (portable in-place self-replace)
            download_and_install_update,
            read_update_failed_marker,
            clear_update_failed_marker,
            read_update_helper_log,
            log_self_test,
        ])
        .run(tauri::generate_context!())
        .expect("Error running WinTaskPro");
}
