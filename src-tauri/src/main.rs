#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, State};

#[cfg(windows)]
mod scheduler;
#[cfg(windows)]
use scheduler::{CreateTaskParams, RunningTaskInfo, SchedulerEngine, TaskInfo, TaskRunRecord};

// Stub for non-Windows builds so AppState compiles on all platforms
#[cfg(not(windows))]
struct SchedulerEngine;

// ── App state ─────────────────────────────────────────────────────────────────

struct AppState(Mutex<Option<SchedulerEngine>>);

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
#[cfg(windows)]
fn get_folders(state: State<AppState>) -> Result<Vec<String>, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.get_folders().map_err(|e| e.to_string()),
        None    => Err("Run as Administrator to access Task Scheduler.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn get_folders(_state: State<AppState>) -> Result<Vec<String>, String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn get_tasks(folder: String, state: State<AppState>) -> Result<Vec<TaskInfo>, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.get_tasks(&folder).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator to access Task Scheduler.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn get_tasks(_folder: String, _state: State<AppState>) -> Result<Vec<String>, String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn get_all_tasks(state: State<AppState>) -> Result<Vec<TaskInfo>, String> {
    let lock = state.0.lock().unwrap();
    let engine = match lock.as_ref() {
        Some(e) => e,
        None    => return Err("Run as Administrator to access Task Scheduler.".into()),
    };
    let folders = engine.get_folders().map_err(|e| e.to_string())?;
    let mut all: Vec<TaskInfo> = Vec::new();
    for f in &folders {
        if let Ok(tasks) = engine.get_tasks(f) {
            all.extend(tasks);
        }
    }
    let mut seen = std::collections::HashSet::new();
    all.retain(|t| seen.insert(t.path.clone()));
    Ok(all)
}

#[tauri::command]
#[cfg(not(windows))]
fn get_all_tasks(_state: State<AppState>) -> Result<Vec<String>, String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn run_task(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.run_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn run_task(_path: String, _state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn stop_task(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.stop_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn stop_task(_path: String, _state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn set_task_enabled(path: String, enabled: bool, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.set_enabled(&path, enabled).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn set_task_enabled(_path: String, _enabled: bool, _state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn delete_task(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.delete_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn delete_task(_path: String, _state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn export_task_xml(path: String, state: State<AppState>) -> Result<String, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.export_xml(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn export_task_xml(_path: String, _state: State<AppState>) -> Result<String, String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn import_task_xml(
    folder: String,
    name:   String,
    xml:    String,
    state:  State<AppState>,
) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.import_xml(&folder, &name, &xml).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn import_task_xml(
    _folder: String,
    _name:   String,
    _xml:    String,
    _state:  State<AppState>,
) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn create_task(params: CreateTaskParams, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.create_task(&params).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn create_task(_state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn update_task(path: String, params: CreateTaskParams, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.update_task(&path, &params).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn update_task(_path: String, _params: CreateTaskParams, _state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn get_running_tasks(state: State<AppState>) -> Result<Vec<RunningTaskInfo>, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.get_running_tasks().map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn get_running_tasks(_state: State<AppState>) -> Result<Vec<String>, String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn get_task_history(path: String, max_records: u32, state: State<AppState>) -> Result<Vec<TaskRunRecord>, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.get_task_history(&path, max_records).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn get_task_history(_path: String, _max_records: u32, _state: State<AppState>) -> Result<Vec<String>, String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn create_folder(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.create_folder(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn create_folder(_path: String, _state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
#[cfg(windows)]
fn delete_folder(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.delete_folder(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
#[cfg(not(windows))]
fn delete_folder(_path: String, _state: State<AppState>) -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_admin() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION::default();
            let mut ret_len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut _),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret_len,
            );
            let _ = windows::Win32::Foundation::CloseHandle(token);
            ok.is_ok() && elevation.TokenIsElevated != 0
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    #[cfg(windows)]
    let engine = SchedulerEngine::new().ok();
    #[cfg(not(windows))]
    let engine: Option<SchedulerEngine> = None;

    tauri::Builder::default()
        .manage(AppState(Mutex::new(engine)))
        .setup(|app| {
            // ── System tray ───────────────────────────────────────────────────
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::TrayIconBuilder;

            let show_item = MenuItem::with_id(app, "show", "🪟 Open WinTaskPro", true, None::<&str>)?;
            let sep       = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "❌ Quit", true, None::<&str>)?;
            let menu      = Menu::with_items(app, &[&show_item, &sep, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
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

            // Minimize to tray on close instead of exiting
            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win2.hide();
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
            create_task,
            update_task,
            get_running_tasks,
            get_task_history,
            create_folder,
            delete_folder,
            read_file,
            write_file,
            is_admin,
        ])
        .run(tauri::generate_context!())
        .expect("Error running WinTaskPro");
}
