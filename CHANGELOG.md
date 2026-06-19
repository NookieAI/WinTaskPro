# Changelog

All notable changes to WinTaskPro are documented in this file.  
Format follows [Conventional Commits](https://www.conventionalcommits.org/) style.

---
## [1.16.0] — 2026-06-19 — Deep-dive audit: security hardening, bug fixes, accessibility, UX redesign + new features

A multi-agent deep-dive audit (adversarially verified) of the whole codebase,
followed by fixes across the Rust backend and vanilla-JS frontend, an
accessibility/UX pass, and three new power-user features. Verified with
`cargo check` (clean) and `node --check` (clean). Version bumped 1.15.4 → 1.16.0
across `package.json` / `Cargo.toml` / `tauri.conf.json` / `index.html` / `app.manifest`.

### Security
- **`src-tauri/src/scheduler.rs` `build_exec_action`: command injection via task arguments (HIGH).**
  When environment variables are set, the action runs under `cmd.exe /c "…"` with a
  `SET` preamble. `program_path` was escaped but `p.arguments` was interpolated **raw**,
  and the `^"` escaping was provably ineffective: when `&&` is present inside `/c "…"`,
  cmd strips the outer quote pair and re-parses the remainder UNQUOTED, so a `"` in any
  interpolated value breaks out and a following `& <cmd>` executes at the task's privilege.
  Fix: reject embedded `"` on this path, emit each env var as `SET "K=V"`, quote the program
  (also fixes a latent spaces-in-path bug), and caret-escape arguments. Removed the now-dead
  `escape_cmd_path`.
  > GOTCHA: do NOT re-add `^"` escaping — it is a no-op after cmd's outer-quote strip.
- **`src/app.js` + `src/features.js`: 6 inline-`onclick` XSS sinks (HIGH, app runs elevated).**
  Process-name Kill/Tree buttons (`app.js` ~8700), the kill-tree confirm button (~9184),
  the process context menu (~9598), the drift-card "Stop watching" button (`features.js`
  missing-branch ~447), plus the latent template-id (`app.js` ~4061) and recycle-bin
  (`features.js` ~303) sinks all used `'${escHtml(v).replace(/'/g,"\\'")}'` — `escHtml` turns
  `'` into `&#39;` *before* the `.replace`, so the replace is a no-op and the entity decodes
  back to `'` in the attribute, allowing breakout. Converted every one to the mandated
  `escHtml(JSON.stringify(v))` form (Rule 48).
- **`src-tauri/src/scheduler.rs` `import_xml`: now calls `validate_task_name`** so the import
  path enforces the same name rules as create/update (previously the only registration path
  that skipped it).
- **`src-tauri/src/main.rs` `read_file`/`write_file`: canonicalize before the extension check**
  so a symlink/junction/8.3-short-name named `foo.txt` cannot redirect a read/write onto a
  different real file (e.g. `.ssh/id_rsa`). `hash_file` now rejects relative/`..` paths.
- **`src-tauri/src/main.rs` `open_file_location`: reject embedded `"`** so a path cannot break
  out of the `/select,"…"` argument and inject extra `explorer.exe` switches.

### Fixed
- **`src-tauri/src/main.rs` `restart_as_admin`: the `runas` verb literal contained a raw NUL
  byte** (`"runas\0"`, which rendered as a trailing space and made ripgrep treat the file as
  binary). Replaced with the standard `"runas".encode_utf16().chain(once(0))` idiom — same
  bytes, but clean source and consistent with every other wide string in the file.
- **`src-tauri/src/main.rs` `run_task_test`: replaced `.expect()` on the stdout/stderr pipe
  handles** with a clean `Err` return (kills the child) instead of panicking the IPC worker.
- **`src/app.js` `submitCreateTask`: double-click created duplicate tasks.** Added a
  `_submittingTask` re-entrancy guard plus disabling `#create-submit-btn` across the slow COM
  call (re-enabled in a `finally`).
- **`src/app.js` `loadTasksForFolder`: wrong-folder data from a race.** A folder click racing
  an in-flight auto-refresh could let the slower/older response overwrite the newer one. Added
  a monotonic `_loadTasksReqId` token; stale responses are dropped.
- **`src/app.js` editing a recurring task re-anchored its schedule to today.** Daily/Weekly/
  Monthly/Interval submit rebuilt `start_datetime` from `${today}`, shifting the day/week parity
  of "every N" triggers. Now preserves the original StartBoundary date via `_editTriggerStartDate`.
- **`src/app.js` `loadDashboard`: dashboard auto-refreshed every 30s even with auto-refresh
  OFF.** The self-reschedule is now gated on `settings.autoRefresh` and uses `settings.refreshInterval`.
- **`src/app.js` `toggleTask`: enable/disable could set the wrong state** from a stale
  detail-panel closure. Now re-resolves the task by path from the live `allTasks` first.
- **`src/app.js` `refreshProcessData`: added the `_procRefreshInProgress` in-flight guard** its
  sibling refreshers already had, preventing overlapping `get_processes` from mutating shared maps.

### Added
- **Favorites / pinning** (`src/app.js`, `src/style.css`): a ★ toggle on every task row, pinned
  rows highlighted and floated to the top, and a "★ Favorites" filter pill. State in
  `localStorage['wtp_favorites']`.
- **Saved searches** (`src/app.js`, `src/style.css`): save the current search + status + tag +
  favorites filter as a named chip ("💾 Save Search"); chips render above the table and re-apply
  on click. State in `localStorage['wtp_saved_searches']`.
- **Task Health panel** (`src/app.js`, `src/style.css`): a "🩺 Health" button scores every task
  0–100 from existing signals (failed last run, never-run/unscheduled, disabled, no action) and
  lists the unhealthy ones with reasons; click to jump to the task.
- **10 new Script Library templates** (`src/app.js`): Empty Recycle Bin, Flush DNS Cache, System
  File Check (SFC, monthly), Disk Cleanup, Defender Quick Scan, Battery Health Report, Refresh
  Group Policy, Optimize Drive (on idle), Log Boot Time (at startup), Create Restore Point — all
  using **real built-in Windows tools** and **fully wired** (Weekly days, Monthly months/day, Boot,
  Logon, Idle triggers pre-selected). **Root fix:** `openCreateDialog` now applies
  `prefill.days_of_week`/`months_of_year`/`days_of_month` (previously only the *edit* path did),
  so a Weekly/Monthly template's days/months were silently dropped — the shipped "Weekly Backup"
  template never actually selected Sunday. Verified end-to-end in a live render.
- **Accessibility** (`src/index.html`, `src/style.css`, `src/app.js`): keyboard focus trap +
  initial focus + focus restore for the main modal; `role="dialog"`/`aria-modal`/`aria-labelledby`
  on all modal boxes; `role="status"`/`aria-live` on the toast; `role="button"`/`tabindex` +
  a delegated Enter/Space activator for nav items, stat pills, sortable headers and the statusbar
  help; `aria-label` on icon-only buttons; `sr-only` text for health dots and the health column;
  a global `:focus-visible` ring; and a `prefers-reduced-motion` block.

### Changed
- **SVG icon system** (`src/index.html`, `src/style.css`, `src/app.js`): added a 34-symbol inline
  sprite and `.ico` styling (`stroke: currentColor`, so icons track theme/hover automatically) and
  converted the sidebar nav rail, sidebar-header buttons, the **topbar**, the **bulk toolbar**, and
  the **detail-action bar** (including the dynamic Enable/Disable toggle) from emoji to SVG. Every
  `<use>` reference is cross-checked against a defined `<symbol>`. (Body-content status glyphs and
  the dynamic folder list still use emoji.)
- **Light theme correctness** (`src/style.css`, `src/app.js`): `applyTheme` now toggles a
  `html.theme-light` class so CSS can override the values that are NOT among the 16 inline
  variables — hover overlays, focus ring, scrollbar, the badge/info/xml status foregrounds
  (re-tuned to pass WCAG AA on white), and the dark boot background. Hardcoded
  `rgba(255,255,255,…)` hovers replaced with theme-aware `--hover-overlay*` tokens.
- **Responsiveness** (`src/style.css`): the topbar is now horizontally scrollable (controls were
  silently clipped off-edge at narrow widths); added breakpoints that shrink the detail panel and
  float it over the table below ~1024px; scrollbars bumped 6px→9px with a theme-aware thumb; the
  toast wraps with a max-width instead of overflowing the viewport.
- **Launch UI freeze — THE root cause (found via the runtime log)** (`src-tauri/src/main.rs`): the
  dominant ~15-20 s launch freeze was the dashboard's **Activity digest** — `search_event_history`
  (and `get_event_log_history`) spawn `powershell.exe Get-WinEvent` over the 24 h Task Scheduler
  log, which takes many seconds on a busy machine. As **synchronous** `#[tauri::command]`s they ran
  on and froze the **main UI thread**. Both are now **`async` + `spawn_blocking`**, so the PowerShell
  runs off the UI thread and the Activity card simply fills in when ready. (The log timeline showed
  the window unclickable for ~20 s between the `search_event_history` call and the next event-loop
  tick — the task walk was a red herring.)
- **Launch — async task enumeration** (`src-tauri/src/main.rs`): `get_all_tasks`/`get_tasks` were
  also synchronous COM walks on the main thread; likewise made **`async`**, running a throwaway STA
  `SchedulerEngine` (own `CoInitializeEx`/`CoUninitialize`, balanced on the error path via an RAII
  guard) on a `spawn_blocking` thread. The shared main-thread engine is STA-bound, so a fresh
  per-call engine on the worker thread is required (using the shared one there would be an apartment
  violation).
- **Instant launch — persistent task cache** (`src/app.js` `init`): on top of the async fix, the
  app now caches the task list to `localStorage['wtp_taskCache']` (~80 KB for 267 tasks) and, on
  every launch after the first, **renders the previous session's full list instantly (zero COM
  calls, ~25 ms)** then refreshes the live data in the background. The first-ever launch (no cache)
  shows the user's own tasks first, then the full set — all off the UI thread. Net effect: launch
  no longer waits on the COM walk at all.
- **Instant Task Manager navigation** (`src/app.js` `showPage`): clicking **Task Manager** used to
  re-walk EVERY task via COM on every click (~seconds, felt frozen). The task list is already in
  memory (kept current by boot and by every create/edit/delete/run and `refreshAll`), so the page
  now renders **instantly from cache** (~3 ms measured) and only does the blocking COM fetch when
  there is nothing cached to show. Manual Refresh (R / F5 / 🔄) and auto-refresh still force a fresh
  fetch.
- **Readability** (`src/style.css`): `--text2` (#8896b8→#9aa7c8) and `--text3` (#48547a→#76819f)
  brightened — the old `--text3` failed WCAG AA (~3.4:1) and made descriptions/hints/counts hard
  to read on the dark surface. Template descriptions, section subtitles and settings sub-text were
  promoted from `--text3` to the readable `--text2`.

### Fixed (second pass — the previously-deferred items)
- **`src/app.js` edit form:** Run-Level select is now **locked on edit** (it was editable but
  silently ignored by `update_task`, which preserves the existing privilege level); the Monthly
  "Day of Month" field now shows the **real day** instead of always `1`; **Weekly** triggers now
  **validate ≥1 day-of-week** (a weekly trigger with no days is accepted by Windows but never
  fires); env-var (`cmd /c SET …`) tasks now **route to the lossless XML editor** on edit so the
  vars can't be silently stripped/double-wrapped.
- **`src-tauri/src/scheduler.rs` + `src/app.js`: lossy-edit guard now counts ALL actions.** Added
  `TaskInfo.action_count` (total of every action type); the frontend guard uses it instead of
  `actions.length` (EXEC-only), so a task with one exec + one email/show-message action is now
  correctly routed to the XML editor instead of having the non-exec action silently dropped.
- **`src/features.js` Tamper Watch:** the baseline signature now covers **all actions** (not just
  the first exec) plus the `hidden` flag, catching second-action and stealth tampering. Added a
  signature **schema version** (`FP_SIG_VERSION`) with a silent re-baseline migration so existing
  watchers don't get false "changed" alerts on upgrade.
- **`src/features.js` Recycle Bin:** restoring a task now **captures the current live definition
  into the bin first** (restore uses `TASK_CREATE_OR_UPDATE` and overwrites), so an accidental
  overwrite is itself undoable; fixed a latent bug where the stale trash snapshot would clobber
  that capture; added a **byte-size budget** so a few large XMLs can't exhaust the quota and
  silently drop newer captures.
- **`src/features.js` bulk restore (Backup/Restore):** restoring a `.wtpbak` now **captures each
  existing task it is about to overwrite into the Recycle Bin first** (same `TASK_CREATE_OR_UPDATE`
  overwrite as single-restore) and **reports the overwrite count** in the result panel, so a bad
  bulk restore is undoable.
- **Logging hygiene (Rule 9):** replaced all remaining `console.error(...)` calls (favorites/saved-
  search parse, the three bulk ops, the audit-log persist, the redundant submit-task line) with
  `derror(...)` so failures reach the file logger, and routed the `loadDashboard` catch through
  `derror` (it previously only `console.debug`'d via `setStatus`).
- **Config docs:** corrected the `Cargo.toml` comments (sysinfo still pulls `windows 0.57`, not
  `windows-sys`; CI does not actually enforce `--locked`) and the `dev.json` `local:true`
  description.

### Verification
- `cargo build --release` → **clean** (produces `WinTaskPro.exe` v1.16.0); `node --check` on
  `app.js`/`features.js` → clean. The frontend was rendered (devserver + headless inspect):
  SVG sprite resolves with zero broken refs, the light-theme toggle flips body/hover/badge/
  scrollbar correctly, modal/toast ARIA present, and the injected Favorites/Health/Saved-search
  UI mounts. Three independent adversarial review passes found **zero regressions**.

### Still deferred (low-impact, intentionally not changed)
- `src/features.js`: the backup bundle is delimiter- not length-framed (only breaks on a tab/
  newline inside a task/folder name — essentially never, and changing it would break existing
  `.wtpbak` files).
- CI: enabling `--locked` enforcement in `release.yml` is left as a deliberate, testable step
  (changing the untestable release pipeline for a low-severity nit is riskier than the nit).

---
## [1.15.4] — 2026-06-18 — Taskbar icon: remove AUMID; launch feels responsive

The 1.15.3 taskbar-icon attempts (AUMID relocation, then `.ico` reorder) did NOT
fix it — the taskbar still showed a generic placeholder while the title bar was
correct. Zoomed inspection of the taskbar confirmed a **generic/default** icon
(not a blurry one), which points at app *identity*, not icon resolution.

### Fixed
- **`src-tauri/src/main.rs`: generic taskbar icon — remove the explicit AUMID.**
  The app set `SetCurrentProcessExplicitAppUserModelID("com.nookieai.wintaskpro")`.
  For a **portable exe with no installed Start-Menu shortcut carrying that AppID**,
  Windows resolves the taskbar button's icon from the (nonexistent) shortcut and
  falls back to a generic icon — even though the window's own HICON (title bar) is
  correct. This is why every prior build showed the right title-bar icon and a
  generic taskbar icon. Removed the AUMID call entirely; with no explicit AppID,
  Windows uses the window's own icon (set by tao) for the taskbar button.
  > MUST DO TO TEST: Windows caches taskbar icons aggressively and may keep showing
  >   the old generic one. Clear the cache before judging the fix:
  >     `ie4uinit.exe -show`   (or delete %LOCALAPPDATA%\IconCache.db and the
  >     %LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db files), then
  >     restart explorer.exe — or just test the new exe from a fresh path.
  > The `.ico` reorder from 1.15.3 is harmless and left in place (it slightly
  > sharpens the runtime/tray icon) but was not the fix.

### Changed
- **`src/app.js`: launch no longer looks frozen.** The initial Task Scheduler walk
  is synchronous on the UI thread (STA COM — see notes), so the window appeared to
  hang on a blank/white frame during enumeration. Added three small yields
  (`setTimeout 50ms`) so a loading state actually paints before the blocking call:
  in `init()` (a "Loading your scheduled tasks…" state on the default-visible
  dashboard, before the boot enumeration), and in `loadTasksForFolder` /
  `loadDashboard` (only when they actually fetch — the boot-cache path stays
  instant). This does not make enumeration faster; it makes the app *show progress*
  instead of freezing.
- Version bumped `1.15.3` → `1.15.4` across `package.json`, `Cargo.toml`,
  `tauri.conf.json`, `index.html`, `app.manifest`, and `README.md`.

### Notes — the remaining launch cost (needs a deliberate, tested change)
- The real slowness/hang is architectural: COM is initialised **STA**
  (`COINIT_APARTMENTTHREADED`, scheduler.rs:515) and the `ITaskService` is created
  on the main thread "to match Tauri/tao". `get_all_tasks` is a **sync** command, so
  the ~3s walk of ~260 tasks runs **on the UI thread** and blocks it. The proper fix
  is to run the enumeration on a background thread (its own COM apartment) so the UI
  stays live. That touches the app's core data path and can't be compile/run-verified
  in this environment, so it is **intentionally not bundled here** — it should be a
  focused change built and tested on Windows. 1.15.3 already removed the *duplicate*
  enumeration on boot (2× → 1×); this is about moving the remaining 1× off the UI
  thread.
- The AUMID removal is logic-verified, not compile/run-verified here (no Windows
  toolchain). Build, clear the icon cache, and confirm the taskbar icon.

---
## [1.15.3] — 2026-06-18 — Fixes: taskbar icon + faster launch

Reported from a screen recording: the taskbar button showed a generic icon (the
title-bar icon was fine), and the app took several seconds to populate on launch.

### Fixed

- **`src-tauri/icons/icon.ico`: blurry / generic taskbar icon (the real cause).**
  Tauri's icon codegen (`new_ico`) decodes only **`entries()[0]`** — the *first*
  image in the `.ico` — to produce the runtime window/taskbar icon (tauri-apps
  issue #14596). Our `icon.ico` was ordered smallest-first, so the runtime icon
  was sourced from the **16×16** entry. That renders crisp in the title bar
  (16px) but is upscaled for the taskbar button (32–40px, more on high-DPI),
  producing a blurry blob that reads as "no icon." Reordered the `.ico`
  **largest-first** (256×256 is now `entries()[0]`); all seven sizes are
  retained, so the embedded exe/Explorer/installer icon is unaffected — only the
  entry order changed. The runtime icon now downscales from 256px and is sharp
  at every taskbar size.
  > GOTCHA: don't "tidy" icon.ico back to smallest-first — Tauri only looks at
  >         entries()[0] for the live window icon, so the largest must stay first.

- **`src-tauri/src/main.rs`: taskbar grouping/identity (secondary).** The explicit
  `AppUserModelID` was set inside `.setup()`, which runs *after* the window is
  created. An AUMID must be applied before the first top-level window is shown or
  the taskbar button is grouped under a stale identity. Moved
  `SetCurrentProcessExplicitAppUserModelID` to the top of `main()` (before
  `tauri::Builder`) and removed the duplicate from `.setup()`. This is about
  correct taskbar grouping/pinning identity for the portable exe; the icon
  *resolution* fix is the `.ico` reorder above.

- **`src/app.js`: ~3s of redundant work on every launch.** `get_all_tasks` walks
  every Task Scheduler folder over COM (~3s for ~260 tasks). On boot the folder
  counts (`refreshFolders`) and the dashboard (`loadDashboard`) each enumerated
  independently — two full walks back to back. `init()` now fetches the list
  **once** into a one-shot `_bootAllTasks` and hands the same array to both.
  `loadDashboard` consumes it (resets it to `null`), so every later refresh —
  manual, auto, or after creating/editing/deleting a task — fetches fresh and can
  never show stale data. Halves the cold-launch task-enumeration time.
  > GOTCHA: `_bootAllTasks` is non-null only during the boot window. It is read
  >         by `refreshFolders` (no clear) and consumed/cleared by the first
  >         `loadDashboard`. It is never used by `loadTasksForFolder`, the
  >         timeline, or any mutation path, so there is no staleness surface.

### Changed
- **`src/index.html`: white flash on cold start.** WebView2's default surface is
  white, so the window flashed white for a moment before `style.css` loaded. Added
  an inline `html,body{background:#0a0d18}` rule at the top of `<head>` so the page
  paints dark the instant the HTML is parsed. (The brief native pre-render frame
  before WebView2 attaches is inherent to a portable WebView2 app and isn't
  addressed here.)
- Version bumped `1.15.2` → `1.15.3` across `package.json`, `Cargo.toml`,
  `tauri.conf.json`, `index.html`, `app.manifest`, and the `README.md` badge +
  installer filenames.

### Notes
- The `icon.ico` reorder is just a data-file change (no code compiled), so it is
  low-risk; the runtime icon will pick up the 256px first-entry on the next build.
- The AUMID relocation is logic-verified but **not** compile/run-verified here (no
  Windows toolchain in this environment — the `windows` crate can't build on
  Linux). Build on Windows and confirm the taskbar icon is sharp before tagging.
  If grouping ever misbehaves on pin/unpin, the documented remedy is to ship a
  Start-Menu shortcut whose `System.AppUserModel.ID` matches the AUMID (the NSIS
  installer can do this); the icon itself no longer depends on the AUMID.

---
## [1.15.2] — 2026-06-16 — Docs: GitHub-release usage README

### Changed
- **`README.md` rewritten as an end-user, GitHub-`.exe`-usage document only.**
  Download / first-run (SmartScreen + UAC) / updating / feature tour / FAQ for
  people running the published release. The build-from-source and AI-agent
  pointers were removed from the README body — that material lives in
  `SETUP.md` / `AGENT_RULES.md` / `HANDOVER.md` and is reachable from the repo
  file list, not the user-facing README. The README now documents the 1.15.1
  safe-editing behaviour (Author preservation, the multi-trigger/action guard,
  the lossless `＜/＞ Edit XML` editor, and that edits never rename in place) so
  users understand *why* editing is safe, plus new "Will editing a system task
  break it?" and "My antivirus flagged it" FAQ entries.
- Version is **1.15.2** across `package.json`, `Cargo.toml`, `tauri.conf.json`,
  `index.html`, `app.manifest`, and the README badge + installer filenames.

> NOTE: the version files were already at 1.15.2 when this entry was written
>       while the changelog stopped at 1.15.1. This entry closes that gap so the
>       documented version matches the build. 1.15.2 carries the 1.15.1
>       safe-editing fixes — no separate 1.15.1 build was published.

---
## [1.15.1] — 2026-06-16 — Audit: safe task editing (no silent corruption)

Deep-dive audit pass focused on "tasks must always edit safely, never corrupt."
IPC wiring was verified complete (all 54 `invoke()` targets registered and
defined; the historical `_editTaskPath`, `update_task` folder-key, and shared
`apply_triggers_to_definition` fixes are all still intact). Two real corruption
paths were found and fixed, plus one stub-consistency fix.

### Fixed

- **`src-tauri/src/scheduler.rs` `update_task`: editing a task no longer blanks
  its Author.** The simple-form editor has no Author field, so `p.author` is
  always `""` on an edit, and `update_task` rebuilds the whole definition —
  meaning every edit overwrote the task's Author with empty (e.g. wiping
  "Microsoft Corporation" off a system task). `update_task` now reads the
  existing `RegistrationInfo().Author` up-front and preserves it when the
  incoming author is empty, mirroring the existing principal-preservation
  pattern. A non-empty supplied author still wins.
  > GOTCHA: `update_task` is a full rebuild, not a merge. Any field the edit
  >         form doesn't surface must be preserved from the existing task here,
  >         or it is silently reset on save. Author was the one such field.

- **`src/app.js`: editing a multi-trigger or multi-action task no longer
  silently discards the extras.** The simple form models exactly one trigger and
  one action; `extract_task` only reads trigger/action `[0]`; and `update_task`
  rebuilds from the form. So saving a task that had 2+ triggers or 2+ actions
  (common for Microsoft system tasks) destroyed the extras. `openEditDialog`
  (the single chokepoint for every edit entry point) now detects
  `triggers.length > 1 || actions.length > 1` and routes to a chooser
  (`openComplexTaskEditChoice`) offering the new lossless raw-XML editor or an
  explicit, clearly-labelled "use simple editor anyway" (gated behind
  `opts.allowLossy`). Single-trigger/single-action tasks are unaffected.
  > GOTCHA: The XML tab inside the create/edit dialog is generated *from the
  >         form* and is ignored by `submitCreateTask` — it is a preview, not a
  >         save path. It does not preserve anything the form can't model.

### Added

- **`src/app.js`: lossless single-task XML editor (`openXmlEditor` /
  `submitXmlEditor`).** Loads the task's real definition via the existing
  `export_task_xml` IPC, lets the user edit it, and re-registers it in place via
  the existing `import_task_xml` IPC (`TASK_CREATE_OR_UPDATE`). **No new Rust
  commands** — this wires up primitives that were already registered (the same
  export→edit→import path the bulk find/replace feature already uses). Reachable
  from the chooser above and from a new "＜/＞ Edit XML" context-menu item.
  Folder + name are derived from the task's path (its identity), never a form
  field, so a re-import can never duplicate or relocate the task (Rule 45).
  > GOTCHA: Save leaves the modal open on failure so a bad edit can be corrected
  >         and retried — same retry-safety principle as `submitCreateTask`.

- **`src-tauri/src/main.rs`: `create_task` `#[cfg(not(windows))]` stub now takes
  `(_params: CreateTaskParams, _state)`** to match the Windows signature and
  every other command's stub. Harmless on shipping (Windows-only) builds but was
  the one stub that dropped its arg — fixed for consistency / dev-time clarity.

### Changed

- Version bumped `1.15.0` → `1.15.1` across `package.json`, `Cargo.toml`,
  `tauri.conf.json`, `index.html` (version pill), and `app.manifest`
  (`1.15.1.0`).

### Noticed but not changed
- `src-tauri/src/scheduler.rs` `update_task` intentionally preserves the
  existing logon type / run level / user for non-service accounts, so the Run
  Level dropdown and Run As field in the edit form are effectively display-only
  on existing tasks (deliberate, to avoid breaking system tasks — see the
  function's header comment). Left as-is; flagging for visibility.
- `src-tauri/src/log.rs` is a dead orphan (the pre-rename copy of `devlog.rs`);
  it is not declared as a `mod`, so it never compiles. Safe to delete whenever.
- `HANDOVER.md` references a stale "2.1.0" in several places while the project
  is on the 1.x line. Doc-only; not touched.

---
## [1.15.0] — 2026-06-11 — Feature release: recycle bin, tamper watch, true test run, activity digest, timeline, result explainer, full backup, command palette

Eight new features, all implemented in a single self-contained frontend
module (`src/features.js`) on top of IPC commands that already existed —
**no new Rust commands**, so the Tauri command surface is unchanged. The
module is loaded after `app.js` in `index.html`.

### Fixed (post-release, 2026-06-11) — startup hangs & UI freezing (round 2, "quick wins")

Frame-by-frame analysis of a 75s screen recording showed the window going
**"(Not Responding)"** during task/process loads — the main UI thread was
blocked by synchronous COM enumeration. This batch is the low-risk subset of
fixes (the full async/worker-thread refactor is tracked separately):

- **System tasks are skipped at the source when hidden.** `get_all_tasks`
  gains a `skip_system` parameter; when "Show system tasks" is off, the Rust
  COM walk now skips the `\Microsoft\` and `\Windows\` folder subtrees
  entirely instead of enumerating ~250 system tasks and discarding them in JS.
  Wired into the dashboard, the all-folders list, folder-badge counts, and
  global search. The folder tree still lists every folder; clicking into a
  system folder loads just that one. Turning off "Show system tasks" now gives
  a large speedup (a 267-task walk becomes the user's handful).
- **Elevation now happens once, at launch.** The app was launching
  non-elevated despite `app.manifest` declaring `requireAdministrator`, so the
  user had to click "Restart as Admin" and pay the full task-enumeration cost
  twice (once unprivileged, once elevated). Root cause: `tauri_build::build()`
  does **not** embed a custom manifest — it uses Tauri's default `asInvoker`.
  `build.rs` now embeds `app.manifest` explicitly via
  `WindowsAttributes::app_manifest`, and the manifest gained the
  `Microsoft.Windows.Common-Controls` v6 dependency required when replacing
  Tauri's default manifest. The app now elevates at launch (one UAC prompt,
  one load).
- **Auto-refresh timers no longer freeze a window nobody is looking at.** The
  dashboard (30s), Live Monitor (3s), Process Manager, and the global
  auto-refresh now skip their refresh while the window is hidden/minimised
  (`visibilitychange` gate), and refresh once on return to visibility. Live
  Monitor also has an in-flight guard so a slow `get_running_tasks` cannot
  stack behind the previous one.

> NOTE: these reduce the *frequency* and *amount* of main-thread blocking.
> Eliminating the freeze entirely requires moving COM off the main thread
> (async commands + dedicated COM worker thread), tracked as the next change.



- The portable exe showed no taskbar / Alt-Tab icon. Two causes:
  1. **`src-tauri/icons/icon.ico` contained only a single 256×256 image**
     (PNG-compressed inside the ICO). The Windows taskbar and Alt-Tab switcher
     use the 16×16 and 32×32 frames, which were absent — so Windows fell back
     to the generic default icon. This hit the portable build hardest because,
     unlike the installer, it has no Start-Menu shortcut whose icon the taskbar
     could borrow. Regenerated `icon.ico` as a proper **multi-resolution** ICO
     (16 / 24 / 32 / 48 / 64 / 128 / 256), with the small sizes as real 32-bit
     BMP frames (with AND mask) rather than a lone PNG. `tauri-build` embeds
     this into the exe resource, so the taskbar can now select the right size.
  2. **No AppUserModelID was set at runtime.** The installed build inherits one
     from its shortcut; the portable exe does not, so its taskbar button could
     fall back to a blank icon and group incorrectly. Added
     `SetCurrentProcessExplicitAppUserModelID("com.nookieai.wintaskpro")` in the
     Tauri `setup()` closure (Windows-only, non-fatal on failure). Requires the
     already-enabled `Win32_UI_Shell` feature — no Cargo change.

### Fixed (post-release, 2026-06-11) — digest performance regression

- The **While You Were Away** dashboard card read the Windows Event Log via
  `search_event_history`, which spawns `powershell.exe Get-WinEvent` (a cold
  start of one to several seconds, and a child process antivirus inspects on
  an unsigned exe). Because the dashboard auto-refreshes every 30 seconds, the
  initial implementation re-spawned PowerShell **every 30 seconds**, making the
  built portable exe feel sluggish. Fixed with a 5-minute TTL cache on the
  digest events: the dashboard's repeated refreshes now reuse the cached
  result, so PowerShell is spawned at most once every 5 minutes instead of
  every 30 seconds. The first dashboard digest read is also deferred ~600 ms so
  it never competes with the initial `get_all_tasks` enumeration and first
  paint. The **🌙 Activity** modal passes `force:true`, so an explicit open is
  always a live read. Verified: three dashboard-style calls within the TTL
  collapse to a single IPC spawn; `force:true` correctly bypasses the cache.


  Scheduler XML first; an Undo banner appears for 8 seconds, and a new
  **Recycle Bin** page (sidebar) keeps the last 50 deletions for one-click
  restore. Wired into both single-task delete and bulk delete. System tasks
  that cannot be exported are simply not captured (delete still proceeds).
  Storage: `localStorage['wtp_trash']`. Restore re-registers via
  `import_task_xml`.
- **Tamper Watch (definition drift).** A new **🛡 Watch** button on the task
  detail panel snapshots the security-relevant fields of a task (program,
  arguments, working dir, trigger, run-as account, run level, enabled). If
  any of those later change, a red **Tamper Watch** card appears on the
  dashboard listing exactly what changed, with a "was / now" diff and a
  re-trust action. Complements the existing executable-hash integrity check
  by catching argument/trigger edits that malware uses for persistence.
  Storage: `localStorage['wtp_trust_baseline']` (FNV-1a signature).
- **Run Now (true test run).** A new **▶ Run Now** button triggers the real
  registered task under its actual run-as account and conditions (via
  `run_task`), polls for completion, and reports the genuine result code with
  a plain-English explanation. Distinct from the existing 🧪 Test Run, which
  runs the program directly as the current user with stdout/stderr capture.
- **"While You Were Away" activity digest.** A dashboard card (and a
  **🌙 Activity** topbar button) summarising the last 24 hours of task
  starts / completions / failures, read from the Task Scheduler operational
  log via `search_event_history`. Lists the most frequently failing tasks.
  Degrades gracefully when the operational log is disabled.
- **Next-24h timeline.** A **🕒 Timeline** topbar button opens an hourly
  density chart of every run scheduled in the next 24 hours, so clustered
  firings (e.g. several jobs all at 3 AM) are visible at a glance, with a
  click-through list. Pure client-side over each task's next-run time.
- **Failure-code explainer.** A small **?** badge next to "Last Result" in
  the detail panel decodes the HRESULT into cause + "what to check" advice
  (~25 common codes: 0x80070002 file not found, 0x800704DD not logged on,
  0x80070005 access denied, time-outs, etc.). Unknown codes get a useful
  generic frame pointing at Test Run. Also surfaced inline in Run Now output.
- **Backup / Restore all tasks.** A **💾 Backup / Restore** button in
  Settings → Export & Backup downloads every user task as a single
  dependency-free `.wtpbak` bundle, and restores tasks from such a bundle
  with per-task collision reporting. Windows/Microsoft system tasks are
  excluded from backup. Restore overwrites same-named tasks
  (`TASK_CREATE_OR_UPDATE`).
- **Command palette (Ctrl+K).** A fuzzy launcher to jump to any task,
  navigate to any page, or run an action (new task, refresh, timeline,
  digest, backup). Subsequence matching with keyboard navigation; opens from
  anywhere including inside inputs. Also reachable via a **⌘ Palette** topbar
  button.

### UI / UX

- New **Recycle Bin** sidebar entry and page.
- Task detail action bar gains **▶ Run Now** and **🛡 Watch** buttons; the
  Watch button reflects watched state (label + colour).
- Tasks topbar gains **🕒 Timeline**, **🌙 Activity**, and **⌘ Palette**
  buttons next to Integrity.
- Dashboard gains the Tamper Watch drift card (only when there is drift) and
  the activity digest card (loaded asynchronously so it never blocks paint).
- Settings → Export & Backup gains the Backup / Restore row.
- Help modal documents the new Ctrl+K shortcut.
- All new styles use existing `:root` design tokens, so both light and dark
  themes render correctly. 87 new CSS rules under the `fp-` namespace,
  appended to `style.css`.

### Verified

- `node --check` clean on both `app.js` and `features.js`.
- ESLint over the concatenated app+features unit: zero real errors (only the
  four pre-existing Date-mutation false positives).
- Handler-resolution sweep across `index.html` + `app.js` + `features.js`:
  every inline `onclick` target resolves.
- ID sweep: 0 missing of 199 referenced IDs across both JS files.
- Logic unit tests pass: `explainResultCode` (known + unknown + success),
  `fpFuzzy` (hit/miss/prefix), `fpParseBundle` (round-trip + garbage
  rejection).
- IPC parameter names verified against existing call sites
  (`startIso`/`endIso`/`eventIds`/`maxRecords`, `folder`/`name`/`xml`,
  `path`).
- **Not verified in this environment:** `cargo check` / full Windows build
  (no Rust toolchain). No Rust changed this release, so risk is low, but a
  build on Windows is still the final gate.

---
## [1.14.4] — 2026-06-11 — Audit release: duplicate-edit fixes, path-mangled handlers, CSV formula guard, updater URL pinning

Cumulative audit release. User-visible fixes: editing from the dashboard,
compare modal, and collision table no longer risks creating duplicate
tasks; the task name is read-only in edit mode; Process Manager "Open
file location" works; notification state no longer replays stale failures;
CSV exports are formula-injection-guarded; "Still Running" renders at the
correct size. Hardening: the in-place updater only accepts assets from the
canonical NookieAI/WinTaskPro releases. Plus dead-code removal
(`log.rs` finally deleted) and documentation corrections.

### Fixed (audit 2026-06-11 — edit-path duplicates, inline-handler path mangling, update-URL pinning)

- **`src/app.js` `openEditDialog`**: four call sites (compare modal footer,
  dashboard "unfireable tasks" rows, trigger-collision table cells) passed a
  task PATH STRING to a function that expects the task OBJECT. Every property
  read was `undefined` — including `task.path`, so `_editTaskPath` stayed
  falsy and Save routed to `create_task`, silently creating a duplicate (the
  exact regression class documented in HANDOVER.md "editing tasks is broken").
  `openEditDialog` now resolves string arguments against `allTasks` and shows
  "Task not found — refresh and try again" (with `derror`) when resolution
  fails, restoring the log line HANDOVER.md already documents.

- **`src/app.js`** (same four call sites + 2× `procActionOpenLocation`):
  values were interpolated into single-quoted inline-`onclick` JS with only
  `'` escaped. Inside a JS string literal, `\M`, `\W`, `\P`… are escape
  sequences — the backslash is dropped — so `\Microsoft\Windows\Foo` arrived
  as `MicrosoftWindowsFoo` and `C:\Program Files\x.exe` as
  `C:Program Filesx.exe`. The dashboard Edit rows and the Process Manager
  "Open file location" button could never have worked on real paths.
  All six sites now use `escHtml(JSON.stringify(value))`: JSON produces a
  valid JS string literal (backslashes + quotes escaped), escHtml makes it
  attribute-safe, and the browser's entity decode restores it before JS
  parses. Round-trip verified character-exact.
  > GOTCHA: never interpolate Windows paths into single-quoted inline JS.
  >         `escHtml(JSON.stringify(v))` is the canonical transform for any
  >         string argument inside an `onclick="fn(...)"` attribute.
  >         (`confirmKillProcess(pid, name)` sites keep the old escaping
  >         deliberately — image names cannot contain `\`.)

- **`src/app.js` `openEditDialog`**: the Task Name field is now read-only in
  edit mode (greyed, tooltip explains export/import is the rename path).
  Rust `update_task` registers the definition under `params.name` in the
  source folder — renaming in the form registered a NEW task under the new
  name while the original survived: silent duplication. Read-only-on-edit
  matches Windows' own Task Scheduler MMC, which has no rename either.

- **`src/app.js` `refreshAll`**: the `_prevTaskResults` seeding line said
  "regardless of notify state" but sat INSIDE the `notifyEnabled` block, so
  the map froze while notifications were off and re-enabling them replayed
  every interim state change as a fresh "task failed" alert. Seeding is now
  unconditional, matching the comment's stated intent.

- **`src-tauri/src/main.rs` `download_and_install_update`**: URL allowlist
  pinned only the hostname (`https://github.com/` + contains `/releases/`),
  admitting ANY repository's release assets — a hostile fork's payload passes
  the PE format check by construction. Now pinned to
  `https://github.com/NookieAI/WinTaskPro/releases/`, which is also what the
  frontend's "published to a fork" error diagnosis already assumed. Legit
  updates unaffected: `checkForUpdate` only ever supplies
  `browser_download_url` values under that prefix.

### Fixed (audit 2026-06-11, round 2 — UI polish + doc truth)

- **`src/style.css`**: removed a stray duplicate `.result-running` rule
  (line ~580) that overrode the canonical 12px to 11px — "Still Running"
  rendered one pixel smaller than Success/Error/Not Run in the same Last
  Result column. The `#task-table thead th { overflow: visible }` duplicate
  was inspected and kept: it's a documented augmentation for resize handles,
  not a contradiction.
- **`HANDOVER.md`**: file inventory and the debugging table claimed
  `sysinfo 0.31 + windows 0.58`; Cargo.toml actually pins
  `sysinfo 0.32 + windows 0.61` (lock: 0.32.1 / 0.61.3) and SETUP.md already
  said 0.32. Following the stale debugging row would have "fixed" a build by
  downgrading and breaking the deliberate windows-0.61 alignment. Also: the
  logging section said WARN/ERROR flush immediately, but `devlog.rs::log_line`
  deliberately flushes every line (its comment explains why); added a
  debugging-table row for the inline-handler path-mangling class fixed in
  round 1; footer date refreshed.

Verified-clean this round (no changes needed): all 112 inline-handler
targets in index.html + innerHTML strings resolve to defined functions;
stat-pill click filtering is wired; PS1 brace/paren balance on all three
scripts (build_portable.ps1's raw-count offset is a `}` inside a string);
no script-level `$ErrorActionPreference = 'Stop'`; README coupled-files
table already includes app.manifest; devlog rotation drops its file handle
before rename (Windows requirement); persistent-sysinfo invariant holds.

### Audit round 4 (2026-06-11) — final coverage pass, no code changes

Remaining unread surfaces were read or mechanically swept; all clean:
`extract_task` (correct bitmask sign handling incl. monthly bit-31 last-day
flag; resolves the date-sort question — `ole_date` emits lexicographically
sortable `YYYY-MM-DD HH:MM:SS (UTC±…)`), full `openCreateDialog` (mask
inputs live in the Advanced tab so the weekly/monthly round-trip is intact;
edit mode showing compiled `program+args` instead of script-type sugar is
correct round-trip design), all raw-Win32 process functions (handles closed
on every path including mid-function error returns; NTSTATUS sign checks;
snapshot caps; cycle-guarded leaves-first tree kill), `main()` setup/tray,
`get_process_connections` (correct network-byte-order idiom; graceful
size-race fallback), devlog `read_tail`, `loadDashboard`. Mechanical
sweeps: all 187 `getElementById` targets are created somewhere (0 dead
features); every `JSON.parse(localStorage…)` is try-guarded;
interval-clear pairing is clear-heavy; `wintaskpro-clean.ps1` restore
verifiably creates its safety backup first and aborts if that fails;
UPDATER.md claims match the implementation.

Known but not changed: connections panel is AF_INET only (IPv6 sockets
not listed — display limitation); `run_task_test` reader-thread joins can
outlive the 60 s kill if a tested script's detached grandchild inherits
the stdout pipe (fix = incremental-read restructure, tracked from round 3).

### Fixed (audit 2026-06-11, round 3 — CSV formula injection)

- **`src/app.js`** new shared `csvCell()` (beside `escHtml`) wired into all
  three CSV exports (`exportTasksCsv`, `exportAuditLogCsv`, `procExportCsv`).
  Previous escaping handled CSV *structure* (quote-doubling) but not formula
  injection: Excel/LibreOffice execute cells beginning with `=` `+` `-` `@`
  (and tab/CR variants), so a scheduled task or process literally *named*
  `=cmd|' /c ...'!A1` would detonate inside the admin's exported
  spreadsheet — squarely in this app's threat model, since the integrity
  feature exists because task definitions get tampered with. `csvCell`
  prefixes a `'` to force text interpretation, leaves purely numeric cells
  unprefixed (PID/CPU/MB columns still sort and sum), and always
  RFC-4180-quotes. Unit-tested against 10 cases including `=cmd|x`, `-5`,
  `@SUM(A1)`, embedded quotes, tab-prefix, null, and plain text.
  > GOTCHA: any future export must go through `csvCell`, not ad-hoc
  >         quote-doubling — structure-escaping alone is not enough for
  >         files opened in Excel.

Verified-clean round 3 (no changes needed): `get_event_log_history` /
`search_event_history` PowerShell interpolation uses complete single-quote
doubling with numeric-typed IDs/max — no injection; `move_task` orders
export → import → delete-last with partial-success messaging; `hash_file`
streams in 64 KB chunks; `run_task_test` uses threaded pipe readers +
try_wait polling + kill-and-reap (no sequential-read deadlock);
`days_to_ymd` matches Hinnant's civil_from_days exactly and the OLE epoch
constant (25569) and timezone-bias sign/DST handling are correct;
`get_task_history` frees the COM buffer on every path; `healthScore` uses
authoritative numeric codes; init ordering sound; devserver.js path-
traversal guard intact; release.yml asset name/path matches both the
updater's tier-1 matcher and the tightened URL allowlist; full innerHTML
interpolation sweep found zero unescaped user-controlled values.

### Removed (audit 2026-06-11)

- **`src-tauri/src/log.rs`** — the `### Removed` entry above documented this
  deletion, but the file was still physically present in the project zip; the
  duplicate-macro tripwire it describes was therefore still armed. Deletion
  is now actually performed. Verified: `mod devlog;` is the only logger
  module declaration; zero `crate::log::` references remain.
- **`src/app.js` `notifyFailure`** — never called. The failure path in
  `refreshAll` flashes the taskbar inline, deliberately ONCE per refresh tick
  for all failures; this uncalled per-task duplicate misled readers (the old
  comment even pointed at it as "the implementation"). Comment corrected.
- **`src/app.js` `renderProcessManager`** — zero call sites. Its comment
  claimed `confirmKillProcess` used it as a "compatibility entry point", but
  every refresh path calls `refreshProcessData()` directly.
- **`src/app.js` `computeNextFirings`**: removed the `ensureFuture` stub
  (body was a bare `return d;` that never implemented its own comment, zero
  callers — Rule 43) and four destructured-but-unused fields
  (`intervalStartTime`, `repeatInterval`, `repeatDuration`, `idleMinutes`);
  the Interval preview reads its start through the `startDateTime` fallback
  chain built in `renderSchedulePreview`.


*(The sections below this point are the earlier audit sub-pass that
preceded rounds 1–4 above.)* Targeted-repair pass from a deep-dive code
audit. No behaviour changes for end users within this sub-pass; tightens
debuggability and removes stale documentation that would mislead the next
agent.

### Removed

- **`src-tauri/src/log.rs`** — dead code per `BUILD_AUDIT.md` §1.1.
  Renamed to `devlog.rs` in 2.1.0 because of a namespace collision with
  the external `log` crate (Tauri's transitive dep), but the old file was
  never deleted. `main.rs` declares `mod devlog;` only — `log.rs` is not
  referenced anywhere. The file is a tripwire because both `log.rs` and
  `devlog.rs` define `#[macro_export] macro_rules! log_info!` etc., so the
  instant a future agent adds `mod log;` (e.g. assuming `log.rs` is the
  canonical filename), the crate fails with a confusing duplicate-macro
  error rooted at the crate prelude, not at the duplicate site itself.

  Verification (run on Windows):
  ```powershell
  cd src-tauri
  cargo clean
  cargo check        # must pass; if it fails, log.rs WAS still being used
  ```

### Fixed

- **`AV_SAFETY.md` — Network access section had two factual errors that
  would mislead the AV-vendor / IT-admin audience this doc explicitly
  targets:**

  1. Claimed the update check hits
     `https://github.com/.../releases/latest/download/latest.json`.
     That's the Tauri **plugin-updater** convention. This app explicitly
     does **not** use plugin-updater (see `BUILD_AUDIT.md` §2.1 and
     `UPDATER.md`); it uses the simpler in-place self-replace flow which
     hits the GitHub REST API directly:
     `https://api.github.com/repos/NookieAI/WinTaskPro/releases/latest`.
     The CSP `connect-src` in `tauri.conf.json` (`https://api.github.com`)
     also confirms this — it doesn't include `github.com` because the JS
     doesn't fetch from there.

  2. Claimed "the response signature is verified before any update is
     applied". That's also a plugin-updater feature this app doesn't
     have. The actual check in `verify_pe_file()` is a **PE format
     sanity check** (MZ DOS header + offset-to-`PE\0\0` magic + size
     bounds), not a cryptographic signature. The crypto-signed updater
     is in `UPDATER.md` as future work. Doc now says exactly that, with
     the URL and the format-check details.

- **`src/app.js` `applyTheme()` dark branch** previously set 16 specific
  hex values that were subtly different from the `:root` defaults in
  `style.css` — e.g. `--bg2` was `#111422` in the JS vs `#0f1220` in the
  CSS; `--text3` was `#535e7a` vs `#48547a`. A user toggling light → dark
  landed on a different palette than they had on initial load. Drift
  was below human perception threshold but a real correctness bug
  (flagged in pass 3 as "noticed but not changed"; resolved here).

  Fix: replaced the 16 `setProperty` calls with `removeProperty` so the
  cascade falls back to `:root` in `style.css`. `:root` is now the
  single source of truth for the dark palette; designers edit one place
  and both initial-load and post-toggle agree byte-for-byte.

### Fixed (UI/UX)

- **`src/style.css`** + **`src/app.js`**: sidebar nav and folder text was on
  `--text3` (#48547a) which sits at ~3.4:1 contrast against the sidebar bg
  — **below WCAG AA's 4.5:1 minimum for body text**. User-reported as
  "fonts need to be whiter/easier to read"; root cause was an
  accessibility failure, not a stylistic preference.

  Bumped one tier up the existing palette hierarchy:
  - `.nav-item` default → `--text2` (~7:1, passes AA), hover → `--text`
  - `.folder-item` same escalation
  - `.folder-count-badge` → `--text2` so the count number matches its
    folder name's brightness instead of looking ghosted next to it
  - `.version-pill` (sidebar header chip) → `--text2` for the same reason
  - `applyDetailTabState()` inactive tab colour → `--text2` so the
    brightening survives a tab switch (the function was overriding
    `--text3` inline every render)

  No new variables introduced. Both light and dark themes already define
  `--text2` with WCAG-AA-passing values for their respective sidebar bgs
  (#4a5275 on white, #8b96b0 on dark) so one CSS change works for both.

- **`.github/workflows/release.yml`**: header comment showed
  `git tag v1.14.3 && git push origin v1.9.1` — copy-paste typo from an
  old version. Both halves now name the same tag. No CI behaviour change,
  but the snippet was directly copy-pasteable and would have pushed the
  wrong tag.

- **`src/app.js`** (detail-panel tabs at `~line 947`): in a 384px panel,
  7 tabs at `padding: 8px 14px` overflowed the visible area and the
  scrollbar was easy to miss — visible in user screenshot as the
  "History" tab rendered as "Histor". Tightened to `padding: 7px 10px`,
  bumped font 12.5px → 13px to match the sidebar readability pass.
  Container already had `overflow-x: auto` so any remaining spill still
  scrolls — but now spill is rare instead of guaranteed.

- **`src/app.js`** (`openCreateDialog` browse-button wiring): three
  IPC catches around `browse_for_file` / `browse_for_folder` were
  `catch (_) { /* cancelled or error — ignore */ }` — they silently
  swallowed every kind of error, including legitimate COM / dialog
  failures. Replaced with a discriminator that swallows
  `Err("cancelled")` (the explicit user-cancel return from the Rust
  side) and logs anything else via `derror()`. Rule 9 — no empty
  catches on IPC.

  > GOTCHA: the Rust side returns `Err("cancelled".into())` (lowercase)
  >         for user-cancel of both file and folder pickers. Don't change
  >         that string without updating the `isCancel` helper in the
  >         browse-button wiring block.

- **`src/app.js`** (`loadScheduledRunTimes`): `get_task_history` IPC
  failure showed "History unavailable" with zero diagnostic. A user
  reporting "no history shows up" had no breadcrumb in
  `wintaskpro.log` to explain whether the IPC itself failed, the
  scheduler permission was missing, or COM threw. Now logs via
  `derror('loadScheduledRunTimes', ...)` with the task path and error
  string before falling back to the unavailable message — UI unchanged.

- **`src/app.js`** (`procActionAffinity`): `get_cpu_count` IPC failure
  silently fell back to an 8-core default, which meant a user on a
  4-core or 32-core machine could see the wrong number of checkboxes
  in the CPU-affinity modal if the IPC ever flaked. Still falls back
  to 8 (deliberate — modal must open), but now emits
  `dwarn('procActionAffinity', ...)` so the symptom is grep-able.

### Added

- **`.github/workflows/release.yml`**: two new pre-build CI gates run
  immediately after `npm ci` and before the 2-3 min Rust compile:

  1. `node --check src/app.js` — fast-fail (<1s) if the frontend has
     a syntax error. Previously a syntax error wouldn't surface until
     the whole release build completed and the bundled WebView tried
     to load the broken script. Now it fails CI in seconds.
  2. `cargo metadata --locked --offline` — informational drift check
     for `Cargo.lock`. Currently `continue-on-error: true` because the
     lockfile is known stale (see "Known but not changed" below).
     Flip to required once the lockfile is refreshed on Windows.

- **`build_portable.ps1`**: matching local `Step 4.5 — Verifying
  frontend JS syntax` runs `node --check` on `src/app.js` and
  `devserver.js` before the cargo build. Same fast-fail rationale as
  CI; saves a 1-15 min Rust compile per attempt when iterating on JS.
  `$TotalSteps` base bumped from 6 to 7 to account for the new step.

### Changed

- **`HANDOVER.md`**: file-inventory table claimed `app.js` was
  `~4400 lines`. Actual count is 9329 — the frontend roughly doubled
  since the handover doc was last refreshed. Updated to `~9300 lines`
  so the next agent has an accurate mental model of the file's size
  before opening it.

- **`SETUP.md`**: troubleshooting row for "sysinfo compile error
  (2 args vs 1)" referenced `sysinfo 0.31`. The project moved to
  `sysinfo = "0.32"` in `Cargo.toml`. Refreshed the row to point at the
  current pin and the general rule that 0.x crates aren't semver-stable.

### Known but not changed

- **`src-tauri/Cargo.lock` is stale relative to `Cargo.toml`.**
  `Cargo.toml` pins `sysinfo = "0.32"`, but `Cargo.lock` had
  `sysinfo v0.31.4`. The most recent release build shows cargo
  silently rewrote the lockfile mid-build:

  > `Updating sysinfo v0.31.4 -> v0.32.1 (available: v0.38.4)`

  This means the build is currently non-deterministic across machines.
  Fix on Windows (cannot be done from a non-Windows environment):

  ```powershell
  cd src-tauri
  cargo update -p sysinfo
  git add Cargo.lock
  git commit -m "chore(deps): refresh Cargo.lock to match sysinfo 0.32 pin"
  ```

  Once Cargo.lock is in sync, drop `continue-on-error: true` from the
  "Check Cargo.lock is in sync" step in `.github/workflows/release.yml`
  so drift becomes a hard CI failure instead of a warning. Adding
  `--locked` to the `tauri build --no-bundle` invocation (via
  `"build:portable": "tauri build --no-bundle -- --locked"` in
  `package.json`) is the second half of that hardening.

- **Other `catch (_) {}` blocks in `src/app.js`** (28 remaining):
  triaged. All are legitimate Rule 9 cases — `localStorage` ops in
  quota-exceeded / private-browsing territory with sane fallbacks,
  plus the self-protection catches inside `dlog()` and the
  `window.onerror` handler that MUST not throw or recurse. Not
  changed.

- **`cargo fmt --check` CI gate not added.** The project has no
  `rustfmt.toml` and uses heavy column-alignment in struct fields and
  the `Cargo.toml` dependency block that rustfmt's default would
  strip. Adding the gate without first checking a config in would
  fail loudly on the first run.

---
## [1.14.3] — 2026-04-28 — Real silent updater + threads + CPU + notifications

The first version of v1.14.2 actually shipped a binary, which immediately
surfaced four real bugs that had been latent since v1.14.0 and had been
hidden by the broken build pipeline. All four are fixed here.

### Fixed — Updater STILL flashing console windows

v1.14.2 was supposed to be silent. It wasn't. The cmd-helper spawn was
flagged as `DETACHED_PROCESS | CREATE_NO_WINDOW`. Per Microsoft docs,
those two flags **conflict** and their combination is undefined.

In practice the result was: cmd had no console attached. When the batch
script then ran console-subsystem children — `tasklist`, `timeout`,
`robocopy` — each of them, finding no console attached to its parent,
called `AllocConsole()` to allocate one of their own. **That created
a brief visible console window for each.** The user saw multiple flashes.

- **`src-tauri/src/main.rs`: dropped `DETACHED_PROCESS`.** Now uses
  `CREATE_NO_WINDOW` alone. cmd has a hidden console; child programs
  inherit it; nothing visible. The helper still survives parent exit
  (Rust's `Command::spawn()` is fire-and-forget on Windows by default),
  so the rationale for `DETACHED_PROCESS` was wrong from the start.

  > GOTCHA: `DETACHED_PROCESS` is for processes that explicitly want NO
  >         console at all. `CREATE_NO_WINDOW` is for processes that want
  >         a console but kept hidden. Use only one. Combining them is a
  >         common mistake and Microsoft documents it as undefined.

### Fixed — Threads column always shows `—`; total threads `0`

Process Manager's per-row Threads column showed `—` for every row, and
the system overview header showed `0 / 170,873` for THREADS / HANDLES.
Threads count was permanently zero.

**Root cause:** `get_all_thread_counts()` calls
`CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)` and reads `cntThreads`
from each `PROCESSENTRY32W` record. Reports from the field showed this
returning an empty map on at least one Windows 11 configuration —
likely an EDR / Defender ASR rule that blocks `TH32CS_SNAPPROCESS`
enumeration but leaves `TH32CS_SNAPTHREAD` alone (asymmetric policy,
which is dumb but real).

**Fix:**
- **Primary path** unchanged: `TH32CS_SNAPPROCESS` + `cntThreads` field.
  Cheapest: one record per process.
- **Fallback path added:** if the primary returns an empty map, fall
  back to `TH32CS_SNAPTHREAD` enumeration. Iterates every thread
  system-wide and counts by `th32OwnerProcessID`. Slower (~10× more
  records to walk) but uses a different syscall surface that's less
  likely to be policy-blocked.
- **Both paths log errors** at WARN/ERROR. If you ever see "TH32CS_SNAPPROCESS
  returned empty map" in your `wintaskpro.log`, that's diagnostic gold
  for figuring out which security product is being aggressive.

### Fixed — TOTAL CPU showing 299%

The system overview header showed `TOTAL CPU 299.0%` on a 16-core
machine. Math: a 16-core system can have at most 16×100% = 1600% if
you sum, or 100% if you average. 299% is sum-ish but not quite.

**Hypothesized cause:** sysinfo's `cpu_usage()` occasionally returns
per-core values >100 on Windows (seen in field reports — possibly a
hyperthreaded-core scheduling artifact, or a sysinfo bug specific to
0.32 on certain CPU topologies). When summed and divided, the average
exceeds 100. The original code had a single final `clamp(0.0, 100.0)`
which should have caught this — but the field report shows 299, which
means either the clamp didn't run (older binary) or it was bypassed.

**Fix:** clamp **per-core** before summing (any single bogus reading
gets capped at 100 before contributing to the average), then re-clamp
the final average. Belt-and-braces — no single bad reading can push the
displayed value above 100.

  > Frontend also clamps as a final defence. Three layers of clamps:
  > per-core, post-average, and post-IPC in JS. CPU% will never display
  > >100 again, regardless of what sysinfo returns.

### Fixed — Notifications "blocked by browser"

The Test Notification button in Settings produced
`Notifications are blocked by the browser` — and the underlying task-
failure notification path silently never fired.

**Root cause:** browser `Notification` API is blocked in WebView2 by
default. There's no override without registering an MSIX manifest or
adopting `tauri-plugin-notification` (which would add a dependency and
config-file changes).

**Fix:** dropped browser Notification API entirely. Replaced with:

- **`src-tauri/src/main.rs`: new `flash_taskbar` IPC** that calls
  Tauri's `request_user_attention(Informational)` which wraps Win32
  `FlashWindowEx`. The taskbar icon flashes orange — the standard
  Windows convention for "background app needs you to look at it."
  No permissions, no plugins, no manifest packaging required.
- **`src/app.js`: `sendTestNotification`** now calls `flash_taskbar`
  IPC + shows an in-app toast. If the user is in another window, they
  see the taskbar pulse; when they return they see the toast still on
  screen. Honest behaviour.
- **`src/app.js`: failure-detection path** in `refreshAll` now flashes
  taskbar + shows error toast for newly-failed tasks. One flash per
  refresh tick regardless of how many tasks failed simultaneously
  (avoids the obnoxious 20-flashes-for-20-failures problem).

### Build / version

- Versions bumped to 1.14.3 across all version markers.
- 53 IPCs registered (was 52). The new one is `flash_taskbar`.
- Cargo features unchanged.
- **Pipeline note:** When you build and tag v1.14.3, please verify the
  GitHub release asset (`WinTaskPro.exe`) reflects the new build (size
  should differ from v1.14.2's 6,294,528 bytes). The auto-update flow
  needs a real new binary on the release page to do anything useful.

---
## [1.14.2] — 2026-04-28 — Silent updater + canonical binary name + PS1 BOM fix + Rust build fix

Five concrete fixes — three were originally drafted independently;
the fourth (PS1 BOM) was found while diagnosing why the v1.14.2 binary
never actually shipped from the build machine; the fifth (Rust
`LocalFree` path) was found once the build script could finally run
and the Rust compiler had a chance to surface the issue. They're all
together here because no v1.14.2 binary made it to GitHub between the
drafting of these fixes — there's no "between" version that ever ran
in the wild, so it would be artificially confusing to claim there was.

### Fixed — Rust build error: `LocalFree` not in `Win32::System::Memory`

Once the BOM fix above let `build_portable.ps1` actually run on a
default Windows machine, the next failure surfaced: a Rust compile
error in `get_process_username`'s SID-string fallback path. Code
called `windows::Win32::System::Memory::LocalFree(...)` to free the
buffer that `ConvertSidToStringSidW` allocated, but `LocalFree` does
not exist in that module in `windows = "0.61"`. (The compiler
helpfully suggested `LocalSize` as a similarly-named function — wrong
fix, but the error did flag the path.)

**Fix:** instead of moving `LocalFree` to wherever it actually lives in
this version (which would create a future drift trap on the next
windows-rs bump), **the SID-string fallback was deleted entirely**.
The fallback was only reached when `LookupAccountSidW` failed AND
`ConvertSidToStringSidW` succeeded — a rare combination, and even
then the only benefit was showing a SID like `S-1-5-18` instead of
the user's `username`. The frontend already displays "—" for missing
users, which is fine for the protected-process case. Net effect:
slightly less detail in a rare edge case, much less Win32 surface
area to maintain.

- **`src-tauri/src/main.rs`: `get_process_username` simplified.** On
  `LookupAccountSidW` failure, returns `None` immediately. No more
  `ConvertSidToStringSidW` import, no more `LocalFree` call, no more
  `HLOCAL` fiddling.
- **`src-tauri/src/main.rs`: `open_file_location` rewritten** to use
  the `PCWSTR` + `Vec<u16>` pattern (matching the proven-working
  `open_in_browser` IPC at line ~1727) instead of `HSTRING::from`.
  HSTRING-to-PCWSTR conversion isn't automatic across all 0.61.x patch
  versions; the wide-buffer pattern is unambiguous and version-stable.
- **`src-tauri/Cargo.toml`: removed two windows features** that are
  no longer used:
    - `Win32_Security_Authorization` (was for `ConvertSidToStringSidW`)
    - `Win32_System_Memory` (was for `LocalFree`)
  > GOTCHA: A leaner feature list slightly speeds up the build because
  >         less of the windows-rs metadata table gets generated. Trim
  >         features whenever the corresponding code is removed.

### Fixed — `build_portable.ps1` parser cascade on PowerShell 5.1

Running `build_portable.ps1` on a default Windows 10/11 install
(which ships with PowerShell 5.1 as the system PS) produced a wall of
"Missing closing `}`" errors starting at the first function definition
and cascading all the way down the file. The script never made it to
the build step. **This is why no v1.14.2 binary was successfully
produced locally** — and why the GitHub v1.14.2 release ended up
serving a stale binary identical in byte count to v1.13.0.

**Root cause:** PowerShell 5.1 reads `.ps1` files using the system
ANSI codepage (Windows-1252 on en-US machines) **unless** the file
starts with a UTF-8 byte-order mark (`0xEF 0xBB 0xBF`). The build
script's banner contains box-drawing characters (`─`, `█`, `╗`, `═`,
etc.) that are multi-byte UTF-8 sequences. Without a BOM, those
multi-byte sequences get misdecoded into garbage Latin-1 characters,
some of which look like opening string quotes or partial keywords to
the parser. The parser then fails to terminate strings or blocks
correctly, and reports cascading "Missing closing `}`" errors all the
way to EOF — phantom errors triggered by one decoding mishap near
the top of the file.

**Diagnostic:** the user reported the parser bailing at line 60
(`function Write-Header {`) which is structurally valid PowerShell.
That tells you the parser already entered an error state before line
60 — and the only thing between the script header and line 60 is the
non-ASCII characters in the section divider lines.

**Fix:**
- **`build_portable.ps1`, `clean_project.ps1`, `wintaskpro-clean.ps1`**
  all now start with a real UTF-8 BOM (`0xEF 0xBB 0xBF`). Verified by
  `head -c 3 <file> | od -An -tx1` returning `ef bb bf`.
- **`build_portable.ps1` header comment** now explicitly documents the
  BOM requirement so a future editor (especially VS Code's "Save
  without BOM" mode) doesn't silently strip it.
  > GOTCHA: VS Code defaults to "UTF-8" (no BOM) for new files. If you
  >         edit any of these scripts there, check the bottom-right
  >         status bar — it must say "UTF-8 with BOM". If not, click
  >         it → "Save with encoding" → pick "UTF-8 with BOM".

**Why didn't this break sooner?** The CI runner uses `pwsh`
(PowerShell 7+) which decodes `.ps1` as UTF-8 by default and doesn't
need a BOM. CI builds therefore worked. Local builds done with
`powershell.exe` (PS 5.1, the Windows default) failed silently because
the user wasn't watching the output, and the in-app updater chained
on top — "successful" updater swapping in the previous binary
unchanged.

### Changed — `.bak` cleanup after successful update

The auto-update flow renames the running `WinTaskPro.exe` to
`WinTaskPro.exe.bak` as a rollback target, swaps the new exe into place,
and launches it. Prior to this release, `.bak` was left behind on
success — users would see a confusing `WinTaskPro.exe.bak` file sitting
next to their app forever.

- **`src-tauri/src/main.rs`: swap helper batch updated.** The `:swap_ok`
  block now does `del "%BAK_EXE%"` after launching the new exe. The
  delete happens *after* `start ""`, so `.bak` is still on disk during
  the brief window between "swap completed" and "new exe is running" —
  if the user kills the helper at the right millisecond, their old exe
  is recoverable. Once the new exe launches successfully there's no
  rollback path that needs `.bak` anyway, so deleting is safe.
- **Failure paths still keep `.bak`.** The `:swap_failed` and
  `:fallback` paths are unchanged — they restore from `.bak` and exit
  without deleting. If a future swap also fails, the next attempt's
  step-4 `del "%BAK_EXE%" >nul 2>&1` will clean up the stale .bak from
  the previous failure before creating a fresh one.

### Changed — Updater is now silent / headless end-to-end

Five spawn sites that could flash a console window on Windows have been
audited and corrected to use `CREATE_NO_WINDOW` (`0x08000000`):

- **PowerShell event-log query** (`get_event_log_history` IPC) — added
  `creation_flags(0x08000000)` and `use std::os::windows::process::CommandExt`.
- **PowerShell history search** (`search_event_history` IPC) — same.
- **PowerShell update download** (`download_and_install_update` step 1)
  — same. Previously this could flash a brief PS console during the 5-30s
  download.
- **Update swap helper spawn** simplified: dropped the `cmd.exe /C start /B "" cmd.exe /C <script>`
  triple-cmd indirection. The outer `cmd.exe /C <script>` already
  inherits `DETACHED_PROCESS | CREATE_NO_WINDOW` from the spawn flags,
  so the `start /B` layer was redundant and added a second cmd hop that
  could race window-creation. Cleaner spawn → fewer chances for window flash.
- **`CheckNetIsolation.exe`** (debug builds only) — added
  `creation_flags(0x08000000)`.

The `run_task_test` IPC (`L356`) already had `CREATE_NO_WINDOW` from a
previous release — left unchanged.

  > GOTCHA: `creation_flags` is a `std::os::windows::process::CommandExt`
  >         method, so `use ...CommandExt;` must be in scope at each site.
  >         Five new `use` statements were added (one is shared between
  >         two adjacent sites in `download_and_install_update`).

### Changed — `WinTaskPro.exe` is now the canonical binary name everywhere

Previously the raw Cargo output was `wintaskpro.exe` (lowercase), and
`build_portable.ps1` + the CI workflow each did a separate copy step to
produce the canonical `WinTaskPro.exe` for the GitHub release asset.
The two copy steps were independent code paths that could drift, and
"the build output" had two different names depending on how you
invoked it.

- **`src-tauri/Cargo.toml`: `[[bin]] name = "WinTaskPro"`.** Cargo
  package names must be snake_case or kebab-case, but `[[bin]]` name
  override allows mixed case. `default-run = "WinTaskPro"` updated to
  match.
- **All build paths now produce `WinTaskPro.exe` directly:**
  - `cargo build` → `src-tauri/target/<profile>/WinTaskPro.exe`
  - `tauri build --no-bundle` → same
  - `npm run build:portable` → `dist/WinTaskPro.exe`
  - `tauri build` (NSIS+MSI) → installer payload uses `productName: "WinTaskPro"` from
    `tauri.conf.json` so the installed binary has been `WinTaskPro.exe`
    all along; this hasn't changed.
  - CI workflow → uploads `WinTaskPro.exe` as the release asset.
- **`build_portable.ps1` and `release.yml` updated to look for the new
  name** with the lowercase variant kept as a fallback path. This means
  a stale incremental-rebuild from a pre-1.14.2 checkout still locates
  its artifact and the script doesn't fail with a confusing "not found"
  error if the user rebuilds without `cargo clean`.

  > GOTCHA: After this version is checked out, the FIRST build will
  >         produce `WinTaskPro.exe` instead of `wintaskpro.exe`. If you
  >         have an `src-tauri/target/release/wintaskpro.exe` from
  >         before, it'll still be there on disk but is now stale — the
  >         build script's fallback finds it. Run `cargo clean` once to
  >         normalize the state.

### Build / version

- Versions bumped to 1.14.2 across all version markers.
- No new dependencies. No IPC changes. Update flow is functionally
  identical from the user's perspective except:
    - No `.bak` left behind after success
    - No flashing console windows during update download/swap
    - Same canonical filename produced regardless of build path
    - **`build_portable.ps1` actually runs on a vanilla Windows machine
      with PowerShell 5.1** (was failing with cascading parse errors
      due to missing UTF-8 BOM)
- **Pipeline note:** the previous v1.14.2 GitHub release reportedly
  served a 6,242,304-byte binary identical to v1.13.0 — meaning that
  upload was actually the v1.13.0 build with a v1.14.2 tag. After
  rebuilding with this fix, please **delete and re-upload** the
  `WinTaskPro.exe` asset on the v1.14.2 release page so existing
  installs auto-updating to v1.14.2 actually receive a v1.14.2 binary.
  Verify the asset size differs from prior releases — it should be a
  few KB larger to reflect the added IPCs and frontend code.

---
## [1.14.1] — 2026-04-28 — Process Manager: Power-User Pass

A focused follow-on to the v1.14.0 Expert Edition. Plugs gaps that a
power user would notice within the first hour of use: column picker
(was a TODO toast), persistent sort/filter/tree state (used to reset on
every visit), three-mode view (flat/tree/group-by), customizable
highlight rules, four-stream Performance trends instead of just CPU,
process tree kill, CPU affinity, and CSV export.

### Added — Column picker (real, persistent)

The "⚙ Columns" button (which previously showed a "coming next" toast)
now opens a modal with checkboxes for every available column. Visibility
persists in localStorage. Two columns (`Pin` and `Name`) are locked
visible because hiding them leaves no way to interact with rows.

- **`src/app.js`: `PROC_COLUMNS` schema** — single source of truth. Each
  entry has `key, label, width, align, sortable, default, cell(p, ctx)`.
  Header, body row, grid template, and the picker all derive from it.
  Adding a new column requires touching exactly this array.
- **Two new built-in columns:** Private Memory (off by default) and
  Parent PID (off by default). Status column also added (off by default).
- **`renderProcessManagerShell` rebuilt to derive the grid template**
  from `procGridTemplate()` so column changes are reflected in both
  header and rows without code duplication.
- Storage key: `wtp_proc_column_vis`.

### Added — Persistent process-manager state

Sort column/direction, tree mode, all three filters, and group-by all
persist between sessions. Was disorienting before — users would set up
a view (e.g. sort by memory, hide system) and lose it on the next
launch.

- **`src/app.js`: `loadProcStateFromStorage` / `saveProcStateToStorage`**
  with storage key `wtp_proc_state`. Called on entry to the Process
  Manager and on every state-changing action.
- **Schema-aware sort header rebuild.** The previous arrow-update logic
  used a `text.replace(/[↑↓]$/)` regex which broke when column labels
  themselves contained arrows. The new logic looks up the column's
  static label from the schema and rewrites text deterministically.

### Added — Group-by mode

A new dropdown in the toolbar offers None / By user / By image / By
elevation. Group headers show member count plus aggregate CPU and
memory for the group. Clicking a header collapses/expands its members.
Mutually exclusive with Tree mode (turning one on turns the other off).

- **`src/app.js`: `renderProcGroups()`** builds collapsible sections,
  sorted by group size descending so the busiest group is on top.
- **Why mutually exclusive with tree?** Tree's parent-child indentation
  conflicts visually with group-section headers. The user picks one
  hierarchy at a time; we make the trade-off explicit by toggling.
- **State persists** alongside other view settings.

### Added — Custom highlight rules

The previously-hardcoded "CPU > 50% red, memory > 500MB yellow"
thresholds are now editable rules with a full editor modal. Users can
add their own rules — color any process matching `name contains "node"`,
or `user contains "ADMIN"`, etc.

- **`src/app.js`: `_procHighlights` array** with built-in defaults
  matching the previous hardcoded thresholds. Storage key:
  `wtp_proc_highlights`.
- **`procEditHighlights()` modal** with a row per rule: enable
  checkbox, label, type (CPU/Memory/Name/User), comparator (>, <,
  contains), value, color picker, delete button.
- **Rules tested in order; first match wins.** Background tint applied
  at 0.10 alpha so text remains readable. Selection outline still
  takes precedence so a selected row's tint is overridden.
- Old hardcoded `cpu>50→red` styling moved into the rule list as the
  "High CPU" built-in default — same visual result, but now editable.

### Added — Process tree kill

A new "💀 Tree" action in the detail-pane action row and a
"💀 Kill process tree…" entry in the right-click menu. Kills the
target process AND every descendant (children, grandchildren, etc.).

- **`src-tauri/src/main.rs`: `kill_process_tree` IPC** does a BFS over
  the parent→children adjacency map built from sysinfo. Reverse-orders
  the kill list so leaves die first (parents get a chance to see
  children gone before they themselves die — reduces zombie warnings
  in event logs but not strictly required).
- **Race-window note (in the docs):** the JS-side preview shows the
  tree from the local `_procData` snapshot; Rust rebuilds with a fresh
  sysinfo refresh when actually killing. New short-lived processes
  spawned between preview and confirm will be missed by the preview
  but caught by the kill if they're descendants of any of the tree
  members.
- **Returns a `TreeKillReport`** with `killed`, `failed[]`, and
  `pids[]` (in kill order). Frontend surfaces partial-failure cases
  honestly — protected processes (csrss, etc.) will refuse termination
  even from elevated; we report rather than hide that.
- **Confirmation modal shows the full tree** with indentation matching
  parent-child depth before the kill happens.

### Added — CPU affinity

Pin a process to specific CPU cores. New "🎚 Affinity" detail-pane
button + context-menu entry.

- **`src-tauri/src/main.rs`: `set_process_affinity` IPC** wraps
  `SetProcessAffinityMask`. Rejects mask of 0 (would orphan process from
  all CPUs).
- **`get_cpu_count` IPC** returns logical-CPU count from sysinfo so the
  modal can render one checkbox per core.
- **Modal includes presets:** All / None / Even cores / Odd cores. Quick
  way to do "leave half the system available" without 16 individual
  clicks.
- **Cap at 64 cores** — we encode the mask as a JS Number passed via
  Tauri IPC, which is safe up to 53 bits. For >53 cores the user gets a
  clear error message rather than silently truncating. Real-world client
  systems are well under this.
- **Inline disclosure:** modal warns that "affinity changes are not
  persisted by Windows — they reset on restart." Better to set
  expectations than have the user wonder why the limit reverts.

### Added — Four-stream Performance tab

The Performance detail tab previously had one CPU sparkline and four
static stat cards (Disk Read, Disk Write, Working Set, Private Bytes).
Now it's four sparklines: CPU, Memory (working set), Disk I/O combined,
and Handles. Each shows current/peak/avg over the 90s window plus a
filled-area chart.

- **`src/app.js`: `_procMemHistory`, `_procIoHistory`, `_procHandlesHistory`**
  — three new circular buffers populated alongside CPU history on
  every refresh. GC together when PIDs die.
- **Why handles?** Handle leaks are a common diagnostic signal —
  processes that climb steadily over hours/days are leaking. The
  sparkline makes this trend visible at a glance; a "⚠" marker
  appears in the header line when peak > 1.5× average.
- **Why combined I/O instead of separate R/W?** The user already sees
  separate R and W in the row's I/O R / I/O W columns and the
  sparkline header line shows them too. The chart itself reads better
  with one trend line; separate R/W lines would compete visually.

### Added — System overview header

A 5-card strip across the top of the Process Manager: Total CPU, Total
Memory, Threads/Handles, Disk I/O, and Top 5 by CPU. Computed entirely
from `_procData` — no extra IPC. Updates every refresh.

- **Top-5 list is clickable** — click a name to jump to that process
  in the list with the detail pane focused.
- **Threshold coloring:** total CPU > 80% turns red, > 50% yellow.
  Total I/O > 100MB/s turns yellow.
- **Replaces nothing.** Previously the header showed only "Process
  Manager / live dot / refresh time". The header still has those —
  the cards are new content above them.

### Added — CSV export

A new "📊 Export" button writes the currently-visible processes (after
filters and sort) to a CSV file using the currently-visible column set.
Convenience for sharing in bug reports or analyzing in a spreadsheet.

- **`src/app.js`: `procExportCsv()`** uses Blob URLs (no IPC). Filename
  includes ISO timestamp.
- **Per-cell escaping** wraps any value containing `,`, `"`, newline, or
  carriage return in quotes with internal quotes doubled.
- **Name column is augmented** with the command-line text in CSV form
  so the export is usable for "what was running and what arguments were
  passed?" forensic queries even when columns are minimal.

### Added — Copy as JSON

Right-click → "📋 Copy as JSON" copies the full process record as
pretty-printed JSON to the clipboard. Single-process equivalent of
the CSV export — convenient for sharing one process's state in chat
or a bug report.

### Build / version

- **Versions bumped to 1.14.1** across all version markers.
- **No new third-party dependencies.** Everything added uses
  already-included `windows`, `sysinfo`, and `serde_json` features —
  the Cargo.toml additions in 1.14.0 (IpHelper, ToolHelp, etc.) were
  sufficient. New IPCs `set_process_affinity` and `get_cpu_count` use
  features we already had.

### Honest about what didn't ship

These were considered for this release but explicitly deferred:

- **Service mapping per svchost** — would require reliable admin and
  fiddly `EnumServicesStatusEx`. I'd rather skip than ship half-working.
- **Window list per process** — significant Win32 surface
  (EnumWindows + GetWindowThreadProcessId) for marginal value vs. the
  features above.
- **File lock finder** (RestartManager API) — its own engineering
  effort, would crowd this release.
- **Vim-style keyboard nav scoped to the proc table** — the global
  keyboard handler already owns j/k for the task table; adding a
  conflicting binding for the proc page is risky without deeper
  scoping work.

---
## [1.14.0] — 2026-04-27 — Process Manager: Expert Edition

A ground-up rewrite of the Process Manager. The previous implementation
was a basic table with PID / name / CPU / memory and a Kill button. The
expert version adds rich process metadata, a tree view, per-process
network connections and loaded modules, suspend/resume/priority controls,
a CPU sparkline, snapshot/diff, watchlist, and a split-pane UI.

### Backend — `ProcessInfo` enriched, new IPCs

- **`ProcessInfo` now carries 16 fields** (was 6):
  parent_pid, exe_path, command_line, user (Win32 SID lookup),
  start_time, run_secs, threads, handles (GetProcessHandleCount),
  elevated (TokenElevation), mem_working_kb (working set),
  mem_private_kb (private bytes), disk_read_kb_s, disk_write_kb_s
  (rates computed via per-PID byte-count snapshots in AppState).
- **`get_process_username()`** — OpenProcessToken + GetTokenInformation +
  LookupAccountSid. Cached per-PID (usernames don't change after process
  start). Cache cleared as PIDs die.
  > GOTCHA: protected processes (csrss, System, etc.) return None;
  >         field is left empty rather than failing the whole snapshot.
- **`get_process_elevated()`** — GetTokenInformation(TokenElevation) for
  the ⬆ elevation badge.
- **`get_process_handle_count()`** — per-process Win32 GetProcessHandleCount.
  Surprisingly informative; processes leaking handles climb steadily over
  time and become visible in this column.
- **`suspend_process` / `resume_process` IPCs** — NtSuspendProcess /
  NtResumeProcess from ntdll, resolved at runtime via GetProcAddress.
  These are NT private API but every serious process manager uses them
  (Process Hacker, Process Explorer). Win32 has no process-level suspend.
- **`set_process_priority` IPC** — SetPriorityClass with a 0-5 mapping
  (Idle / Below Normal / Normal / Above Normal / High / Realtime).
- **`get_process_modules` IPC** — CreateToolhelp32Snapshot enumerates
  every loaded DLL with name, path, base address, and size.
- **`get_process_connections` IPC** — GetExtendedTcpTable +
  GetExtendedUdpTable, filtered to entries owned by the requested PID.
  Decodes TCP state codes (LISTENING, ESTABLISHED, etc.) to human labels.
- **`find_process_by_port` IPC** — "what process is using port 8080?".
  Walks both TCP and UDP tables, returns owning PIDs.
- **`open_file_location` IPC** — ShellExecuteW with `explorer.exe /select,"<path>"`
  to highlight an exe in Explorer.
- **`AppState` extended** with `io_snapshots: HashMap<u32, IoSnapshot>` for
  byte-count delta tracking and `user_cache: HashMap<u32, String>` for
  username caching. Both keyed by PID and pruned as PIDs die so they don't
  grow unbounded.
- **Cargo.toml — windows features added:** `Security_Authorization`,
  `System_LibraryLoader`, `System_Diagnostics_ToolHelp`, `System_Memory`,
  `NetworkManagement_IpHelper`, `Networking_WinSock`.

### Frontend — split-pane expert UI

- **One-time DOM build, in-place updates.** `renderProcessManagerShell()`
  builds the static UI once per page entry. `refreshProcessData()` only
  updates rows. Result: scroll position is preserved across the 1.5s
  refresh cycle, no flicker, no focus loss.
- **Refresh interval reduced 3s → 1.5s** for snappier "is the spike still
  happening?" feedback. Sysinfo's CPU delta math handles the higher rate.
- **Split pane: process list + 420px detail panel.** Detail panel has 4
  tabs: Overview, Performance, Modules, Network.
- **Tree view (🌲 Tree)** — toggles parent-child grouping by parent_pid.
  Auto-expands top-level processes; chevrons collapse/expand subtrees.
  Filtered children pull their ancestors up so the hierarchy stays
  consistent.
- **Watchlist (★ star)** — click any process's star to pin it. Pinned
  processes float to the top of the list. Persisted in localStorage.
- **Snapshot / Diff (📸)** — capture state at a moment, then "NEW" badges
  show processes that started after the snapshot. Useful for "I clicked
  this thing — what spawned?" investigations.
- **Find process by port (🔌 Port)** — modal queries the new
  find_process_by_port IPC. Click a result to jump to the process in
  the list.
- **Filters** — by user, "Elevated only" toggle, "Hide SYSTEM/service
  processes" toggle for noise reduction.
- **Per-row metadata** — PID, name (with command line on second line),
  CPU, memory, user, threads, handles, uptime, I/O rate. CPU column
  color-codes >50% red, >10% yellow. Memory >500MB tinted yellow.
- **Elevated badge (⬆)** on rows running with elevated tokens — instantly
  visible at-a-glance.
- **CPU sparkline** in the Performance tab — 60-sample circular buffer
  per PID, drawn as inline SVG. Shows current/peak/avg over the window.
- **Per-process actions:** Suspend, Resume, Priority (with confirmation
  for Realtime), Open file location, Copy command line, Kill.
- **Right-click context menu** on any row exposes all actions plus
  "Add to watchlist" and "Show details".

### Build / version

- Versions bumped to 1.14.0 across all version markers.

---
## [1.13.0] — 2026-04-27

Phase 4 — the final batch of the post-1.9 roadmap. CLI passthrough turns
the GUI binary into a scriptable tool, statistics surface trends per task,
keyboard navigation makes the app feel fast in the hands of power users,
and the detail panel gets a tabbed layout so it stops being a wall of
scroll.

### Added — CLI passthrough

The same `WinTaskPro.exe` now serves double duty as a scriptable tool. If
called with a recognized CLI flag it executes the command and exits
without launching the GUI; without flags it launches the GUI as before.

- **`src-tauri/src/main.rs`: argument inspection at the very top of `main()`,
  before WebView2 / Tauri / scheduler init.** Recognized commands return
  early with an explicit `std::process::exit(code)`. Unknown args fall
  through to GUI launch — Tauri's own internal flags (`--no-default-features`
  etc.) still work.
- **Commands implemented:**
  - `--help` / `-h` / `/?` — usage + examples
  - `--version` / `-V` — print version
  - `--list` — every task path, one per line, sorted
  - `--run <task_path>` — trigger a task immediately
  - `--stop <task_path>` — stop a running task
  - `--enable <task_path>` / `--disable <task_path>` — toggle enabled state
  - `--export <task_path>` — print task XML to stdout (pipe to file)
  - `--export-all` — JSON array of every task with embedded XML
- **CLI mode skips devlog initialization entirely.** No log files written,
  no logs directory created. CLI invocations are stateless and pipe-safe.
  > GOTCHA: if the user redirects stderr (`WinTaskPro.exe --list 2> err.txt`)
  >         and runs without admin, the engine init failure goes there
  >         rather than vanishing — exit code 1 + stderr message.
- **Exit codes:** 0 = success, 1 = command error (engine init failed,
  task not found, etc.), 2 = invalid arguments.
- **Pipe-friendly output:** stdout via plain `println!` so pipelines like
  `WinTaskPro.exe --list | findstr /R "Backup"` work correctly.

### Added — Statistics over time

A new "📊 Stats" tab in the detail panel computes and visualizes
derivable metrics from each task's run history:

- **Success rate** (% of completed runs with result_code === 0), color-coded
  green/yellow/red at the 95% / 75% thresholds
- **Average duration** + **median duration** (median is more robust
  against outliers from killed/timed-out runs)
- **Last 30 days** run count
- **Day-of-week histogram** as a 7-bar chart (drawn with inline divs, not
  SVG — it's small enough that DOM is faster than another tool)
- **Most recent failure** with timestamp + result text, surfaced
  prominently when present
- All computed in pure JS via `computeTaskStats()` — no new IPC. Reuses
  the existing `get_task_history` records.
  > GOTCHA: durations come from the engine's bookkeeping which
  >         occasionally includes inflated values for tasks that hit
  >         their exec time limit and got killed. The median fixes
  >         this; we surface both so the user can spot the discrepancy.

### Added — Tabbed detail panel

The detail panel was a single long scroll: General → Triggers → Actions →
History → Tags → Notes. With many triggers/actions on a single task this
required a lot of scrolling. Now there are 7 tabs across the top, one
pane visible at a time.

- **`src/app.js`: `_detailTab` state** persists the selected tab across
  `openDetail()` calls, so navigating between tasks doesn't reset focus
  to General every time.
- **Tabs:** General · Triggers · Actions · History · Stats · Tags ·
  Notes. The Notes tab gets a `*` indicator when a note exists.
- **General tab consolidated** — Last Run / Next Run / Last Result moved
  here from the (now removed) standalone History section. Also added
  Run Level (Standard vs Highest) which was previously hidden.
- **Actions tab also surfaces** the parsed program / args / working dir
  fields below the textual action list — useful for verifying the
  fields the new Test Run feature uses.

### Added — Keyboard navigation

Vim-style row movement plus tab cycling for keyboard-first workflow:

- **`j` / `k` / `↓` / `↑`** — move focus through visible task rows. Wraps
  at the ends. Auto-scrolls if the focused row would go off-screen.
- **`Enter`** — open the focused row's detail panel.
- **`[` / `]`** — cycle previous/next detail-panel tab when the panel is
  open.
- **`row-focused` CSS class** uses an accent-color outline (distinct
  from `.row-selected` which is the bulk-checkbox state) so users can
  tell at a glance which row is keyboard-focused vs which are
  multi-selected.
- Pre-existing shortcuts unchanged: `N` (new), `R`/`F5` (refresh), `E`
  (edit), `Del`, `/` (search), `1`-`5` (page nav), `?` (help), `Esc`
  (close modal). All still work.
- Help modal updated to document the new shortcuts.

### Build / version

- **Versions bumped to 1.13.0** across all version markers.

---
## [1.12.0] — 2026-04-27

Phase 3 of the post-1.9 feature roadmap. Four power-user features focused
on bulk operations, security tripwires, and machine portability.

### Added — User-defined templates

The Script Library now hosts both built-in templates (shipped with the
binary) and custom templates the user has saved from their own tasks.
Click "💾 Template" in any task's detail panel to save its configuration
as a reusable template.

- **`src/app.js`: localStorage-backed `userTemplates` array** with the
  same schema as the built-in TEMPLATES, plus an `id` for deletion and
  a `created` ISO timestamp.
  > GOTCHA: localStorage is per-WebView2-install, not per-WinTaskPro-
  >         binary. Moving the .exe between machines doesn't move the
  >         templates with it. This is intentional — templates are
  >         personal preferences, not machine-portable.
- **`openSaveAsTemplateDialog(task)`** opens a modal pre-filled with the
  task's name/description and an emoji picker. The user can edit any
  field before saving.
- **`renderTemplates()` rewritten** to merge user templates above
  built-ins with a clear visual separator. User templates get a delete
  button alongside their "Use" button.
- **Storage failures surfaced** — if localStorage write fails (quota
  exceeded etc.) the user gets an error toast rather than silent loss.

### Added — Bulk Find &amp; Replace

A new "🔁 Find/Replace" button in the Tasks toolbar opens a modal that
finds and replaces text across program paths, arguments, and working
directories of every task. The canonical use case: machine reorg moved
scripts from `C:\Old\Path\` to `D:\New\Path\`, dozens of tasks need
updating.

- **`computeFindReplaceMatches()`** scans `allTasks` in memory (no IPC),
  returning every match with both the full BEFORE and AFTER strings so
  the preview UI shows exactly what will change.
- **Mandatory preview before commit.** The "Apply changes" button is
  only available after the user has hit Preview. No confirmation modal
  on commit (the preview already shows the impact) but a per-task
  failure list if anything goes wrong.
- **Implementation: export → string-replace XML → import.**
  `import_task_xml` already uses `TASK_CREATE_OR_UPDATE`, so the import
  is an in-place update — no risk of orphan duplicates like move_task.
  Per-task try/catch means a single failure doesn't abort the batch.
- **Case-sensitivity toggle** with the case-sensitive default (because
  Windows paths are case-preserving and unintended case changes break
  things).
- **No-op detection.** If the XML round-trip doesn't actually change
  the bytes (e.g. find-string was in our matched fields but the XML
  encoding doesn't match), the task is flagged as a failure rather
  than silently producing a no-op write.

### Added — Integrity check (executable hash baselines)

A new "🛡 Integrity" button in the Tasks toolbar opens a modal that
hashes every task's program executable with SHA-256 and compares against
saved baselines. Detects when a binary has been modified since last
trusted — a useful tripwire for malware that hijacks scheduled tasks by
replacing the executable.

- **`src-tauri/src/main.rs`: new `hash_file` IPC** computes SHA-256 of a
  file path, reading in 64KB chunks (memory-bounded for multi-megabyte
  installer EXEs). Returns empty string for missing files — a
  meaningful integrity signal that the UI surfaces differently from a
  hash mismatch.
- **`src-tauri/Cargo.toml`: added `sha2 = "0.10"`** with default features
  (which include the x86 hardware-accelerated path).
- **`src/app.js`: parallel hashing.** All tasks are hashed concurrently
  via `Promise.all` of separate IPC calls — even with 200+ tasks this
  finishes in under a second on modern SSDs.
- **Four buckets in the result UI:** changed (red, with old vs new
  hash), missing (yellow, file gone), untrusted (no baseline yet), and
  unchanged (collapsed details element to avoid noise).
- **Bulk operations:** "Trust all current versions" for first-run
  baseline establishment; "Re-trust changed" for legitimate updates,
  with a confirmation that explicitly warns about silencing real
  malware tripwires.
- **Limitations disclosed inline:** doesn't catch argument changes, DLL
  swaps, or first-run baseline being malicious from the start.

### Added — PowerShell setup-script export

A new "⚡ Export PS1" button in the detail panel and bulk toolbar
generates a self-contained `.ps1` setup script that recreates the
selected tasks on another machine. Use cases: backups, machine
migration, fleet deployment.

- **`src/app.js`: `exportTasksAsPowerShellScript()`** builds the script
  by embedding each task's exported XML in a PowerShell here-string
  and calling `Register-ScheduledTask -Xml -Force` per task.
  > GOTCHA: PowerShell here-strings end on a line containing literally
  >         `'@`. Task Scheduler XML never produces that pattern at the
  >         start of a line in practice, but we defensively indent any
  >         line starting with `'@` by one space.
- **Why XML over hand-built `-Trigger`/`-Action`?** Microsoft's exported
  XML preserves every nuance — random delays, idle conditions, repetition
  windows — that a programmatic `-Trigger` chain would lose. The trade-off
  is the script is a bit more verbose than necessary for simple tasks,
  but verbosity is preferable to silent fidelity loss.
- **Self-documenting header** explains caveats (run as admin, accounts
  with specific principals need credentials, absolute paths must exist on
  target).
- **Per-task try/catch + final summary.** The script returns exit code 1
  if any task failed, listing failures by name. Re-runnable safely
  thanks to `-Force`.
- **Modal offers two delivery modes:** download as `.ps1` file (Blob URL,
  no IPC needed) or copy to clipboard.

### Build / version

- **Versions bumped to 1.12.0** across all version markers.
- **New crate dependency:** `sha2 = "0.10"`.

---
## [1.11.0] — 2026-04-27

Phase 2 of the post-1.9 feature roadmap. Four features focused on quality
of life and proactive problem-finding — surfacing scheduling issues before
they bite, and turning the dashboard from a status report into an early
warning system.

### Added — Drag-and-drop tasks between folders

Tasks can now be moved between folders by dragging the row onto a folder
in the sidebar. Replaces the previous "edit task → change Path → save"
flow which required four clicks for a basic reorganization.

- **`src-tauri/src/main.rs`: new `move_task` IPC** composes the move from
  three existing operations: export XML → import to new folder → delete
  original. Returns the new full path on success. Critically, we NEVER
  delete first — if the import fails, the user still has their task.
  > GOTCHA: Windows doesn't have an atomic "move task" primitive. The
  >         re-register-then-delete pattern is the standard workaround,
  >         but it has the trade-off below.
- **Trade-off accepted: run history resets.** Windows tracks history by
  the full task path (`\folder\name`), so re-registering at a new path
  starts a fresh history. The confirmation modal warns about this
  explicitly so users aren't surprised.
- **`src/app.js`: row drag handlers and folder drop targets.** Each
  `<tr>` is `draggable="true"`; tbody-level delegated `dragstart`/
  `dragend` listeners avoid re-binding on every render. Folder list
  items get drop-target highlighting on dragenter, with a self-drop
  guard so you can't drag a task to its current folder.
- **`src/style.css`: `.folder-item.drop-target`** uses an accent border
  + glow to make the drop zone unambiguous. The dragged row gets `0.4`
  opacity so it's clear what's being moved.

### Added — "Test Run" mode with output capture

A new 🧪 Test Run button in the detail panel runs the task's program
directly with stdout/stderr captured and shown in a modal. Closes the
"the task ran but nothing happened — what does the script even output?"
gap that the regular Run button leaves wide open.

- **`src-tauri/src/main.rs`: new `run_task_test` IPC** spawns the program
  via `std::process::Command` with `Stdio::piped()` for both streams,
  enforces a 60-second hard timeout, and returns a `TestRunResult`
  with exit code, stdout, stderr, duration, and a `timed_out` flag.
- **Threading model:** stdout and stderr are drained on dedicated reader
  threads using `Arc<Mutex<Vec<u8>>>` because `Read::read_to_end` is
  blocking. The main thread polls `try_wait()` with a 100ms tick and
  kills the process at the deadline.
- **`std::os::windows::process::CommandExt::raw_arg`** preserves the
  task's argument string verbatim. Splitting on spaces would mangle
  `"C:\Path With Spaces\file.exe"` style paths.
- **`src/app.js`: `runTaskAsTest()`** opens the modal in a "Running…"
  state IMMEDIATELY so long-running tasks don't make the app feel
  frozen, then replaces the spinner with the result blocks when the
  IPC returns.
- **Caveats surfaced inline (not just in a tooltip):** the modal shows
  a yellow warning panel listing the three things that differ from
  the real Run: runs as the current user (not the task's principal),
  ignores scheduler conditions (idle/AC/network), 60-second cap. This
  matters because users will compare Test Run output against real-Run
  failures and need to understand why they might differ.
- Test Run is also fundamentally **safer for debugging** because it can
  be cancelled by closing the app — a hung scheduler-spawned task
  needs `taskkill` to clean up.

### Added — 24-hour timeline on dashboard

A new dashboard card "📅 Next 24 Hours" plots projected firings of all
time-based triggers on a horizontal SVG timeline. Each task gets a lane;
each firing is a dot; hover shows time + task name. Answers "what's
going to wake my PC tonight?" in two seconds.

- **`src/app.js`: `taskFiringsFromInfo(task, windowHours, count)`**
  adapts a TaskInfo's bitmask fields (days-of-week, months, days-of-
  month) to the formState shape that `computeNextFirings()` (Phase 1)
  already accepts. Reuses the same forecast logic powering the
  schedule preview in the create dialog.
- **`renderTimelineCard()`** generates inline SVG (`viewBox=0 0 720 H`)
  with hour ticks at 0/4/8/12/16/20/24, hour labels every 8h, and a
  prominent "now" line at x=160. Dots use `<title>` for native browser
  hover tooltips.
- **Lane sorting:** chronological by first firing — the earliest
  firings appear at the top, so the timeline reads like a vertical
  stack of "what's next." Capped at 12 lanes; overflow gets a
  footnote.
- **Event triggers excluded from the timeline.** Boot/Logon/Idle/
  SessionLock/SessionUnlock have no deterministic firing time; showing
  them as "fires sometime ¯\\_(ツ)_/¯" would clutter the visualization.
  A small footnote explains this on empty timelines.

### Added — Schedule conflict detection

A new dashboard card "⚡ Schedule Conflicts" surfaces pairs of tasks
projected to fire within 30 seconds of each other in the next 7 days.
Helps catch "I just scheduled two heavy backups at 3am" situations
proactively.

- **`src/app.js`: `findScheduleConflicts()`** projects 5 firings per
  task across a 7-day window, builds a sorted timeline, then runs a
  sliding-window scan: any two entries within 30 seconds = conflict.
  Self-collisions (different firings of the same task) are filtered.
- **De-duplication:** a single task pair colliding on multiple days is
  shown once with the soonest collision time, so a Daily-vs-Daily pair
  doesn't fill the card with seven near-identical rows.
- **Scope deliberately limited to temporal proximity.** We don't try to
  detect "they read the same file" or "they're both memory-heavy" —
  that requires program understanding we don't have. Temporal
  proximity is what the user can fix by adjusting trigger times.
- **Hidden when there are no conflicts.** Like the broken-tasks card,
  zero noise on healthy systems.

### Build / version

- **Versions bumped to 1.11.0** across all version markers.

---
## [1.10.0] — 2026-04-27

Phase 1 of the post-1.9 feature roadmap. Four features that close real
gaps in daily use of the app — what would be missed by someone managing
tasks day in / day out.

### Added — Schedule preview in create/edit dialog

Inside the trigger tab of the New Task / Edit Task dialog, a new "📅
Schedule Preview" panel shows the next 5 firing times computed from the
current trigger settings — live, as the user types. This closes the gap
where someone sets a Weekly trigger on a Wednesday but forgets to check a
day-of-week box, saves the task, and only discovers later that it never
fires.

- **`src/app.js`: `computeNextFirings(formState, count)`** — pure-JS
  forecast over Once / Daily / Weekly / Monthly / Interval triggers.
  Returns an array of Date objects, an empty array for unfireable masks,
  or `null` for event triggers (where the renderer shows a "fires when X
  happens" message instead).
- **`src/app.js`: `renderSchedulePreview()`** — reads form state and
  updates the `#cf-schedule-preview` element. Wired to a single
  delegated `change`+`input` listener on the trigger tab panel so every
  field edit refreshes the preview without having to plumb listeners
  individually.
  > GOTCHA: a `setTimeout(_, 0)` defers reading the input value by one
  >         tick — checkbox `change` events fire before the value is
  >         committed in some browsers. The defer is cheap and
  >         eliminates a class of off-by-one preview bugs.

### Added — Invisibly-broken task detector on dashboard

A new dashboard card "⚠ Tasks That Won't Fire (N)" appears when the
detector finds tasks that look healthy in normal views (enabled, no
failure code) but actually CAN'T fire because their trigger spec is
unfireable. The card is hidden when there are no findings — zero noise
on healthy systems.

- **`src/app.js`: `findInvisiblyBrokenTasks(tasks)`** detects 5
  pathologies:
  1. Weekly trigger with empty day-of-week mask
  2. Monthly trigger with empty days-of-month mask
  3. Monthly trigger with empty months-of-year mask
  4. Time-based trigger (Once/Daily/Weekly/Monthly/Interval) with empty
     `next_run` — usually means an end-boundary in the past
  5. Once trigger whose start is in the past AND has never run (machine
     was off when the time came)
- Each finding pairs a human-readable reason with concrete fix advice.
- Rows are clickable — opens the edit dialog directly so the user can
  fix the trigger in one click.

### Added — History-wide search

A new modal "🔍 Search Run History" accessible from the Audit Log page
toolbar searches the Microsoft-Windows-TaskScheduler/Operational event
log across **all** tasks. Date range, event type, and substring filters
all push into the kernel-mode log query for fast results even on
machines with thousands of events.

- **`src-tauri/src/main.rs`: new `search_event_history` IPC**.
  Constructs a `Get-WinEvent -FilterHashtable` query with optional
  StartTime / EndTime / Id constraints. Substring filter is applied via
  `-imatch [regex]::Escape(...)` so user input doesn't accidentally
  inject regex metacharacters.
  > GOTCHA: PowerShell hashtable syntax in a Rust raw string needs
  >         doubled-up `{{` and `}}` braces because of the format!()
  >         interpolation. Easy to break inadvertently when extending.
- **`src/app.js`: `openHistorySearch()` + `runHistorySearch()`**. Modal
  defaults the date range to the last 24 hours and the event types to
  100/102/200/201 (the lifecycle pair plus action started/completed).
  Result table shows time, task path, event ID label (e.g. "started",
  "action FAILED"), and a 80-char message snippet.

### Added — Side-by-side task compare

Select exactly 2 tasks via the existing checkboxes → a new "🔀 Compare"
button appears in the bulk toolbar → modal renders a categorized
field-by-field comparison with differences highlighted. Saves the
alt-tab dance through detail panels when investigating "why does PS4
work but PS4 (Copy) doesn't?"

- **`src/app.js`: `compareSelectedTasks()`** uses a curated 21-field
  schema across Identity / Trigger / Repetition / Action categories
  rather than a recursive object diff (which would surface dozens of
  always-different timestamp fields as noise).
- Bitmasks (days-of-week, months, days-of-month) are expanded to
  comma-separated names so users see "Mon, Wed, Fri" instead of "42".
- Differing rows get a yellow tint and a ⚠ glyph; the modal title shows
  a count of diffs at a glance.
- Footer has direct "Edit X" / "Edit Y" buttons that close the compare
  modal and open the corresponding edit dialog — the typical flow after
  spotting a mismatch.
- The Compare button is hidden unless **exactly 2** tasks are selected.
  Comparing 3+ would either need pivot UI or a matrix view; the 2-task
  case covers the overwhelming majority of real-world use.

### Build / version

- **Versions bumped to 1.10.0** across all version markers.

---
## [1.9.1] — 2026-04-27

Replaces the PowerShell-based swap helper with a cmd.exe + robocopy
implementation. Adds two diagnostic surfaces (log self-test + helper trace
viewer) so failures stop being silent.

### Changed — Swap helper rewritten in cmd.exe

After observing repeated silent rollbacks of 1.9.0 → tagged-release updates
where the IPC log showed the helper spawning successfully but the file
replacement never taking effect, the helper has been rewritten to cut
PowerShell out of the path entirely.

- **`src-tauri/src/main.rs`: helper is now `wintaskpro_swap.bat` instead
  of `wintaskpro_swap.ps1`.** Spawned via
  `cmd.exe /C start /B "" cmd.exe /C swap.bat <pid> <new> <cur>` with
  `DETACHED_PROCESS | CREATE_NO_WINDOW` flags. cmd.exe has no
  ExecutionPolicy concept (so AppLocker/Group-Policy restrictions on .ps1
  don't apply) and is treated less heuristically than .ps1 by Defender
  and most EDR products.
  > GOTCHA: `start /B "" cmd.exe /C "<script>"` is the standard
  >         "double-spawn for true detachment" idiom on Windows. The
  >         empty `""` is the window title (required positional arg
  >         for `start`).

- **File replacement uses `robocopy /MOV /R:60 /W:1`** instead of a
  hand-rolled retry loop on Move-Item. Robocopy has battle-tested
  retry-on-lock semantics and is the standard Windows file-handling
  primitive. The 60-retry × 1-second budget covers AV scan-on-write
  delays comfortably.

- **Mark-of-the-Web stripping via `del file:Zone.Identifier`** — native
  cmd.exe ADS deletion syntax, no Unblock-File needed. Removes the
  Zone.Identifier alternate data stream that flags the file as
  "downloaded from internet" and triggers SmartScreen / EDR gating on
  some configurations.

- **Two-file logging.** The helper now writes to two distinct files
  in `%LOCALAPPDATA%\WinTaskPro\`:
  - `update_helper.log` — heartbeat trace, OVERWRITTEN each run (always
    shows the latest attempt; great for "what happened just now?")
  - `update_failed.txt` — append-only structured failure log (survives
    across attempts; great for "this has been failing for days")
  The previous PS helper conflated these into one append-only file
  which made it impossible to tell stale entries from current ones.

- **Desktop fallback on any swap failure.** If the in-place swap fails,
  the helper copies the new exe to `%USERPROFILE%\Desktop\WinTaskPro_NEW_VERSION.exe`
  before rolling back. The user always gets the new version somewhere
  visible they can run manually — no more "auto-update did nothing and
  I have no recourse."

### Added — Diagnostic surfaces

Two new buttons in Settings → Developer Logs that turn opaque problems
into one-click diagnostics:

- **🧪 Test Logging.** New `log_self_test` IPC writes a unique marker
  line containing the current PID, then reads back the log tail and
  confirms the marker round-tripped. The result modal shows pass/fail
  for write/read/round-trip plus the resolved log path and the tail
  itself. Answer to "are logs even being written?" in one click.

- **📄 View Trace.** New `read_update_helper_log` IPC reads
  `%LOCALAPPDATA%\WinTaskPro\update_helper.log` and displays it in a
  modal with a Copy button. After any update attempt, this shows the
  exact line where the cmd.exe helper stopped. If the file doesn't
  exist, the modal explains what that means (helper never ran or got
  killed before its first echo).

### Build / version

- **Versions bumped to 1.9.1** across all version markers.

---
## [1.9.0] — 2026-04-27

Major hardening release on top of 1.8.0's first portable in-place auto-update
implementation. The shape of the flow is unchanged (download → verify → swap
→ relaunch); the work in this release fixes every observed failure mode and
adds enough diagnostic surface that future failures aren't silent.

This is also a UX pass: typography bumped one tier across the app so
information-dense views (task table, detail panel, dashboard) read without
leaning in to the screen.

### Added — Auto-update failure surfacing

The 1.8.0 helper could fail silently — the app would exit, the swap would
fail (AV lock, ExecutionPolicy, disk space, whatever), and the user would
manually relaunch the OLD exe with no idea why. This release closes that
diagnostic loop:

- **`src-tauri/src/main.rs`: two new IPCs.** `read_update_failed_marker`
  returns `{path, contents, modified}` if the marker file exists, `None`
  otherwise. `clear_update_failed_marker` removes it. The path resolver
  uses `LOCALAPPDATA` + `WinTaskPro\update_failed.txt`.

- **`src/app.js`: marker check on boot.** Right after `showPage('dashboard')`
  in `init()`, calls `read_update_failed_marker`. If non-null, drops a red
  banner at bottom-right ("⚠ Last update attempt failed [timestamp]") with
  a "View details" button.

- **`src/app.js`: `showUpdateFailureModal()`** displays the marker contents
  verbatim in a monospace block plus a section explaining the most likely
  causes and which fix in this release addresses each. Footer buttons:
  📋 Copy (full marker → clipboard for bug reports), 🗑 Clear marker, Close.

### Changed — Update error UX

When `installUpdate()` itself fails (Rust IPC returns an error rather than
exiting the process — e.g. download failed, PE verify failed, URL allowlist
rejected), the previous behavior was a one-line `showToast` error which was
easy to miss. Now a proper diagnostic modal opens:

- **Error message verbatim** in a monospace box.
- **Tailored diagnosis** based on substring-matching the error text — picks
  the most likely fix among ExecutionPolicy / disk space / PE-verify /
  network / PowerShell / generic.
- **Asset URL spelled out** so the user can copy if needed.
- **Three action buttons:** ↗ Manual download (opens the asset URL in
  default browser), 🔄 Retry (re-runs installUpdate), Close.

### Changed — Asset matcher is forgiving

The previous matcher demanded the asset be named exactly `WinTaskPro.exe`.
If the workflow's rename step didn't run (or the maintainer uploaded an
asset named differently), the auto-updater would say "no asset" and hide
the Update Now button entirely. Now an ordered preference matcher accepts:

  1. `WinTaskPro.exe` (canonical, what the workflow produces)
  2. `WinTaskPro_v{X.Y.Z}_portable.exe` (build_portable.ps1 versioned name)
  3. Anything `WinTaskPro*portable*.exe` (loose match)
  4. Any `WinTaskPro*.exe` not containing setup/install/msi/debug

Also logs every asset on every release plus which one was chosen — so
"why isn't Update Now showing?" is one log line away.

### Fixed — Swap helper failures (silent rollback)

Symptoms: User clicks Update Now → app exits → ~10s later the same version
starts again. The 1.8.0 helper's marker file would help only on
catastrophic failures, not on the rename-succeeded-but-move-failed path
that was actually happening in field reports.

- **`src-tauri/src/main.rs`: Move-Item retry budget bumped 5s → 30s.**
  The previous version had asymmetric budgets: 30s for the rename step
  (current → .bak) but only 5s for the move step (downloaded → live).
  Real-time AV scan-on-write of newly-downloaded executables routinely
  takes 5-15s. The rename step worked because Defender already trusts
  the running .exe; the move failed because the freshly-downloaded
  WinTaskPro.exe was still being scanned. The 30s budget covers
  Defender's typical scan window with comfortable margin.
  > GOTCHA: this asymmetry was the proximate cause of every silent
  >         rollback. The rename budget got bumped during 1.8.0's
  >         hardening pass; missed that the move uses a separate loop.

- **`src-tauri/src/main.rs`: Strip Mark-of-the-Web before the swap.**
  Files written by `Invoke-WebRequest -OutFile` carry an NTFS
  `Zone.Identifier` alternate data stream marking them as "from internet
  zone". SmartScreen uses this to gate process creation, and some EDR
  products treat it as a signal to refuse Move-Item operations across
  protection boundaries. Calling `Unblock-File` removes the ADS,
  reclassifying the file as locally-trusted — appropriate since we just
  downloaded it ourselves over HTTPS from a hardcoded GitHub URL.

- **`src-tauri/src/main.rs`: Marker file is now a complete trace.**
  Three changes:
  1. `[start]` line written immediately on helper entry (so silent
     PowerShell crashes leave a trace instead of nothing)
  2. Every step writes a `[section] OK` or `[section] error` line —
     marker file now reads like a sequential trace
  3. Marker file is **deleted** on full success — present file = something
     went wrong this run; absent file = nothing to report
  > GOTCHA: pre-fix helpers never deleted on failure paths and didn't
  >         write success lines, so the marker accumulated noise from
  >         previous runs. Diagnostics had no way to tell "stale leftover
  >         from a week-old failed update" from "happened on this click."

- **`src-tauri/src/main.rs`: hint about Controlled Folder Access** added
  when rename fails. Defender's CFA blocks writes to Desktop, Downloads,
  and Documents from non-allowlisted apps regardless of admin rights —
  this is the most likely cause when the running .exe lives in those
  locations. The marker now suggests moving the exe to
  `C:\Tools\WinTaskPro\` or similar.

### Fixed — Critical regressions in portable release builds

- **`ram_mb=0` in every boot snapshot since 1.8.0.** sysinfo 0.32 made
  `System::new()` lazy — the constructor doesn't probe memory at all, so
  `total_memory()` returns 0 until you call `refresh_memory()` first.
  Two sites: the boot-snapshot logger in main.rs, and the
  `get_diagnostic_snapshot` IPC. Both now call `sys.refresh_memory()`
  before reading. (The `sys.refresh_memory()` call is cheap on Windows —
  one `GlobalMemoryStatusEx` syscall.) The IPC needed `let mut sys` to
  call refresh through the lock guard.
  > GOTCHA: this was a sysinfo 0.31→0.32 behaviour change documented
  >         only obliquely in their changelog. The compiler was happy
  >         either way; the bug only surfaces in log files.

### Changed — UX / typography

The portable build's information density was too high — fonts cramped at
10–13px across tables, panels, and chrome. Pass through `style.css` to
nudge content text up one tier while keeping uppercase-tracked labels
small and visually quiet:

- **Base body 13 → 14px.** Cascades to anything not pinned by a specific
  rule.
- **Task table content 12 → 13.5px** with row padding 8/10 → 10/12 for
  breathing room. Task-name 14px (bumped via specific rule) and task-path
  subtext 10 → 11.5px so the secondary line is no longer almost invisible.
  Headers stay quiet at 11px uppercase tracked.
- **Detail panel (right side) content 12 → 13.5px.** Property labels 11 → 12px,
  values 12 → 13.5px, item rows 11 → 12.5px. This is the panel users
  inspect tasks in — readability matters most here.
- **Dashboard tables 12 → 13.5px** (Upcoming Tasks, Recently Failed) with
  bumped row padding. Stat-card values stay massive at 40px (focal point);
  labels under them 10 → 11px.
- **Status badges 10 → 11px** (READY, RUNNING, DISABLED) with slightly
  more padding so they're more legible at table-row scale.
- **Buttons 12 → 13px** with padding 6/12 → 7/14 for a more clickable
  feel. `.btn-sm` 11 → 12px. `.icon-btn` 14 → 15px.
- **Form inputs 12 → 13px** with padding 7/10 → 8/12. `.form-hint` and
  `.form-error` 11 → 12px so guidance under inputs reads.
- **Search input 12 → 13px**, slightly wider (220 → 240px).
- **Folder list 12 → 13px**, padding 6/16 → 7/16.
- **Status bar height 22 → 26px**, font 11 → 12px so the elevation
  indicator and folder count are legible.
- **Modal tabs 11 → 12px** with padding 9/16 → 10/18.
- **Stat pills (Total/Running/Ready/etc) 11 → 12.5px** with padding
  3/12 → 4/14.
- **App title 14 → 16px**, nav icons 15 → 17px, nav badge 10 → 11px.

The result is the same dense desktop tool, with everything one tier
larger and proportionally more padding. No layout reflow — every column
width was already overflowing/truncating its contents, so wider chars
### Fixed — Modal + log regressions
  In Tauri 2 release builds, the framework injects a per-page CSP nonce on
  the `script-src` directive to harden against XSS. Per CSP3 spec, when a
  nonce coexists with `'unsafe-inline'`, the latter is **ignored** — every
  inline `onclick="closeModal()"` etc. across the modal footers, the
  delete-folder dialogs, the bulk action confirmations, and roughly half of
  index.html's button wiring became dead handlers.
  > GOTCHA: This works in `tauri dev` because the dev devUrl
  >         (`http://localhost:1420`) bypasses Tauri's CSP injection
  >         entirely — the bug only appears in built portable .exe via
  >         the `tauri://localhost` custom protocol. Spent half an hour
  >         convinced it was a JS scoping issue before realizing.
  Fix: added `"dangerousDisableAssetCspModification": ["script-src", "style-src"]`
  to `tauri.conf.json` `app.security`. This tells Tauri to leave those two
  directives alone — `'unsafe-inline'` keeps its meaning, all inline handlers
  fire normally.

- **No log file ever written in portable release builds.** The previous
  `state()` resolver tried only `%LOCALAPPDATA%\WinTaskPro\logs` with no
  fallback and no write probe — so on machines where:
  - `LOCALAPPDATA` resolves to an unexpected path (some elevation contexts
    redirect it to `C:\Windows\System32\config\systemprofile\AppData\Local`),
  - the directory creates successfully but isn't actually writable (USB
    drives in write-protect mode, locked corporate AppData),
  - or there's any other silent failure,

  the log file just never came into existence. `eprintln!` errors went to
  a stderr nobody could see in a windowed app. Fix: new `resolve_logs_dir()`
  with a 3-tier fallback chain:
  1. `%LOCALAPPDATA%\WinTaskPro\logs`
  2. `<exe-directory>\logs` (portable, next to the exe — what most users
     actually expect for portable apps)
  3. `%TEMP%\WinTaskPro\logs` (last resort, always writable)

  Each candidate is verified writable via a `.write_probe` throwaway file
  before being chosen. The selected path is announced via `eprintln!` (visible
  in `tauri dev`) AND written into the log itself as the first line of every
  session: `[stamp] [INFO ] [devlog] ── session start | log_path=... ──`.
  This last line is what makes the whole thing diagnosable — if the log
  exists at all, the user can see exactly which path won.

- **Log lines lost on crash because flush was conditional.** Previous code
  only flushed on WARN/ERROR, meaning a crash mid-session lost the boot
  snapshot, the navigation trail, and any INFO-level breadcrumb about what
  the user was doing — exactly the diagnostics most useful for bug reports.
  Now every line flushes. Volume is low (a few hundred lines per session
  peak), durability matters far more.
  > GOTCHA: `OnceLock` lazy-init means logging never fires for code paths
  >         that don't log anything (e.g. a quick `--version` invocation).
  >         The session-start stamp confirms init ran, so an empty log is
  >         now meaningful: it means logging was never invoked at all.

### Fixed

- **`src-tauri/src/scheduler.rs`: `windows::core::VARIANT` removed in
  windows-rs 0.61.** The `use windows::{core::*, ...}` block in scheduler.rs
  was relying on the 0.58 re-export that disappeared in the 0.59
  reorganisation. Added an explicit `Win32::System::Variant::VARIANT` import
  to the use block and rewrote the two `windows::core::VARIANT::from(...)`
  call sites to use the bare `VARIANT::from(...)` (the 12 compile errors all
  resolve from this single fix).
  > GOTCHA: when bumping `windows = "X.Y"`, run `cargo build` first and only
  >         tag a version after a clean compile. Wildcard re-exports from
  >         `windows::core::*` are unstable across minor versions.

- **`src-tauri/src/main.rs`: `sysinfo::System::cpu_arch()` returns
  `Option<String>` in 0.32, not `String`.** Two sites — the
  `get_diagnostic_snapshot` struct field and the boot_snapshot `log_info!`
  call — now `.unwrap_or_else(|| "unknown".into())` to match the other
  Option-returning sysinfo accessors right next to them.

### Changed — Auto-update robustness

- **`.bak` rollback safety net.** The swap helper now renames the current
  exe to `<n>.bak` BEFORE moving the new exe into place. If the swap
  fails for any reason (lock contention, cross-volume issue, permission
  error), the helper restores the `.bak` so the user is back to a working
  app instead of stranded with no exe at all. The `.bak` is preserved
  after a successful swap too — it's a manual fallback in case the new
  version turns out to be broken (the user can rename it back). The next
  successful update overwrites it.
  > GOTCHA: prior implementation did a single `Move-Item` and a
  >         `Copy-Item` fallback with no guarded rollback. A failed swap
  >         left the user with neither old nor new — manual recovery was
  >         "download the asset from the release page". Now: rename →
  >         move → on failure, undo the rename.

- **Swap retry budget extended from 5 s to 30 s.** Real-time AV (Defender,
  CrowdStrike, etc.) holds new `.exe` writes open for up to ~10 s while
  scanning. The previous 10×500 ms = 5 s window was tight; 60×500 ms = 30 s
  covers the common cases. The `.bak` rename uses the same long budget
  because that's the lock-contended step.

- **`-ExecutionPolicy Bypass` on every PowerShell spawn.** Three sites:
  `download_and_install_update` (download), the swap helper spawn, and
  `get_event_log_history`. Bypass tells the script host to ignore the
  user's `Set-ExecutionPolicy` for this single invocation; without it,
  the swap helper silently dies on machines where Group Policy or
  AppLocker has set ExecutionPolicy to Restricted/AllSigned. Bypass does
  NOT change the user's persisted policy.
  > GOTCHA: corporate-managed Windows boxes often have ExecutionPolicy
  >         locked down. Rule: every PS invocation that runs in-app code
  >         (not user-authored scripts) needs `-ExecutionPolicy Bypass`.

- **Pre-flight disk-space check.** `download_and_install_update` now calls
  `GetDiskFreeSpaceExW` on `%TEMP%` before kicking off the download. If
  less than 30 MB is free, fail fast with a clear message instead of
  letting `Invoke-WebRequest` choke partway through with a cryptic stream
  error. Best-effort: a failed `GetDiskFreeSpaceExW` is treated as
  "unknown, proceed" so the check doesn't block update on systems with
  unusual mount configurations. Required adding the
  `Win32_Storage_FileSystem` feature to the `windows` crate config.

- **Structured failure marker file.** `%LOCALAPPDATA%\WinTaskPro\update_failed.txt`
  is now line-tagged by section: `[stamp] [rename] msg`, `[stamp] [swap] msg`,
  `[stamp] [rollback] msg`, `[stamp] [launch] msg`. A header line including
  PID, paths, and `.bak` path is written on first failure so support cases
  have everything in one place. The marker is appended-to (not overwritten)
  across attempts so a user retrying the update produces a complete history.
  > GOTCHA: the helper used to write a single-line marker per failure with
  >         no section context. Multi-step failures (e.g. swap fails AND
  >         rollback fails) only recorded the last error. Now every step
  >         that catches a failure writes its own line.

### Changed — Build / version

- **Versions bumped to 1.9.0** across `package.json`, `Cargo.toml`,
  `tauri.conf.json`, `app.manifest` (`1.9.0.0`), `index.html` version pill,
  README badge, README installer filename, app.js Settings fallback.

- **`src-tauri/Cargo.toml`: added `Win32_Storage_FileSystem` feature** to
  the windows-rs feature list (required by the new
  `temp_free_space_mb()` helper).



Version reset to follow the README badge truth (1.7.0 was the last accurate
public release; 2.x was an internal over-bump that never shipped). All work
landed across the 2.0.x and 2.1.x trees is consolidated into 1.8.0 plus the
audit fixes below.

### 🚀 Auto-update — portable in-place self-replace

WinTaskPro now updates itself in place from
`https://github.com/NookieAI/WinTaskPro/releases`. The same pattern as
sister apps (Kura, PS5 Vault). Click **🔄 Update Now** in the banner and
~10–30 seconds later the app re-launches at the new version.

- **`src-tauri/src/main.rs`: new `download_and_install_update` IPC.**
  Downloads the new `WinTaskPro.exe` via PowerShell `Invoke-WebRequest` to
  `%TEMP%`, verifies the PE header (MZ + PE\\0\\0 at offset 0x3C, size 1MB
  to 200MB), writes a swap-helper PS script, spawns it with
  `DETACHED_PROCESS | CREATE_NO_WINDOW`, and calls `process::exit(0)`. URL
  is allowlisted to `https://github.com/.../releases/...` so an
  XSS-via-WebView attacker can't redirect the IPC at a hostile asset.
  > GOTCHA: the swap helper sleeps 800 ms after parent exit because Windows
  >         holds the .exe file lock briefly during process cleanup.
  >         `Move-Item` then retries up to 10× at 500 ms intervals, with a
  >         `Copy-Item`+`Remove-Item` fallback for cross-volume swaps.

- **`src/app.js`: banner has Update Now + View on GitHub buttons.**
  `checkForUpdate()` now extracts the `WinTaskPro.exe` asset URL from
  `data.assets[]` so the in-place flow knows exactly which file to fetch.
  `installUpdate(version, assetUrl)` shows a non-dismissable progress
  modal during the download/swap window. A successful update never returns
  from the Promise (the WebView dies along with the rest of the app); a
  90 s watchdog logs at WARN if the IPC takes too long, and any error
  rebuilds the banner so View on GitHub is still reachable as a fallback.

- **`build_portable.ps1`: canonical output is now `dist\\WinTaskPro.exe`.**
  Plus the versioned `WinTaskPro_v{X.Y.Z}_portable.exe` archive copy.
  The canonical name matches what the auto-updater downloads from the
  release; keeping these in lockstep is part of the update contract.

- **`.github/workflows/release.yml`: uploads `WinTaskPro.exe` to releases.**
  Renames the build output to the canonical name before upload, so the
  auto-updater URL `releases/latest/download/WinTaskPro.exe` always works.
  Added a verify step that polls the public URL post-release with up to
  60 s of retry to confirm the "latest" pointer has propagated. Sanity-
  checks file size before upload (refuses < 1 MB or > 200 MB).

- **`UPDATER.md` rewritten** to document the new flow end-to-end:
  download → PE verify → swap-and-relaunch helper → marker file on
  failure. Includes failure-mode table, AV/SmartScreen mitigations baked
  in, and the upgrade path to Ed25519-signed updates when the project is
  ready for cryptographic verification.

- **`README.md`** auto-update section rewritten for the in-place flow;
  Downloads section flags `WinTaskPro.exe` as the auto-update target.

### Fixed

- **DELETED `src-tauri/src/log.rs`** — the orphaned twin of `devlog.rs` from
  the 2.1.0 module-rename hotfix. Both files contained `#[macro_export]
  macro_rules! log_info!` etc. — leaving `log.rs` on disk meant the next
  agent who added `mod log;` would hit "the name `log_info` is defined
  multiple times" with the failure originating outside the duplicate site.
  > GOTCHA: When a hotfix renames a `mod`, also delete the old file. Dead
  >         source with `#[macro_export]` is a tripwire for future builds.

- **`build_portable.bat`: `if errorlevel 0 pause` always pauses.**
  `errorlevel 0` is true for any errorlevel ≥ 0 — so `pause` ran even in
  CI / piped contexts. Replaced the `choice` heuristic with a `%CMDCMDLINE%`
  check that reliably distinguishes double-click (Explorer launch) from
  console invocation. Pause now only fires on double-click, the original
  intent.

- **`includeUpdaterJson: true` in release.yml without a signing key.**
  The first `git push origin v*` would have failed at `tauri-action`'s
  signing step because no `TAURI_SIGNING_PRIVATE_KEY` secret exists and
  no plugin-updater is wired up. Set to `false` and removed the unused
  `TAURI_SIGNING_*` env vars. The upgrade path to a proper signed updater
  is documented in UPDATER.md (Step 7).

### Changed

- **Cargo.toml: `sysinfo` 0.31 → 0.32, `windows` 0.58 → 0.61.**
  sysinfo 0.32 switched from `windows` to `windows-sys`, eliminating one
  duplicate compile unit. `windows` 0.61 matches Tauri's own transitive
  dependency, eliminating another. `cargo tree --duplicates` should now
  show no `windows` rows. `refresh_processes()` signature updated to
  sysinfo 0.32 form: `(ProcessesToUpdate::All, true)` — the second arg
  enables fresh-process pickup so short-lived processes aren't invisible
  to the Process Manager. Verify on first Windows build with `cargo tree`.
  > GOTCHA: when bumping windows-rs, the `Win32_System_Registry` feature
  >         must be added explicitly — used by the new WebView2 probe.

- **`build_portable.ps1`: removed `cmd.exe` wrapper.** Was
  `Start-Process cmd.exe /c npx tauri build ...` — five processes deep.
  Now `& npx.cmd @BuildArgs 2>&1 | Tee-Object build.log` — one less
  process layer AND build output is captured to `build.log` for
  post-mortem instead of being lost when the console scrolls.

- **`build_portable.ps1`: added `-Sign` flag.** Authenticode-signs the
  output via `signtool sign /sha1 $env:WINTASKPRO_SIGN_THUMBPRINT
  /fd sha256 /tr http://timestamp.digicert.com /td sha256`. SHA-256 is
  re-computed after signing because appending the signature changes the
  hash. The summary block now shows signing status per build.

- **`.github/workflows/release.yml`: portable .exe is now a release asset.**
  `tauri-action` only produces NSIS+MSI; the portable single-file `.exe`
  was being built locally but never uploaded. Added a `npm run build:portable`
  step + `softprops/action-gh-release@v2` upload that attaches
  `WinTaskPro_v{tag}_portable.exe` to the same release. Now the README's
  "Installer or Portable, both functionally identical" claim is actually
  true on the releases page.

- **`UPDATER.md` rewritten end-to-end.** The previous version described
  a Tauri plugin-updater system that was never wired up. The new doc
  reflects the actual notification-only flow, then documents the 8-step
  upgrade path to plugin-updater (when ready) and the portable
  self-replace pattern (with explicit security caveats — never enable
  without code signing, AV will quarantine).

- **README "Auto-updates" section honest.** Was "click Install Update to
  apply silently" — there is no such button. Now describes the
  notification → browser download flow accurately, and explains the
  reasoning (portable can't self-replace, AV would flag dropper-style
  behaviour without a code-signing cert).

### Added

- **`src-tauri/src/main.rs`: WebView2 startup probe.** Portable .exe has
  no installer to bootstrap WebView2. On Windows < 10 21H1 or older LTSC
  builds without WV2, the app would launch, the window would appear
  blank, the user would see no diagnostic. Now the binary checks
  `HKLM\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F30...}` and
  the per-user fallback for the "pv" version string. If WV2 is missing,
  `MessageBoxW` shows the download URL and the process exits with code 1
  before the WebView attaches.
  > GOTCHA: must run BEFORE `tauri::Builder::default()` — once the
  >         builder begins WebView attach, "fail with a dialog" is no
  >         longer reachable cleanly.

- **`src-tauri/src/main.rs`: `get_diagnostic_snapshot` IPC + boot snapshot
  log line.** New IPC returns OS, kernel, host, CPU arch/count, RAM,
  admin status, WebView2 version, log file path, and current log level.
  Same struct is logged at startup as a single line tagged
  `boot_snapshot` so every session begins with a self-contained
  environment diagnostic. The IPC backs the new "Copy Diagnostics"
  button in Settings.

- **`src/app.js`: Copy Diagnostics button (Settings → Developer Logs).**
  Bundles the snapshot above plus the last 50 log entries onto the
  clipboard as a single block. Designed for bug reports — paste the
  block and the maintainer immediately sees the same env data the app
  saw at startup, no back-and-forth needed.

- **`src/app.js`: page-navigation logging.** `showPage()` now emits
  `dinfo('nav', 'page change', { from, to })` on every transition. Makes
  user-reported "I clicked X then Y then it broke" reproducible without
  having to ask which pages they visited.

- **`src/app.js`: `timed()` slow-operation wrapper.** Wraps an async
  function, measures wall time, logs at WARN if elapsed exceeds a
  per-call threshold, ERROR if the function throws. Wired into
  `loadTasksForFolder` (1500 ms threshold — COM enumeration) and
  `renderProcessManager` (800 ms — sysinfo refresh). Fast calls log at
  TRACE so they're invisible at the default INFO level but available
  for performance bug reports.

- **`src/app.js`: structured `checkForUpdate` outcome logging.** Every
  branch (no-network / non-OK / no-tag / up-to-date / new release found)
  now logs at INFO or WARN with `current`, `latest`, and `ms` fields.
  Common bug-report question "did the update check even run?" is now
  answered by a single grep of the log.

- **`build_portable.ps1`: build log capture.** `2>&1 | Tee-Object
  build.log` writes the full cargo/tauri output to `build.log` next to
  `package.json`. Build failure no longer requires re-running with
  fresh terminal scrollback.



### 🚨 Hotfix — 2026-04-20 (same version, post-first-build fixes)

These three issues caused the "modals and buttons don't work, logs don't work either"
symptom reported immediately after the initial 2.1.0 build:

- **Module name collision: `mod log` → `mod devlog`** (`src-tauri/src/main.rs`, `src-tauri/src/devlog.rs` renamed from `log.rs`).
  The `log` crate (v0.4.29) is a transitive dependency of Tauri. Naming our
  module `log` shadowed the external crate at our crate root. Tauri's proc-macros
  and internal code reference `log::` in their expansions, and the resolver
  could target our module instead of the external crate, causing macro
  expansion failures and broken Tauri internals. Renamed the module to `devlog`
  so there is no path collision with any dependency. The public macro names
  (`log_info!`, `log_warn!`, etc.) are kept — only the module they resolve to
  changed (`$crate::log::*` → `$crate::devlog::*`).
  > GOTCHA: When declaring a Rust module in a crate that depends on Tauri (or
  >         anything else that transitively depends on `log`, `tracing`, `serde`,
  >         `tokio`, `anyhow`, etc.), NEVER name the module the same as any of
  >         those dependencies. Even if it appears to compile, macro expansions
  >         that reference the external crate by unqualified path can resolve
  >         to your module and fail in subtle runtime-visible ways.

- **JS error-handler infinite recursion** (`src/app.js`).
  The `window.onerror` handler contained `e.error?.stack?.toString().slice(0, 800)` —
  `.slice` was NOT optional-chained. For any error that bubbled up without a
  populated `.error.stack` (which happens for quite a few error classes, including
  errors thrown from across the IPC boundary), `.toString()` returned `undefined`
  and `.slice` threw a TypeError. That new error re-fired the error event,
  called the handler again, threw again, and so on — the WebView locked up
  silently. Fixed by (a) using full optional chains everywhere, (b) wrapping
  each handler body in its own try/catch, and (c) hardening `dlog()` itself to
  never throw under any circumstance (nested try/catch + defensive coercions).
  > GOTCHA: An exception inside `window.onerror` or `window.unhandledrejection`
  >         re-fires the same event and recurses. These handlers MUST be
  >         bulletproof — every line wrapped, every chain fully optional.

- **Silent catch blocks now log diagnostically** (`src/app.js` `openCreateDialog`,
  `importXml`, `init`).
  Three `catch (_) {}` sites swallowed `get_folders` and `JSON.parse` failures
  with no diagnostic trace. All three now route through `dwarn(target, reason, { err })`
  so the devlog captures why the dropdown is empty or why column preferences
  didn't restore.


### 🐛 Hotfix — 2026-04-20 (logs + UX deep-dive round 4)

Comprehensive audit of the logging pipeline and every button/state path
in the app. Found and fixed bugs that degraded log quality and UX:

**Logs — `submit_task` was writing garbage** (`src/app.js`)
Four call sites used `dlog(target, level, msg, data)` with human-readable
strings in the level slot ('update', 'create OK', 'FAIL') and an object in
the message slot. The logger silently defaulted unknown levels to INFO, and
`String({name, path})` became `"[object Object]"`. Every submit_task log
line was useless — no level accuracy, no readable message, data lost.
Now uses proper `dinfo`/`derror` wrappers with string messages and data
objects in the correct slot. Failure path now correctly logs at ERROR level.

**Logs — no JS boot marker** (`src/app.js` `init`)
Only the Rust side wrote "WinTaskPro starting..." on main(). JS side wrote
nothing on boot, so a log file from a user bug report had no clear session
boundary. Added first-line `dinfo('init', 'app booting', {...})` with
diagnostic context (tauri presence, userAgent, viewport size).

**Logs — init had 2 more silent catches**
Version-pill read and `wtp_auditLog` parse both swallowed errors with
`catch (_) {}`. Now route through `dwarn('init', ...)` with corrupt-data
cleanup (removes the bad localStorage key so it doesn't re-fail next launch).

**Tags & notes persistence — 4 silent catches** (`src/app.js`)
`loadTags`, `saveTags`, `loadNotes`, `saveNotes` all had `catch (_) {}`.
If localStorage quota was exceeded (possible after many tags/notes or other
apps' data), tags/notes just wouldn't save with no indication. If the stored
JSON was corrupt, they'd silently reset with no trace. All four now log via
`dwarn` with failure reason and count context.

**Script editor — silent read-file failure** (`src/app.js` `openScriptEditor`)
`.catch(() => { updateScriptEditorStats(); })` swallowed file-read errors.
Users reporting "the editor opened empty, what happened" had no diagnostic
trail. Now logs via `dwarn('openScriptEditor', 'read_file failed', ...)`.

**UX — refresh interval not bounds-checked** (`src/app.js` `onRefreshIntervalChange`)
Was `parseInt(value) || 30` — a user entering "1" would get a 1-second
auto-refresh that hammers Task Scheduler COM (each `get_all_tasks` takes
~3s for 262 tasks). Now clamps to 5–300 with a toast explaining the clamp.

**UX — dead code in onAutoRefreshChange**
Had `if (autoRefreshTimer) { clearInterval(autoRefreshTimer); }` immediately
after setting the same variable to null. Removed.

**UX — stale About version**
Line 2657 fallback was `'1.7.4'` — 7 minor versions behind. Updated to
`'v2.1.0'` to match current. Only shown if the app-version DOM element is
missing, which shouldn't happen in practice, but better to be accurate.

### ✅ Audit clean sheets

Log chain, IPC wiring, button handlers, settings UI, timer cleanup, keyboard
shortcuts, filter state, modal race prevention — all verified clean:
- JS `dlog()` → `log_event` IPC → Rust `devlog::log_line` → log file
- All 32 JS `invoke()` calls map to all 32 registered Rust commands
- All 60 inline-handler functions are defined
- All 13 Settings panel buttons wired correctly
- All 6 log IPC commands registered and used
- `showPage` cleans up `liveRefresh`, `procRefresh`, and dashboard timers on page leave
- Keyboard handler guards input focus; Escape handled globally
- `filterTasks` is a pure read from `allTasks` — no race
- `_refreshInProgress` flag in `refreshAll` prevents concurrent overlaps
- Modal close-timer race (openModal cancels pending clear) fixed in round 0
- 27 JS-side log calls (dinfo/dwarn/derror) + 16 Rust-side (log_info!/warn!/error!)

### 🐛 Hotfix — 2026-04-20 (video audit round 3)

Frame-by-frame analysis of a 42-second screen recording of the built EXE in
use revealed four UI bugs that would NOT have shown up in any automated test:

**Elevation banner overlapped the Windows title bar** (`src/app.js`).
The banner was `position:fixed; top:0; z-index:9500` — this placed it ABOVE
the app content but BEHIND the OS-drawn window chrome (title bar, app icon,
version pill, minimize/maximize/close buttons). In the video the "⚠ Not
running as Administrator" text was clipped mid-height and the Restart button
was partially obscured by the Windows close button. Fix: removed
`position:fixed` entirely and used `document.body.insertBefore(banner, ...)`
to inject the banner as the first child of `<body>`. Now it sits IN the
document flow above the layout container, the entire app shifts down to
make room for it, and nothing overlaps.
> GOTCHA: `position:fixed; top:0` places content relative to the VIEWPORT,
>         not relative to the window's client area. In Tauri/Electron/WebView
>         apps the OS-drawn title bar and window controls share the same
>         y=0 coordinate space, so anything at `top:0` gets covered or cuts
>         through them. Either use inline insertion (flows naturally) or
>         `top: env(titlebar-area-height, 30px)` with a fallback.

**Stat pills flashed blank for 2-3 seconds on every Task Manager visit**
(`src/app.js` `loadTasksForFolder`). The function unconditionally reset all
six pills to `—` before awaiting `get_all_tasks` IPC (~3 seconds for 262
tasks on a loaded system). During that window, the page looked empty and
broken. Fix: only reset pills when `allTasks` is empty (first-ever load).
On subsequent loads, the previous values stay visible until new data arrives.
Also added a `⏳ Loading tasks…` row in the table body during the first
fetch so the empty page has a clear loading state instead of just blank.

**Bottom status bar showed "0 tasks" while Dashboard showed 199** 
(`src/app.js` `loadDashboard`). The dashboard fetched tasks into a LOCAL
variable (`const tasks = await invoke('get_all_tasks')`) but never populated
the global `allTasks` array that `updateStatusBar()` reads from. So if the
user stayed on Dashboard, the status bar kept showing "0 tasks" forever.
Fix: inside `loadDashboard`, assign the fetched tasks to the globals
(`allTasks`, `filteredTasks`), update the Task Manager nav badge, and call
`updateStatusBar()`. Status bar is now accurate from the moment the
dashboard finishes loading, regardless of which page the user visits next.

**Stray `⋮` glyph above the modal tabs** (`src/style.css`). The `.modal-tabs`
rule had `overflow-x: auto`, which on WebView2 / Windows 11 renders a subtle
vertical ellipsis indicator in the top-right even when content doesn't
actually overflow. All 5 tabs (GENERAL | TRIGGER | ACTION | ADVANCED | XML)
fit comfortably so auto-overflow wasn't buying us anything. Changed to
`overflow-x: hidden`. The ghost ⋮ is gone.

### ✅ Also in this zip

Everything from the previous rounds (hotfix, audit 1, audit 2) is included:
- `mod log` → `mod devlog` rename (the prime cause of "nothing works")
- JS error-handler recursion fix (`.slice` optional-chain bug)
- `dlog()` hardened to never throw
- Rust IPC error-path logging on 6 commands
- 8 silent catches upgraded to `dwarn`/`derror` diagnostic logging
- Toast `'warn'` class fix (was silently un-styled)
- Process Manager column header "Description" → "Status"
- Process list truncation notice

### ✅ Frame-by-frame confirmed working

From the same video:
- Dashboard (199 → 262 tasks after admin restart)
- Folder sidebar with task counts
- Task list with filters and sort
- Detail panel with all 11 context-menu items (Edit, Clone, Run, Stop,
  Disable, Add Note, Copy as PowerShell, Copy Path, Copy Name, Export XML,
  Delete)
- Live Monitor (auto-refresh every 3s, 3 running tasks shown)
- Process Manager (259/259 processes, CPU sort working)
- Audit Log (5 entries, filter dropdown, Export CSV, Clear Log)
- Settings → 🛠 Developer Logs panel fully functional (Log Level dropdown,
  Open Logs Folder button, View Logs button, Log File Path shown:
  `C:\Users\Nookie\AppData\Local\WinTaskPro\logs\wintaskpro.log`)
- Elevation flow: non-admin → "Restart as Admin" → admin mode with
  "🔒 Administrator" in status bar

### 🐛 Hotfix — 2026-04-20 (audit round 2)

Deep audit found these in the first-build report of "many broken features":

**src/app.js**
- **`showToast(msg, 'warn')` didn't style the toast** (L314). CSS only defines
  `.show.success`, `.show.error`, `.show.info`. The `'warn'` class didn't match
  any selector, so the admin-permissions warning displayed as an unstyled
  grey box that users could easily miss. Changed to `'error'` (correct severity
  for a permissions problem; the ⚠ prefix retains the warning semantics).
  > GOTCHA: When a CSS class-map is the styling source of truth, adding a
  >         new "type" string on the JS side without a matching CSS rule
  >         produces a silently-unstyled component. Keep the two in lockstep.
- **Process Manager column header said "Description" but data was `task.status`**
  (L4397). Legacy from the 2.0.0 refactor that removed the Description column
  but left the `<th>` label behind. Fixed the header text.
- **Process list silently truncated at 200** with no indication to the user.
  Now displays a "Showing first 200 of N processes. Use search to narrow the list."
  footer when truncation happens.
- **3 more silent `catch (_) {}` → `dwarn()`** for diagnosability:
  - `refreshFolders` folder-count loader (L289)
  - `checkForUpdate` fetch (L2969) — important; users reporting "update banner
    never appears" now have a log line explaining why (offline, CSP block,
    GitHub rate-limit, timeout)
  - `renderProcessManager` `get_processes` error path (now `derror`)
- **Stray duplicate section-header comment** `// ── Task history ──` immediately
  followed by `// ── Live Monitor ──` at line 3299-3300 — the task-history
  section had been moved but its header comment was left behind. Removed the
  orphan.

**src-tauri/src/main.rs**
- **IPC commands logged entry but not errors.** When `create_task` / `update_task` /
  `delete_task` / `run_task` / `stop_task` / `set_task_enabled` failed, the error
  string was returned to the JS layer (which showed it in a toast) but never
  made it to the log file. Users reporting "Delete failed: <something>" couldn't
  share the full context. Added `.map_err(|err| { log_error!("ipc::X", "failed: {}", err); err })`
  to all 6 commands. Failures now end up in the log with the exact error.

### ✅ Portable-EXE parity audit — clean

Confirmed the portable EXE behaves identically to dev mode:
- No `localhost:1420` hardcoded anywhere in the frontend.
- CSP is identical in both modes — `'unsafe-inline'` in `script-src` means
  inline `onclick` handlers (of which the HTML has ~60) work in both.
- Only one `is_dev` branch in the entire codebase, and it's cosmetic
  (adds a one-line note to the elevation banner saying the devserver
  will also restart elevated).
- `open_in_browser` uses `ShellExecuteW` — works identically in both modes.
- `devserver.js` only runs during `npm run tauri dev` (via `beforeDevCommand`);
  production builds embed `../src` directly via `frontendDist`.

### ✅ GitHub update flow — still works

Confirmed: `checkForUpdate()` polls `api.github.com/repos/NookieAI/WinTaskPro/releases/latest`
3 seconds after app load, compares `tag_name` against the current version pill
via `semverGt()`, and shows a floating banner with a Download button that opens
the GitHub releases page via `open_in_browser` IPC. This is a **notify-and-open-browser**
flow, not auto-install. The Tauri updater plugin (with signed MSI + `latest.json`
manifest) is documented in `UPDATER.md` but not wired into this build.

### 🐛 Critical Fixes (editing tasks was broken)

**src-tauri/src/scheduler.rs**
- **`update_task` registered to the form folder, not the source folder:** The function used `p.folder_path` (from the edit form) instead of `fp` (the folder extracted from the existing task's `task_path`). When the two differed — which happened reliably for tasks loaded via `get_all_tasks` because the detail panel populates the folder field from the displayed task and that field was observed to drift — `RegisterTaskDefinition` would create a NEW copy of the task in the form folder while leaving the original in place. The user saw "task updated successfully" but the task they edited was unchanged and a stray duplicate appeared elsewhere. Fixed: registration now always targets `fp` (the source location). Moving a task between folders is now an explicit operation, not a silent side-effect of editing.
  > GOTCHA: When implementing an "update" against an addressable resource, NEVER let the form's location field override the source identity that the operation is keyed on. Form fields drift; identifiers don't.

- **Trigger-building logic was duplicated between `create_task` and `update_task`:** ~120 lines of trigger-construction code was copy-pasted into both methods. Any divergence between the two branches — even a single missing field — would cause "create works but edit doesn't" symptoms. Extracted into a single module-level `apply_triggers_to_definition(defn, p)` function called from both sites. Both methods now share one codepath; future trigger fixes apply once.
  > GOTCHA: If two functions have identical multi-line blocks, the question isn't whether they will diverge — it's when. Refactor on the second copy, not the third.

**src/app.js**
- **`_editTaskPath` was reset on save failure (regression):** When a task save failed and the modal stayed open, the catch block cleared `_editTaskPath = null`. The user clicking Save again then routed through `create_task` instead of `update_task`, silently creating a duplicate of the task they were trying to fix. The reset has been moved into the success path only; the catch block leaves edit state intact so retries continue to update the original task.
  > This bug was previously fixed in the 1.7.x series and re-introduced. Added a comment block at the call site warning future agents not to reset on failure.

### ✨ New Features

**Dev-level logging system (`src-tauri/src/log.rs`, new module)**
- 5 log levels (TRACE / DEBUG / INFO / WARN / ERROR), default INFO.
- Output: `%LOCALAPPDATA%\WinTaskPro\logs\wintaskpro.log` (rotated to `wintaskpro.log.1` at 5 MB).
- Format: `[2026-04-19T15:23:01.456Z] [INFO ] [scheduler::create_task] msg`.
- Active level is read from a `.level` marker file in the logs folder (or the `WINTASKPRO_LOG_LEVEL` env var); changes apply within one log line without a restart.
- Lazy init via `OnceLock` — no log file is touched until something actually logs.
- Macros: `log_trace!`, `log_debug!`, `log_info!`, `log_warn!`, `log_error!` — all take a `target` string (e.g. `"scheduler::run_task"`) and format args.
- `log_warn!` and `log_error!` flush immediately so a crash-after-write doesn't lose the diagnostic.
- 6 new IPC commands: `log_event` (JS → backend log), `set_log_level`, `get_log_level`, `get_log_tail`, `open_logs_folder`, `get_log_file_path`.
- 8 existing IPC commands instrumented with one-line entry logs: `create_task`, `update_task`, `delete_task`, `run_task`, `stop_task`, `set_task_enabled`, `kill_process`, `restart_as_admin`. Privileged operations (delete, kill, elevate) log at WARN.

**Frontend logging (`src/app.js`)**
- `dlog(target, level, msg, data?)` plus convenience wrappers `dtrace`/`ddebug`/`dinfo`/`dwarn`/`derror`. Mirrors to console (level-filtered) and fires `log_event` IPC fire-and-forget. JS and Rust events appear interleaved chronologically in the same log file.
- Global `error` and `unhandledrejection` listeners route uncaught exceptions to the log file.
- Submit-task flow (the troubled one) now logs entry, success, and failure with the task path and trigger type.

**Settings panel — Developer Logs section (`src/app.js`)**
- Log level dropdown (TRACE → ERROR) — selection persists across launches via the `.level` file.
- "Open Logs Folder" button — reveals the logs folder in Explorer via `ShellExecuteW`.
- "View Logs" button — opens a modal showing the last 200 log entries (newest first) with copy-to-clipboard.
- Live-displayed log file path (monospace, copyable).

**`wintaskpro-clean.ps1` (new file)**
- Kura-style backup + clean tool. Six modes: `clean`, `backup`, `backup-and-clean`, `list`, `restore <zip>`, `dry-run`. Run with no args for an interactive menu.
- Backups go to `%APPDATA%\WinTaskPro\source-backups\` named `wintaskpro-source_v{VERSION}_{TIMESTAMP}.zip`.
- `restore` always creates a safety backup tagged `_pre-restore` before extracting, so a bad restore is recoverable.
- Cleans `src-tauri\target` (via `cargo clean` if available, else rm), `src-tauri\gen\schemas`, `node_modules`, `dist`, `release`.
- Logs every action to the same `%LOCALAPPDATA%\WinTaskPro\logs\wintaskpro.log` file the app uses, so script and app actions can be correlated.
- PS 5.1 compatible (no ternary `? :`, no null-coalescing `??`, no `Set-StrictMode -Stop` / `$ErrorActionPreference = 'Stop'` at script level).

### 📚 Documentation

- **`HANDOVER.md` (new):** End-to-end agent handover document covering the architecture, the editing-tasks-was-broken history, the new logging system, the cleaner script, and a "first steps for the next agent" checklist.
- **`AGENT_RULES.md` updated:** Added Rule 44 (use `dlog`/`log_info!` everywhere — no silent failures), Rule 45 (never let form fields override identifier-keyed operations), Rule 46 (always extract duplicated multi-line logic on the second copy).
- **`README.md`:** Updated the project tree to include `wintaskpro-clean.ps1`, `log.rs`, and `HANDOVER.md`. Added a "Logs and diagnostics" section.

### 🔧 Maintenance

- Version bumped to 2.1.0 across `package.json`, `Cargo.toml`, `tauri.conf.json`, `app.manifest`, and `index.html` version pill.
- Removed orphan `_editTaskPath = null` reset from the JS submit catch block (see fix above).

---


## [2.0.1-build] — 2026-04-12

### Build Warnings Resolved

**src-tauri/src/main.rs**
- **`CoUninitialize` unused import warning eliminated:** `browse_for_folder` imported
  `CoUninitialize` in its local `use` block, but `ComGuard::drop()` (an inner item
  defined inside the same function) references it via fully qualified path
  `windows::Win32::System::Com::CoUninitialize()`. Inner items in Rust do NOT inherit
  the enclosing function's `use` statements — only the crate/module scope is visible
  to them. The local `use CoUninitialize` was therefore dead, triggering
  `#[warn(unused_imports)]`. Removed from the `use` list; added a comment explaining
  why the full path is necessary.
  > GOTCHA: `impl` blocks and other inner items defined inside a function cannot see
  >         that function's `use` imports. Always reference names via full paths or
  >         module-level `use` statements when writing inner items.

---

## [2.0.1] — 2026-04-12

### 🔒 Security

**src-tauri/tauri.conf.json**
- **[CRIT-1] CSP was `null` — replaced with restrictive policy:** `"csp": null` disabled all
  browser-native XSS protection in the WebView. Combined with `withGlobalTauri: true`, any
  XSS in rendered task names/descriptions could call every Tauri IPC command
  (including `write_file`, `kill_process`, `restart_as_admin`) under the elevated process.
  Set: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; connect-src 'self' https://github.com; frame-ancestors 'none'`.

**src-tauri/src/main.rs**
- **[CRIT-2] `open_in_browser` accepted any string — now enforces `https://` / `http://` prefix:**
  `ShellExecuteW` will execute `.bat` files, `.exe` paths, or `file://` URIs if passed a
  non-URL string. A crafted update manifest or XSS payload could trigger arbitrary code
  execution (elevated). Added prefix guard; also switched from the embedded-null verb
  literal (`"open "`) to `PCWSTR::null()` for the default-action idiom.
  > GOTCHA: `ShellExecuteW` is not a URL-only API. Always validate scheme before passing
  >         any user-influenced string to it.
- **[CRIT-3] `read_file` / `write_file` had no path validation — added allowlist:**
  The commands accepted any absolute path, allowing elevated read/write of SSH keys,
  credential stores, registry exports, etc. Added `is_safe_read_path()` /
  `is_safe_write_path()` guards: paths must be absolute, contain no `..` components, and
  have an extension from the allowlist (read: xml/txt/ps1/bat/cmd/json/log/csv;
  write: xml/txt/ps1/bat/cmd/json).
  > GOTCHA: Script-editor `read_file` / `write_file` commands must never accept arbitrary
  >         paths — restrict to known-safe extensions and no `..` traversal.
- **[HIGH-2] `browse_for_folder` leaked COM init — `CoUninitialize` now called on balance:**
  `CoInitializeEx` was called but its return value was discarded and `CoUninitialize` was
  never called. If the call returned `S_OK` (we own the apartment), every invocation leaked
  one COM reference count. Now captures the HRESULT, wraps the dialog in a closure, and
  calls `CoUninitialize()` only when `com_initialized == true` — matching the pattern
  already used by `SchedulerEngine::Drop`.
  > GOTCHA: `CoInitializeEx` return values matter. `S_OK` = you own the init and MUST
  >         call `CoUninitialize`. `S_FALSE` or `RPC_E_CHANGED_MODE` = do NOT uninitialise.

**src-tauri/src/scheduler.rs**
- **[HIGH-1] `env_vars` wrapping: `program_path` was unescaped in cmd.exe argument string:**
  The `env_vars` feature wrapped commands as `cmd.exe /c "{env_sets}{program_path}{args}"`.
  While env variable values were carefully escaped with `escape_cmd_value()`, `program_path`
  was interpolated raw. A path containing `"` could break out of the double-quote context
  and inject arbitrary commands (e.g. `C:oo" & net user hacker /add & echo "`).
  Fixed via new `escape_cmd_path()` function and shared `build_exec_action()` helper.
  > GOTCHA: In cmd.exe double-quoted strings, `"` inside the value terminates the string.
  >         Every path segment interpolated into a /c "..." command must escape `"` → `^"`.

### 🐛 Fixed

**src-tauri/src/scheduler.rs**
- **[MED-1] `get_task_history` returned 0 results on the 29th–31st of certain months:**
  Adding 3 months to SYSTEMTIME correctly adjusted `wMonth` and `wYear` but left `wDay`
  unchanged. On e.g. January 31 → April 31 (invalid), `GetRunTimes` silently returned
  0 results. Added day-clamping logic (accounting for leap years) to `end_st.wDay`.
  > GOTCHA: SYSTEMTIME arithmetic must clamp `wDay` after adjusting `wMonth` —
  >         Windows does not automatically roll invalid dates like `April 31` → `May 1`.
- **[MED-3] `create_task` and `update_task` had duplicated trigger/action/settings blocks:**
  ~150 lines of trigger-building code and the entire env_vars wrapping block were
  copy-pasted verbatim between both functions. `escape_cmd_value` was even defined
  twice as an inner function. Extracted module-level `escape_cmd_value()`,
  `escape_cmd_path()`, and `build_exec_action()`. Both functions now call `build_exec_action`.
  Any future fix to action-building applies once.

**src/app.js**
- **[MED-2] Partial folder enumeration failure was silent:** When Task Scheduler folders
  are inaccessible (non-Admin run), `get_all_tasks` silently returned whatever it could
  reach — a partial list indistinguishable from a full one. Added a post-load check:
  if `is_admin()` returns false and fewer than 5 tasks were returned for "All Tasks",
  a warning toast is shown: "Limited task visibility — run as Administrator to see all tasks".
- **[LOW-1] `setStatus()` was a no-op called 5 times:** The status bar was removed but
  the function body was left as `{ /* status bar removed */ }`. All 5 call sites were
  silently swallowed. Changed to `console.debug("[status]", msg)` so messages remain
  visible in DevTools without surfacing to the UI.
- **[LOW-6] Audit log `localStorage` save swallowed errors silently:** `try { ... } catch (_) {}`
  discarded storage failures without any trace. Changed to `catch (_) { console.error(...) }`.
  Added code comment documenting the tamperability limitation of localStorage for audit data.

### ⚡ Performance

**src-tauri/src/main.rs**
- **[LOW-2] `System::new_all()` on startup replaced with `System::new()`:** `new_all()`
  enumerated all processes, CPUs, memory, and network interfaces on the main thread before
  the window opened, causing measurable startup lag on machines with many processes.
  Changed to `System::new()` (empty init). The first `get_processes()` call performs the
  real refresh lazily.

### 🔨 Build Correctness (found during portable-exe verification)

**src-tauri/src/main.rs**
- **`browse_for_folder`: closure → RAII `ComGuard` pattern:** The previous fix wrapped
  COM dialog calls in a closure to allow `CoUninitialize()` after the dialog. However,
  regular closures do not inherit surrounding `unsafe {}` context in Rust — calling
  `CoCreateInstance`, `GetOptions`, etc. inside a regular `|| {}` without explicit
  `unsafe {}` is a compile error. Replaced with a local `ComGuard(bool)` RAII struct
  whose `Drop` calls `CoUninitialize()` only if `com_owned`. All COM calls remain
  directly inside the outer `unsafe {}` block. Cleanup is guaranteed in all exit paths
  including `?` propagation.
  > GOTCHA: Regular closures `|| {}` do NOT inherit surrounding `unsafe {}` context.
  >         Any unsafe call inside a closure needs its own `unsafe {}` block.
- **`is_safe_read_path` / `is_safe_write_path`: named binding for `to_lowercase()` temp:**
  `allowed_exts.contains(&ext.to_lowercase().as_str())` borrows from a temporary `String`.
  While this compiles in current Rust, NLL lifetime rules can reject it in certain
  editions. Changed to `let lower = ext.to_lowercase(); allowed_exts.contains(&lower.as_str())`.
  > GOTCHA: Always bind `String` temporaries to a named variable before borrowing as `&str`.

**src-tauri/src/scheduler.rs**
- **`build_exec_action`: explicit `unsafe {}` blocks for COM calls:** In Rust 2021,
  `unsafe_op_in_unsafe_fn` is a lint (deny in some configs) that requires explicit
  `unsafe {}` blocks even inside `unsafe fn`. Wrapped all `exec.SetPath`,
  `exec.SetArguments`, `exec.SetWorkingDirectory` calls in `unsafe {}` blocks.
  Also removed a stray `\0` in the format string (BSTR handles null termination).
  > GOTCHA: `unsafe fn` does not grant implicit unsafe context for its body in all
  >         lint configurations. Always use explicit `unsafe {}` for each unsafe call.

**src-tauri/Cargo.toml**
- **LOW-3 version bumps reverted to proven versions:** sysinfo `"0.32"` and windows
  `"0.61"` reverted to `"0.31"` and `"0.58"`. The sysinfo 0.32 `ProcessesToUpdate`
  API and windows 0.61 `Win32::Foundation` import paths cannot be verified without
  a Windows build environment. Deferred with documented comment. See LOW-3 note in file.

**src-tauri/tauri.conf.json** (additional)
- **CSP `script-src` was missing `'unsafe-inline'` — all HTML inline event handlers blocked:**
  `index.html` contains 30 inline event handlers (`onclick`, `oninput`, `onchange`) and
  app.js modal `innerHTML` strings contain ~15 more. With `script-src 'self'` (no
  `'unsafe-inline'`), every button and input in the entire app would be silently non-functional
  in the release build. Added `'unsafe-inline'` to `script-src`. External scripts are still
  blocked. `eval()` is still blocked (no `'unsafe-eval'`). The improvement over `null` CSP
  remains substantial.
  > GOTCHA: `script-src 'self'` without `'unsafe-inline'` blocks ALL inline `onclick`,
  >          `oninput`, and `onchange` handlers — not just injected ones. Every static
  >          HTML button and every dynamically generated `innerHTML` button becomes dead.
- **CSP `connect-src` pointed to `github.com` but update check fetches `api.github.com`:**
  `checkForUpdate()` calls `fetch('https://api.github.com/repos/...')`.
  The previous `connect-src` included `https://github.com` (the browser URL opened
  via `open_in_browser` IPC — which is Rust ShellExecuteW, not subject to CSP at all).
  Fixed `connect-src` to `'self' https://api.github.com`.

**src-tauri/app.manifest**
- **Assembly identity version updated from `1.7.0.0` → `2.0.1.0`:** The manifest
  `assemblyIdentity version` was not updated since 1.7.x. Updated to `2.0.1.0` to
  match the current app version.

**src/app.js**
- **`window.open` dead-code fallback removed from update banner:** The fallback
  `window.open(url, '_blank')` in `showUpdateBanner` had a comment saying "won't work
  inside Tauri but try anyway." `window.open` does not open an external browser in
  Tauri WebView2 release builds. Replaced with `console.error(...)` to log the failure
  without misleading dead code.

### 🔧 Maintenance

**src-tauri/Cargo.toml**
- **[LOW-3] Three simultaneous `windows` crate versions eliminated:** `sysinfo 0.31` pulled
  in `windows 0.57`, our direct dep was `windows 0.58`, and tauri/wry/tao use `windows 0.61`.
  All three compiled, bloating the binary. Updated `windows` from `"0.58"` → `"0.61"` to
  match tauri's version; updated `sysinfo` from `"0.31"` → `"0.32"` (sysinfo 0.32+ uses
  `windows-sys` instead of `windows`, eliminating the 0.57 copy).
  Run `cargo update` after pulling these changes to regenerate `Cargo.lock`.
  > NOTE: After updating, run `cargo build` to verify. The Win32 APIs used
  >       (Task Scheduler COM, VARIANT, BSTR, SYSTEMTIME) are stable across these versions.

**src-tauri/capabilities/default.json**
- **[LOW-4] Capability file now lists explicit permissions:** Added `core:window:allow-show`
  and `core:window:allow-set-focus` alongside `core:default`, making the Tauri 2 capability
  surface auditable and explicit.

**src-tauri/src/scheduler.rs**
- **Duplicate `validate_task_name` block extracted:** Both `create_task` and `update_task`
  contained an identical 8-line name-validation block with the same invalid-character set
  and HRESULT. Extracted into module-level `validate_task_name(name: &str) -> Result<()>`.
  Both callers now use `validate_task_name(&p.name)?`. Any future change to validation
  rules applies once.

**docs**
- **`README.md` "For AI Agents" updated:** Added 8 new gotchas covering CSP, ShellExecuteW
  scheme validation, read_file/write_file allowlists, CoInitializeEx balance, SYSTEMTIME
  day-clamping, validate_task_name canonical usage, and windows crate version alignment.
  Schema version table updated from 1.7.1 → 2.0.1.
- **`AV_SAFETY.md` updated:** Added documented sections for `read_file`/`write_file`
  (path + extension allowlist) and `open_in_browser` (https-only ShellExecuteW). Both
  added to the summary table for AV vendor / IT admin reference.
- **`AGENT_RULES.md` updated:** Rules 35–43 added, encoding all security and correctness
  lessons from the 2.0.1 audit session.

---
## [2.0.0] — 2026-04-05

### 🚨 Critical Fixes

**src/style.css**
- **Task table permanently visible on all pages (CSS specificity bug):** `#page-tasks { display: flex }` was overriding `.page { display: none }` due to higher CSS selector specificity. The result: the task table (stat pills, column headers, task rows) was rendered alongside the Dashboard, Script Library, Audit Log, Process Manager, and Settings pages — taking up half the viewport width on every non-tasks page. Removed `display: flex` from `#page-tasks`; visibility is now correctly controlled by `.page` / `.page.active` only.

**src/app.js**
- **Duplicate `loadTaskHistory()`:** Two implementations existed. The first (weaker) version only called `get_task_history` and showed raw COM-based scheduled times with no fallback. The second (kept) version calls `get_event_log_history` first for real exit-code history, falls back to `loadScheduledRunTimes` with a visible explanation, and manages the "Reload History" button's disabled state.
- **Null guards on `document.getElementById` after `innerHTML` set:** Four call sites used global `getElementById` on elements just created via `innerHTML`. Changed to scoped `parent.querySelector('#...')?.addEventListener(...)`.
- **`initColumnResize()` flag set before DOM check:** `_colResizeInitialized = true` was set before querying the thead elements. If the table wasn't in the DOM yet the flag would lock out future retries. Fixed: DOM query runs first; flag only set if elements exist.
- **`autoRefreshTimer` missing `clearInterval`:** One code path in `onAutoRefreshChange()` called `setInterval` without a preceding `clearInterval`, leaking the old interval.

**src-tauri/src/scheduler.rs**
- **`get_task_history` window direction reversed:** `GetRunTimes(start=now-90days, end=now)` was querying the *past* — but `GetRunTimes` returns *future* scheduled times. Fixed to `GetRunTimes(start=now, end=now+90days)`, matching the "Scheduled runs (next 90 days)" label shown in the UI.

**src-tauri/src/main.rs**
- **Corrupted tray icon emoji:** `🖪` (U+1F5AA, spiral notepad) → `🪟` (U+1FA9F, window).
- **Orphaned comment lines** in `restart_as_admin` — dangling tail of a previously deleted block. Replaced with accurate description.

### New Features / GitHub Release

- **Auto-update pipeline:** `.github/workflows/release.yml` — triggers on `v*` tags, builds on `windows-latest`, signs with Tauri updater signer, publishes GitHub Release with NSIS + MSI installers and `latest.json` updater manifest.
- **`UPDATER.md`:** Step-by-step guide for generating the Ed25519 signing keypair, adding the public key to `tauri.conf.json`, adding the private key to GitHub Secrets, enabling the in-app update check, and tagging releases.
- **`AV_SAFETY.md`:** Documents every security-relevant capability (PowerShell event log query, `TerminateProcess`, UAC elevation), confirms `CheckNetIsolation` is debug-only, explains Authenticode signing options for removing SmartScreen warnings.

### Improvements

**src/app.js**
- **Process Manager — Description column removed:** The Description column was always empty (getting file version info requires a separate WinAPI call not in sysinfo). Replaced with a **Status** column (populated by sysinfo with values like `Run`, `Sleep`) and removed the useless description-field search.
- **Tauri v2 version pill:** `window.__TAURI__?.app?.getVersion?.()` extended with `window.__TAURI__?.core?.invoke?.('plugin:app|version')` fallback for Tauri v2 compatibility.
- **Plural strings fixed:** "1 entries" → "1 entry" in audit log count; "N processes" → "N process/processes" in process manager; filtered task count plural corrected.
- **Audit log singular/plural:** Entry count now reads "1 entry" or "N entries".

**src-tauri/src/main.rs**
- **`restart_as_admin` comment:** Replaced truncated comment with accurate two-line description.

**Bundle / release config (`src-tauri/tauri.conf.json`)**
- Identifier cleaned up: `com.nookieai.wintaskpro`
- Full bundle metadata: publisher, copyright, category, short/long description
- Updater endpoint set: `https://github.com/NookieAI/WinTaskPro/releases/latest/download/latest.json`

### Version bump

All four version files bumped from `1.7.x` → **`2.0.0`**:
`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src/index.html`

---

## [1.7.20] — 2026-04-05

### Fixed (deep scan continued)

**src-tauri/src/scheduler.rs**
- **`get_task_history` time window reversed**: The function computes `start = now - 90 days, end = now` and passes this to `IRegisteredTask::GetRunTimes()`. But `GetRunTimes` returns *future* scheduled run times — times when the task *will* fire based on its trigger definition, not actual past execution records. The window should be `start = now, end = now + 90 days` so the returned times are upcoming runs, matching the JavaScript display label "Scheduled runs (next 90 days)". Fixed by swapping the window direction: `start_st = GetSystemTime()` (now), `end_st = now + 3 months`. Month arithmetic updated accordingly (add 3 months with year carry for months 10–12).

**src/app.js** (continuing from 1.7.19)
- **No XSS vulnerabilities**: All `innerHTML` template literals that embed user-controlled data (task names, descriptions, audit log entries, tags) use `escHtml()` consistently. Tag filter chips use `escHtml(tag)` for both the `data-tag` attribute and the visible button text. Audit log uses `escHtml()` on all four columns.
- **`prefillTrigger` line 888**: Confirmed the `||` chain is correct (`triggerNorm[...] || prefill.trigger_type || 'Once'`). Not a bug — the display in the scan was truncated.

---

## [1.7.19] — 2026-04-05

### Fixed (deep scan)

**src/app.js**
- **Duplicate `loadTaskHistory()`**: Two definitions existed (lines 3009 and 3873). The first used only `get_task_history` (COM-based), displayed `result_code`/`result_text`/`duration_secs`. The second (now the only version) tries `get_event_log_history` (Event Log, real exit codes) first and falls back to `loadScheduledRunTimes` → `get_task_history` with user-visible messaging and a reload button with disabled state. Removed the first.
- **`showUpdateBanner` null hazard**: `document.getElementById('update-install-btn')` and `document.getElementById('update-dismiss-btn')` were called immediately after `document.body.appendChild(banner)`. Changed to `banner.querySelector('#...')` which is scoped to the element and safer.
- **Folder context-menu null hazard**: `document.getElementById('folder-ctx-delete')` called right after `ctxMenu.innerHTML = ...`. Changed to `ctxMenu.querySelector('#folder-ctx-delete')?.addEventListener(...)`.
- **Elevation banner dismiss null hazard**: Same pattern — `document.getElementById('elevation-dismiss-btn')` → `banner.querySelector('#elevation-dismiss-btn')?.addEventListener(...)`.
- **`initColumnResize()` flag set before DOM check**: `_colResizeInitialized = true` was set immediately after the early-return guard, before any DOM queries. If `#task-table thead th[data-col]` elements were absent (table not yet rendered), the flag would prevent future retries. Fixed: now checks `.length` of the query result first; only sets flag if elements exist.
- **`autoRefreshTimer` missing clearInterval**: One code path in `onAutoRefreshChange()` set `setInterval` without calling `clearInterval` first. Added the missing clear before each setInterval set.

**src-tauri/src/main.rs**
- **Corrupted tray icon emoji**: `🖪` (U+1F5AA, spiral notepad) was written instead of `🪟` (U+1FA9F, window). Fixed.
- **Orphaned comment**: `restart_as_admin` had two dangling comment lines that were the tail of a deleted block ("and non-elevated runs both read from the same src/ dir…"). Replaced with accurate comment.

---

## [1.7.18] — 2026-04-05

### Fixed
- `src-tauri/tauri.conf.json`: Restored `devUrl: "http://localhost:1420"` and `beforeDevCommand: "node devserver.js"`. The `devUrl: "wtpdev://localhost"` (no port) caused the Tauri CLI to panic with `No port number in the URL` — Tauri's dev mode explicitly requires an HTTP URL with a port number for devUrl. Custom URI schemes are not valid as devUrl.
- `src-tauri/src/main.rs`: Removed the `wtpdev://` custom URI scheme handler and `src_root` calculation from `main()`. The custom scheme can't be used as devUrl anyway. Restored the correct `main()` structure: CheckNetIsolation → `let engine` → `let sys` → `tauri::Builder::default()`. The devserver (devserver.js, dual IPv4/IPv6 listen) is the correct dev server mechanism — the `wtpdev://` approach was a dead end because Tauri CLI doesn't support it.
  > SUMMARY: The dual-listen devserver (bound to both 127.0.0.1:1420 AND ::1:1420) combined with CheckNetIsolation before the Tauri builder is the correct and complete solution. The app previously wasn't recompiling because of the missing engine/sys variables (fixed in 1.7.17), which meant the stale binary kept running with the wrong devUrl.

---

## [1.7.17] — 2026-04-05

### Fixed
- `src-tauri/src/main.rs`: **Critical compile error** — `engine` and `sys` variables (used in `.manage(AppState { scheduler: Mutex::new(engine), sysinfo: Mutex::new(sys) })`) were accidentally deleted during a previous line-range replacement. The binary was silently not recompiling; the user was running an old stale build. Fixed by restoring the correct initialisation sequence in `main()`:
  1. CheckNetIsolation loopback exemption (debug/Windows, idempotent)
  2. `let engine = SchedulerEngine::new().ok()`
  3. `let sys = sysinfo::System::new_all()`
  4. `let src_root` (for wtpdev:// handler)
  5. `tauri::Builder::default()` with `.register_uri_scheme_protocol("wtpdev", ...)`
  > ROOT CAUSE: The step that replaced the `restart_as_admin` function body also deleted the variables that were defined earlier in the same `fn main()` block, because the replacement range calculation used line-number heuristics that crossed the function boundary.

---

## [1.7.16] — 2026-04-05

### Fixed
- `src-tauri/src/main.rs`: Registered a `wtpdev://` URI scheme protocol handler using Tauri's `register_uri_scheme_protocol` API. This serves `src/` files directly from disk via WebView2's native request interception — **no TCP socket, no HTTP server, no AppContainer loopback restriction**.
  > ROOT CAUSE: WebView2 runs its renderer in an AppContainer. AppContainers have loopback isolation — connections to 127.0.0.1 and ::1 are blocked regardless of host-process elevation. Every approach tried (Python server, Node server, various bind addresses, CheckNetIsolation) is a workaround for this isolation. `register_uri_scheme_protocol` is the correct fix: WebView2 intercepts `wtpdev://` requests BEFORE any network call is attempted, routing them directly to our Rust handler. Zero loopback involved.
  > PRODUCTION: The handler is registered in all builds but the `devUrl` is only set in `tauri.conf.json` for dev. Production builds have no `devUrl` and files are embedded in the binary — the `wtpdev://` handler is never called.
  > RELOAD: When `src/app.js` or `src/style.css` changes, press F5 (Ctrl+R) inside the Tauri window to reload. The handler always reads from disk so changes are picked up immediately — no restart needed.
- `src-tauri/tauri.conf.json`: `devUrl` changed to `wtpdev://localhost`. `beforeDevCommand` removed — no `node devserver.js` or `py -m http.server` needed in dev mode anymore.
- `src-tauri/src/main.rs` `restart_as_admin()`: Reverted to the simple ShellExecuteW version. The complex devserver-restart PowerShell logic is no longer needed because both elevated and non-elevated instances use the in-process `wtpdev://` handler. Removed `base64_encode` helper (was only used by the now-deleted devserver-restart code).

---

## [1.7.15] — 2026-04-05

### Fixed
- `devserver.js`: Rewrote to create TWO HTTP servers — one on `127.0.0.1:1420` (IPv4) and one on `::1:1420` (IPv6) — serving identical content from `./src`.
  > ROOT CAUSE: `server.listen(PORT)` without a host binds to `::` (IPv6 wildcard). On this Windows machine the `IPV6_V6ONLY` socket option appears to be set, so the `::` socket only accepts IPv6 connections (from `::1`). WebView2 resolves `localhost` to `127.0.0.1` (IPv4) internally, connects to `127.0.0.1:1420`, finds nothing listening there, and gets `ERR_CONNECTION_REFUSED`. By binding two separate servers — one per address — we guarantee a hit regardless of which address WebView2 picks for `localhost`.
  > NOTE: The IPv6 server (`::1`) is non-fatal: if the machine has no IPv6 stack, only the IPv4 server runs. The IPv4 server (`127.0.0.1`) is fatal on `EADDRINUSE` so a stale port is caught immediately with actionable kill instructions.

---

## [1.7.14] — 2026-04-05

### Fixed
- `src-tauri/src/main.rs` `restart_as_admin()`: Three Rust compile errors introduced when the Python heredoc wrote the PS command format string.
  1. `ds.replace(''', "''")` — Python wrote Unicode curly quotes instead of a straight single-quote Rust char literal. Fixed to `ds.replace('\'', "''")` — Rust char literal for `'` is `'\''`.
  2. Same issue on `rt.replace(...)`.
  3. The PowerShell format string had continuation backslashes that collapsed everything onto one very long line; Rust then hit a lone `{` in `-ArgumentList '"{}"'` at an unexpected position. Fixed by rewriting the `format!` call to use `concat!()` for the template string — each piece is a separate string literal, eliminating the line-continuation problem and making the `{{` / `}}` / `{}` escaping unambiguous.
- `clean_project.ps1` `Create-SourceBackup`: Backup zip was silently producing nothing. The `System.IO.Compression.ZipFileExtensions::CreateEntryFromFile` approach failed on this machine. Replaced with `robocopy` + `Compress-Archive` — both are built-in Windows tools with no assembly loading:
  - `robocopy` copies the project to a temp staging dir (excluding `src-tauri\target`, `node_modules`, `_archive`, `*.zip`) using `/XD` and `/XF` flags; exit codes 0-7 are success
  - `Compress-Archive -Path "$tempDir\*"` zips the staging dir contents (not the dir itself, preserving relative paths)
  - Temp dir is removed after zipping regardless of success/failure

---

## [1.7.13] — 2026-04-05

### Changed
- `clean_project.ps1`: Completely rewritten as a full interactive menu cleaner, modelled on the reference kura-clean.ps1. Replaces the simple CLI-only tool with:
  - ASCII art header, coloured output helpers (Write-Ok/Warn/Info/Bad/Bold/Dim)
  - **[1] Project health check** — verifies all essential source files, Rust/Tauri files, directories, build tools (cargo/node/npm) and version string consistency across package.json / Cargo.toml / tauri.conf.json
  - **[2] Disk usage breakdown** — bar-chart of every item at project root, colour-coded by type (cleanable = yellow, source = cyan)
  - **[3] Clean build artifacts** — deletes `src-tauri\target\` (via `cargo clean` if available) and `node_modules\`, each with a per-directory confirmation
  - **[4] Clean temp & backup files** — finds and removes `*.log`, `*.tmp`, `*.bak`, `*.orig`, `*.old`, `*~`, `Thumbs.db`, `.DS_Store` outside protected paths; with confirmation
  - **[5] Create source backup zip** — zips all source into `_archive\WinTaskPro_backup_YYYY-MM-DD_HH-mm.zip`, excluding `target\`, `node_modules\`, `_archive\`, `*.zip`; shows file count and compressed size
  - **[6] Dry run** — preview of what would be deleted, nothing changed
  - **[7] Git status** — branch, short status (colour-coded M/A/D/??), last 8 commits
  - **[8] Full clean** — artifacts + temp files in one shot with single confirmation
  - **[Q] Quit**
- CLI flags retained for automation: `-Execute` (delete without menu), `-Aggressive` (also delete backup files), `-Backup` (zip only and exit). When no flags are passed, the interactive menu opens.
- PS 5.1 compatible — no ternary `?:`, no `??`, no `??=`. The `??` on line 574 is the `git status --short` untracked-file flag string, not PowerShell syntax.

---

## [1.7.12] — 2026-04-05

### Fixed
- `src-tauri/src/main.rs` `restart_as_admin()`: In dev mode (`#[cfg(debug_assertions)]`), now kills the non-elevated devserver and relaunches it elevated before relaunching the app. One elevated PowerShell process (one UAC prompt) kills port 1420, then starts `node devserver.js` as an elevated background process. After 1.5s the app itself relaunches elevated. This ensures both the devserver and WebView2 run at the same privilege level.
  > ROOT CAUSE: When the non-elevated devserver serves files and the elevated WebView2 AppContainer tries to connect to it, Windows blocks the connection. CheckNetIsolation was unreliable because it cannot consistently bridge the privilege boundary across all Windows/WebView2 builds. The only reliable fix is matching privilege levels.
- `src-tauri/src/main.rs`: Added `fn base64_encode()` helper (no external crate) for encoding PowerShell `-EncodedCommand` argument, avoiding command-line quoting issues with file paths.
- `src-tauri/src/main.rs`: Added `is_dev` Tauri command — returns `cfg!(debug_assertions)`.
- `src/app.js`: Elevation banner now calls `is_dev()` and shows different content per mode:
  - **Dev mode**: no "Restart as Admin" button; shows instructions to reopen the terminal as Administrator.
  - **Production**: "↑ Restart as Admin" button as before, now with disabled state during restart.

---

## [1.7.11] — 2026-04-05

### Fixed
- `src-tauri/src/main.rs`: Moved `CheckNetIsolation.exe LoopbackExempt` call from `setup()` to the very top of `main()`, before `tauri::Builder::default()`.
  > ROOT CAUSE: "Restart as Admin" launches a fresh elevated `wintaskpro.exe` directly (not via `npm run dev`). The devserver is still running non-elevated. The elevated WebView2 AppContainer cannot reach the non-elevated devserver on loopback. CheckNetIsolation adds the exemption — but only if it runs BEFORE Tauri creates the WebView2 AppContainer process.
  > GOTCHA: `setup()` runs during `tauri::Builder::run()`, by which point Tauri may have already spawned the WebView2 renderer process. The new exemption is not visible to an already-running AppContainer. Moving the call to before `tauri::Builder::default()` guarantees the exemption is in the registry before any WebView2 process exists.
  > GOTCHA: In the non-elevated instance (original `npm run dev`), CheckNetIsolation may fail silently (writing the exemption requires admin). This is acceptable — the elevated instance spawned by `restart_as_admin` runs it successfully on its first launch, and the exemption persists for all subsequent sessions.

---

## [1.7.10] — 2026-04-05

### Fixed
- `devserver.js`: Removed `'127.0.0.1'` host binding. Node now listens on all interfaces (same as Python's `http.server` default).
  > ROOT CAUSE: In the working 1.7.6/1.7.7 run, Python bound to `::` (all interfaces, dual-stack) and WebView2 connected via `::1` (IPv6 loopback). Binding Node to `127.0.0.1` (IPv4 only) meant WebView2's AppContainer could not reach it — AppContainer isolation blocks IPv4 loopback (`127.0.0.1`) in some Windows configurations but allows IPv6 loopback (`::1`). Binding to all interfaces restores the Python behaviour.
- `src-tauri/tauri.conf.json`: `devUrl` changed back to `http://localhost:1420` (from `http://127.0.0.1:1420`). On Windows, `localhost` resolves to `::1` (IPv6) before `127.0.0.1` (IPv4), so WebView2 connects via IPv6 — which works with the all-interfaces binding.
  > GOTCHA: Do not change devUrl to http://127.0.0.1:1420. That forces IPv4 which hits AppContainer isolation. Keep devUrl as http://localhost:1420 so the OS resolves it to ::1 (IPv6) which bypasses the isolation.

---

## [1.7.9] — 2026-04-05

### Fixed
- `devserver.js` (NEW): Replaced `py -m http.server` with a Node.js dev file server. Node is already required for the Tauri CLI — no extra installs. Differences from Python:
  - Explicit `EADDRINUSE` error with kill instructions when port 1420 is held by a previous session (Python failed silently, leaving WebView2 with `ERR_CONNECTION_REFUSED`)
  - Binds to `127.0.0.1` directly (avoids `localhost` DNS ambiguity — Windows may resolve `localhost` to `::1` or `127.0.0.1` depending on the hosts file)
  - Directory traversal prevention
  - Correct MIME types for all served file types
- `src-tauri/tauri.conf.json`: Restored `devUrl: http://127.0.0.1:1420` and `beforeDevCommand: node devserver.js`. Removing `devUrl` in 1.7.8 was wrong — Tauri v2 in dev mode starts its own internal HTTP server on a random port when devUrl is absent, and that server also fails with `127.0.0.1 refused to connect` because the random port isn't covered by any exemption.
  > GOTCHA: Do NOT remove devUrl. Tauri v2 dev mode always uses an HTTP server (either the specified one or its own random-port internal one). The fix for "refused to connect" is to make the server reliable and run CheckNetIsolation — NOT to remove the server.

---

## [1.7.8] — 2026-04-05

### Fixed
- `src-tauri/tauri.conf.json`: Removed `devUrl` and `beforeDevCommand` (Python HTTP server) permanently.
  > ROOT CAUSE: `beforeDevCommand: py -m http.server 1420` fails silently when (a) port 1420 is still held by a previous dev session that was Ctrl+C'd but not fully cleaned up, (b) `py` is not in PATH, or (c) the server starts but crashes. When the server isn't running, WebView2 loads `index.html` from a cached or partial response but `app.js` gets `ERR_CONNECTION_REFUSED` because the script tag fires a fresh request against the now-missing server.
  > WHY THIS WORKS NOW: In 1.7.5 we tried this and got "Origin header is not a valid URL". That error was a CONSEQUENCE of the CSP (added in 1.7.4) blocking Tauri's internal dev server — the page ended up on a chrome-error page, and IPC calls from that error page have an invalid origin. In 1.7.6 the CSP was removed. Without CSP, Tauri's internal server (which it starts automatically when devUrl is absent) is not blocked, the page loads correctly, and IPC works.
  > CheckNetIsolation.exe added in 1.7.6 covers Tauri's internal dev server for loopback UAC just as it covered the Python server.
- `package.json`: Removed `serve` script — no Python HTTP server needed.

---

## [1.7.7] — 2026-04-05

### Added
- `src/app.js`: Resizable columns — drag the border between any two column headers to resize. A thin accent-coloured handle appears on hover. Widths are saved to `localStorage` as `wtp_colWidths` and restored on next launch.
- `src/app.js` `autoFitColumn()`: Double-click any column resize handle to auto-fit that column to its widest content (`scrollWidth` measurement across all visible cells).
- `src/app.js` `autoFitAllColumns()`: Auto-fits every resizable column at once — accessible via the ⚙ Columns picker dropdown ("⟺ Auto Fit All Columns").
- `src/app.js` `resetColumnWidths()`: Clears all saved widths and restores CSS defaults — accessible via the ⚙ Columns picker ("↺ Reset Widths").
- `src/style.css`: `.col-resize-handle` — absolutely positioned 7px-wide invisible hit target on the right edge of each resizable `th`. Turns accent-coloured on hover and during drag.
  > NOTE: `position: sticky` on `<th>` already creates a containing block for absolutely positioned children — no need to add `position: relative`. The handle uses `right: -3px` so it sits centred on the column border rather than inside the cell.

---

## [1.7.6] — 2026-04-05

### Fixed
- `src-tauri/src/main.rs` `setup()`: Added `CheckNetIsolation.exe LoopbackExempt` call inside `#[cfg(all(debug_assertions, windows))]` — runs automatically on every dev launch, no manual step required. Fixes ERR_CONNECTION_REFUSED and "Origin header is not a valid URL" / IPC 500 errors when running `npm run dev` as Administrator.
  > GOTCHA: Windows UAC network isolation blocks elevated processes from making loopback TCP connections. WebView2 (elevated, because WinTaskPro requires admin for Task Scheduler) cannot reach localhost:1420 (non-elevated Python HTTP server). CheckNetIsolation adds a per-user loopback exemption for `Microsoft.Win32WebViewHost_cw5n1h2txyewy` — idempotent, no UAC prompt, writes to HKCU. Production builds are unaffected (files are served via Tauri's asset protocol, no network socket).
- `src-tauri/tauri.conf.json`: Restored `devUrl` and `beforeDevCommand` (removed in 1.7.5 — that change was wrong; Tauri v2 without devUrl still starts its own HTTP server on a random port, so the UAC loopback block still applied). Removed the CSP added in 1.7.4 — the `connect-src` policy broke Tauri's IPC. The IPC protocol uses `http://ipc.localhost` as a scheme but Tauri's origin validation rejected requests when the page origin didn't exactly match. CSP set back to null pending a properly tested Tauri-specific policy.

---

## [1.7.5] — 2026-04-05

### Fixed
- `src-tauri/tauri.conf.json`: Removed `devUrl` and `beforeDevCommand` (the `py -m http.server` dev server).
  > GOTCHA: Windows UAC network isolation blocks elevated processes from making loopback TCP connections to servers started by non-elevated processes. When WinTaskPro is run as Administrator (required for Task Scheduler access), WebView2 could not reach `localhost:1420`, producing ERR_CONNECTION_REFUSED. Removing the HTTP dev server and letting Tauri serve `frontendDist` directly via its internal asset protocol bypasses the loopback restriction entirely — no network socket involved.
- `package.json`: Removed `serve` script (`py -m http.server`) — no longer needed now that Tauri serves the frontend directly.

---

## [1.7.4] — 2026-04-05

### Fixed
- `package.json`: Missing `"tauri": "tauri"` script caused `npm run tauri dev` to error with "Missing script: tauri". Added it. Also fixed `serve` script: `python` → `py` (Windows Python Launcher alias — `python` is not in PATH on stock Windows).
- `src/app.js`: Removed `openRunWithArgsDialog` entirely — the Task Scheduler `Run()` API does not support per-invocation argument overrides, so the dialog collected arguments and silently discarded them. Removed the button from the detail panel, the context menu, and the `run-args` switch case. Removed from `index.html` too.
- `src/app.js` `init()`: Removed automatic `check_for_update` call at startup — `tauri.conf.json` has an empty `pubkey` so the updater plugin errors on every launch. Updated Settings About section to note that auto-update is disabled pending signing key setup.
- `src/app.js` Process Manager: CPU display was labelled "CPU Time" in seconds — misleading since sysinfo returns a percentage of one CPU core. Changed column header to "CPU %" and formatter from `Ns` to `N%`.
- `src-tauri/src/main.rs` `get_processes`: Replaced PowerShell process spawn (200–500ms cold-start per 3-second refresh) with the `sysinfo` Rust crate. `AppState` now holds a persistent `sysinfo::System` so CPU usage deltas are computed correctly between refreshes rather than always reporting 0%.
  > GOTCHA: sysinfo cpu_usage() always returns 0% on the first call after System::new_all(). The persistent System in AppState means the second call (first real refresh) returns accurate values.
- `src-tauri/src/main.rs` `get_event_log_history`: PowerShell script now uses `-FilterHashtable` for source-side event filtering instead of loading all events and filtering in memory — significantly faster on machines with large event logs.

### Added
- `src-tauri/Cargo.toml`: `sysinfo = { version = "0.31", default-features = false, features = ["system"] }` — used by `get_processes` instead of spawning PowerShell.
- `src-tauri/tauri.conf.json`: Content Security Policy added — was `null` (no CSP at all). Set to restrict script/style/image/connect sources to `self` and Tauri's internal IPC endpoints. `style-src` includes `'unsafe-inline'` because the app sets inline CSS variables for theming via JS.
  > GOTCHA: A Tauri app running as Administrator with no CSP is a higher-risk target. Even without external network access, a stored-XSS in a task description field could execute arbitrary code with admin rights.

### Changed
- `package.json`: Version bumped to 1.7.4.
- `src-tauri/Cargo.toml`: Version bumped to 1.7.4.
- `src-tauri/tauri.conf.json`: Version bumped to 1.7.4.
- `src/index.html`: Version pill bumped to v1.7.4. "Run…" button removed from detail panel.
- `src-tauri/src/main.rs` `AppState`: Refactored from `AppState(Mutex<Option<SchedulerEngine>>)` to a named struct holding both `scheduler` and `sysinfo` fields. All command handlers updated to use `state.scheduler` instead of `state.0`.
- `src/app.js` Settings About: "Built with" now lists `sysinfo` alongside Tauri/Rust/JS.

---

## [1.7.3] — 2026-04-05

### Fixed
- `clean_project.ps1`: PS 5.1 compatibility — removed ternary operator `? :` and null-coalescing `??` which are PowerShell 7+ only; these caused the script to crash immediately on the default Windows PowerShell 5.1 installation.
  > GOTCHA: Windows ships PS 5.1 by default. Any `? :` ternary or `??` in a .ps1 that must run on vanilla Windows is a guaranteed crash.
- `clean_project.ps1`: Replaced recursive `Get-ChildItem -Recurse` + post-filter deduplication with a BFS queue walk — the cleaner now skips descending into directories it has already queued for deletion, which is both faster and avoids trying to stat already-deleted paths.
- `clean_project.ps1`: Removed `$ErrorActionPreference = 'Stop'` at script level — this terminated the entire script on the first permission-denied directory entry (common in `.git` internals and `node_modules` junction points).

### Changed
- `AGENT_RULES.md`: Rewritten as v2.0 — removed 9 rules that were specific to a different project (PS4 console management, VoidShell/etaHEN installer detection, PKG server lifecycle, subnet scan IP discovery, Windows Firewall port 8090). Retained and generalised all universal agent-discipline rules (1–20) plus Tauri-specific rules (31, 33). Renumbered to fill gaps. Added explicit PS 5.1 compatibility requirement to Rule 5.

---

## [1.7.2] — 2026-04-05

### Changed
- `clean_project.ps1`: Replaced `clean_project.py` with a native PowerShell script. Same behaviour — dry-run by default, `-Execute` to delete, `-Aggressive` for backup files. Uses `CmdletBinding(SupportsShouldProcess)`, coloured output, and proper top-level deduplication to avoid double-deletion errors when a parent directory is already queued.

### Removed
- `clean_project.py`: DELETED — superseded by `clean_project.ps1`. Python is not guaranteed to be in PATH on all Windows targets; PowerShell is always available on Windows 10/11.

---

## [1.7.1] — 2026-04-04

### Fixed
- `src/app.js` `renderProcessManager`: numeric sort direction was inverted — `(bv - av) * Math.sign(_procSortDir)` produced ascending when descending was expected. Fixed to `(av - bv) * _procSortDir` so the direction flag is consistent with the string-sort branch.
  > GOTCHA: Math.sign is redundant since _procSortDir is always ±1. The real bug was the operand order `(bv - av)` flipping the meaning of the direction flag.
- `src/app.js`: `loadDashboard` was an implicit global assignment (`loadDashboard = async function()`) which is unsafe in strict mode. Changed to a proper `async function loadDashboard()` declaration.
- `src/app.js` `renderSettings`: About section hardcoded `Version 1.0.0` while the app runs as 1.7.0. Now reads the version pill element at render time with a `1.7.0` fallback.
- `src/app.js` `bulkEnable` / `bulkDisable` / `bulkExportXml`: silent empty `catch (_) {}` blocks swallowed all errors with no visibility (Rule 9 violation). Replaced with `console.error(...)` and accurate per-item success/fail counts in the toast message.
- `src/app.js` `openNoteDialog`: `note-save-btn` and `note-clear-btn` `.onclick` assignments had no null guard — a DOM race could cause an uncaught TypeError. Added `const btn = getElementById(...)` + `if (btn)` guards.

### Changed
- `src/style.css`: Full theme refinement pass — sidebar gradient + subtle right-edge shimmer + active-nav icon glow; stat card hover-lift with shadow; gradient top stripe on Running/Ready/Failed cards; spring-curve animation on modals, toasts, and context menus; `btn-primary` gradient with box-shadow; toggle checked state uses accent gradient with glow; health dots gain coloured box-shadows; removed duplicate `.folder-count-badge` rule.

---

## [1.7.0] — 2026-03-22

### Added
- `src/app.js` + `src-tauri/src/main.rs`: Process Manager page — lists running processes, PID/CPU/memory, kill via confirm dialog, auto-refreshes every 3 s.
- `src/app.js` + `src-tauri/src/main.rs`: Real Event Log execution history via `get_event_log_history`; falls back to `get_task_history` (scheduled runs) when Event Log is unavailable.
- `src/app.js`: Task notes (`_taskNotes`) stored in `localStorage`; detail panel Notes section; 📝 Note button turns yellow when a note exists; context menu shortcut.
- `src/app.js`: Copy as PowerShell — `copyAsPowerShell()` generates a complete `Register-ScheduledTask` script; copies to clipboard or shows in modal.
- `src/app.js`: Global search — `toggleGlobalSearch()` loads all tasks via `get_all_tasks` regardless of the selected folder.
- `src/app.js`: Auto-refresh countdown — `startRefreshCountdown()` / `stopRefreshCountdown()` show a live `↺ Ns` counter in the topbar.
- `src-tauri/src/scheduler.rs`: Local timezone offset included on all `last_run` / `next_run` date strings.

### Fixed
- `src/app.js` `cloneTask`: now carries over the full advanced field set — weekly DOW, monthly months/days, exec time limit, repetition interval/duration, conditions, priority. Previously only general + trigger fields were copied.
- `src/app.js` `openDeleteFolderDialog`: now deletes all contained tasks first (via `get_tasks` + `delete_task` loop) before calling `delete_folder`. Previously failed silently on non-empty folders.
- `src/style.css` `#status-bar`: removed distracting bright-blue background — now uses `var(--bg0)`.

---

## [1.0.4] — 2026-03-15

### Added
- `src/app.js`: Tags — colour-coded chips stored in `localStorage`; `#tag-filter-bar` above task table; works alongside search and status filter.
- `src/app.js`: Light/dark theme toggle (`toggleTheme` / `applyTheme`); preference stored as `wtp_theme` in `localStorage`.
- `src/app.js`: CSV export (`exportTasksCsv`); also accessible from Settings.
- `src/app.js`: Run with arguments dialog (`openRunWithArgsDialog`).
- `src/app.js`: Delete folder via sidebar right-click context menu (`openDeleteFolderDialog`).
- `src/app.js`: Inline search clear button (`✕`) shown while typing, hidden when empty.
- `src/app.js` `init()`: Not-Admin elevation banner at startup — calls `is_admin`; shows dismissible red banner with Restart as Admin that calls `restart_as_admin`.

### Fixed
- `src-tauri/src/scheduler.rs` `get_all_tasks`: hidden Microsoft system tasks were being filtered out — now returned to match what Task Scheduler itself shows.
- `src-tauri/src/main.rs` `update_task`: tasks running as SYSTEM or service accounts previously failed to save; principal handling fixed.
- `src/app.js` `renderTable`: control buttons now carry `data-path` attribute instead of positional `data-idx` — prevents stale-index bug when a concurrent auto-refresh re-renders the table between click and handler.
- `src/app.js` `refreshAll`: deduplicated toast notification — was showing two "Refreshed" messages per auto-refresh tick.

---

## [1.0.3] — 2026-03-10

### Added
- `src/app.js` `init()`: Auto-update check 3 s after startup (`check_for_update`); `showUpdateBanner()` bottom-right; "Install & Restart" calls `install_update`.
- `src/index.html`: `#app-version` pill populated from `window.__TAURI__.app.getVersion()` at runtime.

---

## [1.0.2] — 2026-03-07

### Changed
- `src/style.css`: Visual redesign — deeper dark palette (`--bg0: #080a10`), rounded stat cards with coloured top stripe, pill-shaped status badges, `@keyframes modalIn` + `ctxIn` entry animations.

---

## [1.0.1] — 2026-03-03

### Fixed
- `src-tauri/src/scheduler.rs`: path separator handling on folder names with trailing backslash.
- `src/app.js` `updateStatusBar`: displayed raw path string instead of friendly folder name.

---

## [1.0.0] — 2026-03-01

### Added
- Initial release. Full Windows Task Scheduler COM bridge (`get_folders`, `get_tasks`, `get_all_tasks`, `create_task`, `update_task`, `delete_task`, `run_task`, `stop_task`, `set_task_enabled`, `export_task_xml`, `import_task_xml`, `create_folder`, `delete_folder`). Dashboard, Task Manager with bulk ops, Live Monitor, Script Library, Audit Log, XML import/export, inline script editor, column picker, auto-refresh, desktop failure notifications.

---

[Full release history](https://github.com/NookieAI/WinTaskPro/releases)
