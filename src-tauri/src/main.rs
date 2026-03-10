#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::State;

mod scheduler;
use scheduler::{CreateTaskParams, SchedulerEngine, TaskInfo};

// ── App state ─────────────────────────────────────────────────────────────────

struct AppState(Mutex<Option<SchedulerEngine>>);

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_folders(state: State<AppState>) -> Result<Vec<String>, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.get_folders().map_err(|e| e.to_string()),
        None    => Err("Run as Administrator to access Task Scheduler.".into()),
    }
}

#[tauri::command]
fn get_tasks(folder: String, state: State<AppState>) -> Result<Vec<TaskInfo>, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.get_tasks(&folder).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator to access Task Scheduler.".into()),
    }
}

#[tauri::command]
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
    all.dedup_by(|a, b| a.path == b.path);
    Ok(all)
}

#[tauri::command]
fn run_task(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.run_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
fn stop_task(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.stop_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
fn set_task_enabled(path: String, enabled: bool, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.set_enabled(&path, enabled).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
fn delete_task(path: String, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.delete_task(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
fn export_task_xml(path: String, state: State<AppState>) -> Result<String, String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.export_xml(&path).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
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
fn create_task(params: CreateTaskParams, state: State<AppState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(e) => e.create_task(&params).map_err(|e| e.to_string()),
        None    => Err("Run as Administrator.".into()),
    }
}

#[tauri::command]
fn is_admin() -> bool {
    use std::process::Command;
    Command::new("net")
        .args(["session"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let engine = SchedulerEngine::new().ok();

    tauri::Builder::default()
        .manage(AppState(Mutex::new(engine)))
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
            is_admin,
        ])
        .run(tauri::generate_context!())
        .expect("Error running WinTaskPro");
}