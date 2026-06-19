# WinTaskPro — Agent Handover

> **For the next agent picking this project up.** Read this in full before touching any code.
> Read `AGENT_RULES.md` next, then `CHANGELOG.md` (top entry only — newest first).

---

## TL;DR — what this project is

A desktop app that gives Windows Task Scheduler a modern UI. Tauri v2 shell, Rust backend (COM bindings to the Task Scheduler API via the `windows` crate), vanilla-JS frontend (no build step, no framework). Single-window app, runs only on Windows. Requires Administrator to read/write tasks because that's a Task Scheduler restriction, not ours.

The frontend is served via `node devserver.js` on port 1420 in dev. The Rust side embeds the static HTML/JS/CSS at build time. There is no bundler, no Webpack, no React. Edits to `src/app.js` are visible on browser reload.

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│ src/index.html  src/app.js  src/style.css                   │ ← UI (vanilla JS)
└──────────────────────────────┬──────────────────────────────┘
                               │  invoke('command', args)  (Tauri IPC)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ src-tauri/src/main.rs                                       │ ← #[tauri::command]
│   - registers commands, owns AppState (sysinfo + scheduler) │   handlers
│   - log_event / set_log_level / open_logs_folder            │
│   - get_processes, kill_process (sysinfo)                   │
│   - is_admin, restart_as_admin, browse_for_*                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ src-tauri/src/scheduler.rs                                  │ ← Task Scheduler
│   SchedulerEngine — wraps ITaskService COM object           │   COM bridge
│     get_folders / get_tasks / create_task / update_task     │
│     run_task / stop_task / delete_task / set_enabled        │
│     export_xml / import_xml / get_running_tasks             │
│     get_task_history (next 90 days, NOT past)               │
│   Module-level helpers (shared by create_task & update_task)│
│     apply_triggers_to_definition()  — trigger building      │
│     build_exec_action()             — action + env_vars     │
│     validate_task_name()            — invalid char check    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ src-tauri/src/log.rs                                        │ ← Dev logger
│   log_trace! / log_debug! / log_info! / log_warn! / log_error! │
│   File: %LOCALAPPDATA%\WinTaskPro\logs\wintaskpro.log       │
│   Rotated at 5 MB → wintaskpro.log.1                        │
└─────────────────────────────────────────────────────────────┘
```

---

## The "editing tasks is broken" history

This was the most-frequently-regressed bug area in the project. As of 2.1.0 it has been fixed properly in three places at once. **Do not touch any of these without reading the rationale.**

### 1. `_editTaskPath` reset in `submitCreateTask` (`src/app.js`)

`_editTaskPath` is the identifier of the task currently being edited. The submit-task function reads it to decide between `update_task` (path exists) vs `create_task` (path is null). The bug: an earlier version reset `_editTaskPath = null` inside the `catch` block, "to be safe." This meant: save fails → modal stays open → user retries → second click sees `null` → routes to `create_task` → silently creates a duplicate of the task they were trying to fix.

**Rule:** the reset belongs ONLY in the success path. The catch block must leave edit state intact so retries continue updating the original. There is now a comment block at the call site warning future agents.

### 2. `update_task` folder-path bug (`src-tauri/src/scheduler.rs`)

`update_task(task_path: &str, p: &CreateTaskParams)` extracts the source folder from `task_path` as `fp`. Before 2.1.0 it then ignored `fp` and used `p.folder_path` (the form value) for `RegisterTaskDefinition`. When the form value drifted — which happened reliably for tasks loaded via `get_all_tasks` — the registration created a NEW copy in the form folder while leaving the original in place. The user got a "task updated successfully" toast and a stray duplicate appeared in some other folder.

**Rule:** when implementing an "update" against an addressable resource, the operation key (in this case the source folder) comes from the identifier the operation was invoked on, never from a form field that the user could have changed.

### 3. Trigger-building code duplicated between `create_task` and `update_task`

Both functions used to contain ~120 lines of identical trigger-construction code (each trigger type has its own COM interface — `IDailyTrigger`, `IWeeklyTrigger`, `IMonthlyTrigger`, etc., each with its own setters). Any divergence between the two copies caused "create works but edit doesn't" symptoms.

As of 2.1.0 both methods call a single module-level helper: `apply_triggers_to_definition(defn: &ITaskDefinition, p: &CreateTaskParams)`. Future trigger fixes apply once. **Do not duplicate this logic again** — if a new trigger type needs different create-vs-update behaviour, branch inside the helper based on a flag, or factor out a smaller helper.

---

## Logging — how to add a log line

### Backend (Rust)

The `log` module is at `src-tauri/src/log.rs`. Macros are exported at crate root. In any `.rs` file inside `src-tauri/src/`:

```rust
log_info!("scheduler::create_task", "name={} folder={}", p.name, p.folder_path);
log_warn!("ipc::delete_task", "path={}", path);
log_error!("scheduler::register", "RegisterTaskDefinition failed: {}", err);
```

The `target` string convention is `module::function`. Pick the level by the operation's privilege:

- `INFO` — successful state changes (create, update, run)
- `WARN` — destructive operations (delete, kill_process, elevation)
- `ERROR` — failures, COM errors, I/O errors

Every line flushes to disk immediately (deliberate — see the comment in `devlog.rs::log_line`; volume is low and losing the boot snapshot on a crash cost more than the I/O). Still pick levels by the operation's privilege as above so the file stays scannable.

### Frontend (JS)

Use the `dlog`/`dinfo`/`dwarn`/`derror` helpers in `src/app.js` (defined right below the `invoke` constant):

```js
dinfo('submit_task', 'update OK', { name, path });
dwarn('refreshAll', 'partial enumeration', { count, expected });
derror('openEditDialog', 'task not found', { path });
```

Frontend logs go through the `log_event` IPC and end up in the same file as backend logs. Console output is automatic for `info`/`warn`/`error` (skipped for `trace`/`debug` to keep DevTools clean).

### Where the logs go

- **File:** `%LOCALAPPDATA%\WinTaskPro\logs\wintaskpro.log`
- **Rotation:** at 5 MB → `wintaskpro.log.1` (oldest dropped)
- **Format:** `[2026-04-19T15:23:01.456Z] [INFO ] [target] message`
- **Open from app:** Settings → 🛠 Developer Logs → "Open Logs Folder"
- **Change verbosity from app:** Settings → 🛠 Developer Logs → Log Level dropdown
- **Override at launch:** `set WINTASKPRO_LOG_LEVEL=DEBUG && WinTaskPro.exe`

---

## The cleaner / backup tool — `wintaskpro-clean.ps1`

PowerShell tool inspired by Kura's `kura-clean.ps1`. Six modes:

```powershell
.\wintaskpro-clean.ps1                       # interactive menu
.\wintaskpro-clean.ps1 clean                 # remove target/, node_modules/, dist/
.\wintaskpro-clean.ps1 backup                # zip source to %APPDATA%\WinTaskPro\source-backups\
.\wintaskpro-clean.ps1 backup-and-clean      # backup first, then clean
.\wintaskpro-clean.ps1 list                  # list all backups
.\wintaskpro-clean.ps1 restore <filename>    # restore (auto-backs current state first)
.\wintaskpro-clean.ps1 dry-run               # preview a clean
```

**Constraints (from past bug history — don't violate):**

1. **PS 5.1 compatible.** No ternary `? :`, no null-coalescing `??`, no `??=`. Windows ships PS 5.1 by default; using PS 7+ syntax in this file is a guaranteed crash on stock Windows.
2. **No `$ErrorActionPreference = 'Stop'` at script level.** Permission errors in `node_modules` junctions or `.git` internals will then terminate the entire script. Use per-call `-ErrorAction SilentlyContinue` instead.
3. **`restore` always backs up first.** The "safety backup before destructive op" pattern is non-negotiable — past projects have lost source from a single bad restore.
4. **Cleaner is never destructive of source.** The include/exclude lists are explicit allowlists, not `Get-ChildItem -Recurse | Remove-Item`.

The script also writes its own actions to the same log file the app uses, so script + app actions can be correlated by timestamp.

The older `clean_project.ps1` is still in the repo — it's the simpler dry-run-by-default cleaner. `wintaskpro-clean.ps1` is the full backup+clean+restore replacement; you can deprecate `clean_project.ps1` whenever, or keep it as a minimalist alternative.

---

## What's where (file inventory)

```
WinTaskPro/
├── src/
│   ├── app.js              ← Vanilla JS frontend (~9300 lines). 1 file.
│   ├── features.js         ← Feature pack (1.15.0). Loaded AFTER app.js so
│   │                          app.js globals (escHtml, showToast, invoke,
│   │                          openModal, allTasks…) are in scope. Eight
│   │                          features, ALL on existing IPC — no new Rust:
│   │                          recycle bin, tamper watch, run-now, activity
│   │                          digest, 24h timeline, result explainer, full
│   │                          backup/restore, Ctrl+K palette. State in
│   │                          localStorage (wtp_trash, wtp_trust_baseline).
│   │                          All inline-handler targets are exported onto
│   │                          window at the bottom of the file.
│   ├── index.html          ← Layout + page containers
│   └── style.css           ← Theme + layout. CSS variables for accent.
│                              Feature-pack styles are the fp-* block at EOF.
├── src-tauri/
│   ├── Cargo.toml          ← sysinfo 0.32, windows 0.61, tauri 2
│   ├── src/
│   │   ├── main.rs         ← #[tauri::command] handlers, AppState
│   │   ├── scheduler.rs    ← SchedulerEngine (COM bridge, ~1300 lines)
│   │   └── devlog.rs       ← Dev logger (added in 2.1.0, renamed from log.rs)
│   ├── tauri.conf.json     ← CSP, bundle config, window options
│   ├── capabilities/       ← Tauri ACL (default.json + dev.json)
│   ├── icons/              ← App icons
│   └── app.manifest        ← UAC manifest (asInvoker; UAC requested separately)
├── package.json            ← @tauri-apps/cli + api 2.x; scripts: dev, build
├── devserver.js            ← Tiny static HTTP server (port 1420). Replaces py -m http.server.
├── wintaskpro-clean.ps1    ← Backup + clean + restore tool (NEW in 2.1.0)
├── clean_project.ps1       ← Older dry-run-by-default cleaner (still works)
├── build_portable.ps1      ← `tauri build --no-bundle` wrapper
├── build_portable.bat      ← cmd.exe equivalent for cmd shell users
├── AGENT_RULES.md          ← Read this before touching code
├── HANDOVER.md             ← This file
├── CHANGELOG.md            ← Top entry first; root-cause notes per change
├── README.md               ← User-facing readme
├── SETUP.md                ← Build environment setup steps
├── UPDATER.md              ← How to enable/configure auto-updates
└── AV_SAFETY.md            ← Notes for AV vendors / IT admins on every privileged op
```

---

## First-time agent checklist

When you take over from another agent (or from yourself after a long break):

1. **Read this file end-to-end.**
2. **Read `AGENT_RULES.md`** — every numbered rule. Pay attention to 44–46 (added in 2.1.0).
3. **Read the top entry of `CHANGELOG.md`** so you know what landed most recently and why.
4. **`grep -rn "GOTCHA:" src-tauri/src/ src/`** — comments tagged `GOTCHA:` document hard-won lessons. They are mandatory reading.
5. **Run the cleaner dry-run before doing anything else:**
   ```powershell
   .\wintaskpro-clean.ps1 dry-run
   ```
   This verifies the project layout is intact and shows you what's stale.
6. **If you intend to change `create_task` or `update_task`** — open `apply_triggers_to_definition()` first. Most "trigger" changes belong inside that helper, not in either method.
7. **Add `dlog`/`log_info!` calls for every new feature.** No silent failures. The reason this is a project rule is that bugs in the COM layer are unreproducible without timestamped logs.

## "Why doesn't X work?" debugging guide

| Symptom | First thing to check |
|---------|----------------------|
| Edit task creates a duplicate | `_editTaskPath` retry-on-failure path — see history above |
| Edit task moves to wrong folder | `update_task` folder-path bug — see history above |
| Frontend buttons silently dead | CSP blocks inline `onclick` — needs `'unsafe-inline'` in `script-src` |
| Tauri IPC returns "undefined" | Tauri v2 invoke path — should be `window.__TAURI__.core.invoke` |
| `cargo build` fails on Windows-rs | Check the version — we pin sysinfo 0.32 + windows 0.61 deliberately (0.61 matches tauri's transitive windows; see Cargo.toml comments before "fixing" by downgrading) |
| Edit/Location button does nothing, or "Task not found" on a real task | Windows path interpolated into a single-quoted inline `onclick` — JS eats the backslashes as escape sequences. Use `escHtml(JSON.stringify(value))`, never `'${escHtml(v)}'`, for string args in inline handlers |
| Process Manager shows 0% CPU forever | `AppState.sysinfo` was reset between calls — must be persistent in `Mutex` |
| Logs folder is empty | `LOCALAPPDATA` not set, or first log call hasn't fired yet |
| `wintaskpro-clean.ps1` errors on launch | PS 7+ syntax leaked in (`??`, `? :`) — see Rule on PS 5.1 compat |

---

## Build commands

```powershell
# Dev (hot reload via devserver.js + tauri dev)
npm install
npm run tauri dev

# Production installer (NSIS + MSI)
npm run tauri build

# Portable EXE (no installer)
.\build_portable.ps1
```

The `build` script bundles to `src-tauri/target/release/bundle/`. Installers in `nsis/` and `msi/`.

---

## Tauri v2 quirks worth remembering

- `withGlobalTauri: true` exposes `window.__TAURI__` for vanilla JS. Without it the only way to call IPC is via `@tauri-apps/api` ESM imports, which require a bundler.
- The IPC path in v2 is `window.__TAURI__.core.invoke`. In v1 it was `window.__TAURI__.tauri.invoke`. Old StackOverflow answers will mislead you.
- Capabilities (`src-tauri/capabilities/*.json`) are not optional in v2 — every IPC command needs an explicit allow rule via `core:default` or a more specific permission.
- The CSP must include `'unsafe-inline'` in `script-src` if any HTML uses inline `onclick` etc. Every button in `index.html` does, so this is required, not optional.

---

*Last updated: 1.15.0 — 2026-06-11. Edit this file when you change architecture, add a new module, or solve a recurring bug class.*
