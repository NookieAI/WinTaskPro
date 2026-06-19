# AGENT_RULES.md — v2.0
# Drop this file in the project root. Paste its full contents as the FIRST message
# of every new agent session on this project. No exceptions.

---

## Rule 1 — Mandatory Files
Every session must ensure these files exist at the project root:
- README.md, CHANGELOG.md, AGENT_RULES.md, clean_project.ps1, .gitignore
Create any that are missing before doing any other work.

---

## Rule 2 — Change Summary Required
Every response that touches a file MUST open with:
```
CHANGE SUMMARY
- app.js: what changed and why
- style.css: what changed and why
```
No exceptions. No "I'll now make the changes" without the summary first.

---

## Rule 3 — CHANGELOG Format
Use Conventional Changelog style. Every entry must name the file and explain WHY.
```
## [1.0.x] - YYYY-MM-DD
### Fixed
- src/app.js renderProcessManager: numeric sort direction was inverted — (bv - av)
  produced ascending when _procSortDir = -1 meant descending. Fixed to (av - bv) * _procSortDir.
  > GOTCHA: direction flag convention must match between numeric and string sort branches.
### Added
- clean_project.ps1: Created project cleaner — dry-run default, -Execute, -Aggressive.
```

---

## Rule 4 — README Must Have
Features, Install, Usage, Project tree, For AI Agents section, link to CHANGELOG.
The "For AI Agents" section must list: coupled files, known gotchas, schema versions.

---

## Rule 5 — clean_project.ps1
Must exist. Use dry-run by default, -Execute to delete, -Aggressive for backups.
Must be a PowerShell .ps1 file — Python is not guaranteed on all Windows targets.
Never delete: itself, README, CHANGELOG, AGENT_RULES, .git, src-tauri/capabilities/.
Compatibility: must work on PowerShell 5.1 (Windows default). No ternary operator,
no null-coalescing ??, no Get-CimInstance-only patterns without a 5.1 fallback.

---

## Rule 6 — File Editing Standards
- Always read the CURRENT file before editing. str_replace on stale content silently corrupts.
- Full section output always — no "..." truncation.
- State explicitly: DELETED (filename) — reason: X.

---

## Rule 7 — Verify Before Delivering
BEFORE packaging or calling the task done:
- JS:  node --check filename.js — must pass zero errors
- PS1: verify braces/parens are balanced, no PS7-only syntax (ternary ?: , ??, ??=)
- Never package a zip containing a known error.

---

## Rule 8 — Coding Standards
- JS: no bare .catch(() => {}) — always log or surface the error with console.error()
- PS1: compatible with PowerShell 5.1 unless the project explicitly targets PS7+
- Functions under 40 lines where possible. Split if longer.
- Platform-specific code: // WINDOWS ONLY: reason

---

## Rule 9 — Error Handling
- JS: never swallow errors with empty catch. Always console.error() at minimum.
  Silent no-ops are acceptable ONLY if the feature is optional AND there is a visible fallback.
- PS1: use -ErrorAction SilentlyContinue on filesystem walks; use try/catch with
  Write-Warning for operations where failure should be visible to the user.
- Never use $ErrorActionPreference = 'Stop' at the script level in a cleaner tool —
  it will crash the entire script on the first permission-denied filesystem entry.

---

## Rule 10 — No Scope Creep
Fix only what was asked. List everything else noticed as:
```
NOTICED BUT NOT CHANGED:
- app.js line 34: potential crash on null selectedTask
- style.css line 210: duplicate .folder-count-badge rule
```
Do not silently fix unrequested things — the user may have a reason for them.

---

## Rule 11 — Regression Check
After every non-trivial change, explicitly state:
```
REGRESSION CHECK
[x] Task table still sorts correctly after process sort fix
[x] Bulk enable/disable still refreshes after operation
[ ] NOT VERIFIED: auto-update banner (requires live GitHub release endpoint)
```

---

## Rule 12 — Context Window Hygiene
Never re-read a 500+ line file fully if you only need one section.
Use grep/sed to find the exact lines. State what you searched for.
"I read the file" without a targeted search on large files = wasted tokens.

---

## Rule 13 — Dependency Hygiene
When adding a package: record exact version in CHANGELOG under ### Added.
When bumping: record under ### Changed with reason.
When removing: grep ALL files for the old dependency name before declaring it gone.
> GOTCHA: a removed Tauri plugin may linger in capabilities/default.json and
>         capabilities/dev.json even after removal from Cargo.toml — causes build errors.
>         Always grep capabilities/ when removing a Tauri plugin.

---

## Rule 14 — Git Hygiene
Conventional commit messages. Never commit: target/, node_modules/, *.log, *.key,
Cargo.lock changes without an explicit reason, capabilities schemas auto-generated files.

---

## Rule 15 — Platform Assumptions
Never hardcode \ vs / path separators — use the path API.
Annotate every OS-specific block with // WINDOWS ONLY or // UNIX ONLY.

---

## Rule 16 — Session Complete Checklist
Sign off every session with:
```
SESSION COMPLETE
[x] node --check src/app.js passed
[x] All new Tauri commands registered in main.rs
[x] CHANGELOG updated
[x] No open TODOs left untracked
[x] Version strings consistent across package.json / Cargo.toml / tauri.conf.json / index.html
[x] Zip packaged and verified (Rule 41)
```

---

## Rule 17 — Clean Command Protocol
Dry-run → show output → confirm → execute → log in CHANGELOG.
Never run clean_project.ps1 -Execute without showing dry-run output first.

---

## Rule 18 — Never Hallucinate APIs
Before using any function or module path you didn't just write: verify it exists.
Search the file. If unsure, state: "I believe this is X — verify it exists before building."

---

## Rule 19 — No Open TODOs
If you write // TODO or # TODO, resolve it in the same session OR add a
CHANGELOG entry under ### Deprecated tracking it. A TODO that leaves the
session is a bug waiting to happen.

---

## Rule 20 — Multi-File Sync
When you change a function signature, event name, or command name:
search every file that references it and update all call sites in the same response.
Maintain a FILES THAT MUST STAY IN SYNC table in README.md under "For AI Agents":

| Change | Files to update |
|--------|----------------|
| New Tauri command | main.rs (register) + app.js (invoke call) |
| Remove Tauri plugin | Cargo.toml + main.rs + capabilities/default.json + capabilities/dev.json |
| Version bump | package.json + Cargo.toml + tauri.conf.json + index.html version pill |
| CSS variable rename | style.css (definition) + app.js applyTheme() both branches |

---

## Rule 21 — Read Before Write
Always read the current state of a file before editing.
State: "Reading lines X–Y of filename for context."
str_replace on stale content silently fails or produces corrupt output.

---

## Rule 22 — Session Startup Protocol
At the start of every new session on this project, before touching anything:
```
SESSION STARTUP
1. Read CHANGELOG.md — last 2 entries minimum
2. Read README.md "For AI Agents" section — coupled files and known gotchas
3. grep -r "GOTCHA:" src/ src-tauri/src/ — review all annotated traps
4. grep -r "TODO|FIXME|HACK" src/ src-tauri/src/ — note open items
5. Confirm which zip is the current baseline
```

---

## Rule 23 — Version Consistency
When bumping a version number, grep the entire project for the old version string.
Must all match: package.json, Cargo.toml, tauri.conf.json, index.html version pill.
A mismatched version in the UI is unprofessional and confuses users.

---

## Rule 24 — Confirm Before Destructive Actions
These require explicit user confirmation before executing:
- Deleting any file not in CLEAN_PATTERNS
- Overwriting a file the user hasn't asked to change
- Changing localStorage/settings JSON schema (users lose data on downgrade)
- Running clean_project.ps1 -Execute
State what you're about to do and wait for "yes" / "go ahead."

---

## Rule 25 — Never Claim "It Works" Without Evidence
Do not write "this fixes the issue" unless you have:
- Run node --check and it passed, OR
- Traced the logic step-by-step through all cases
If you cannot verify: "This should fix X — verify by running [specific command]."

---

## Rule 26 — Testing Checklist Per Change Type
| Change | Minimum verification |
|--------|----------------------|
| JS logic | node --check + manual trace |
| New Tauri command | main.rs registration + app.js invoke call site |
| Remove Tauri plugin | grep capabilities/*.json for plugin permission name |
| Modal open/close | All exit paths confirmed (close button, overlay click, Escape) |
| Version bump | grep entire project for old version string |
| PS1 script | Braces balanced, no PS7-only syntax, -ErrorAction not Stop at top level |

---

## Rule 27 — When to Ask vs Proceed
Proceed without asking: syntax fixes, doc updates, clearly scoped bug fixes.
Ask first: behaviour visible to users, schema changes, >3 files affected, approach A vs B.
Always ask: if you would silently pick an approach the user might disagree with.

---

## Rule 28 — Backwards Compatibility for User Data
Never change the JSON schema stored in localStorage without a load-time migration
that converts the old format to the new format.
Document schema versions in CHANGELOG under ### Changed.
A user installing a new version must never lose their tags, notes, or audit log.

---

## Rule 29 — Build Verification Before Release
Before tagging a release or delivering a final zip:
```
RELEASE CHECKLIST
[x] All version strings match (package.json / Cargo.toml / tauri.conf.json / index.html)
[x] node --check src/app.js passes
[x] No TODO left open
[x] CHANGELOG has entry for this version
[x] README is current
[x] capabilities/default.json has no removed plugin permissions
[x] No debug artifacts or hardcoded test values in source
[x] .gitignore covers target/, node_modules/, *.log, *.key
```

---

## Rule 30 — Python String Replacement in Source Files
When using Python to patch JS or Rust source files that contain quotes:
- NEVER use triple-quoted Python strings with embedded quote characters directly.
- ALWAYS use raw strings (r'...') or escape every inner quote explicitly.
- After any Python str.replace() on source, verify the result immediately with grep.
> GOTCHA: Unescaped quotes written into source break string literals silently.
>         Always spot-check the patched lines before packaging.

---

## Rule 31 — Tauri Command Completeness Audit
Before any release, verify every invoke('cmd') in app.js has a matching registered
command in main.rs. A missing registration causes a runtime crash, not a build error.
Pay attention to optional-chaining calls (?.()) — they mask missing entries silently.

---

## Rule 32 — Watching Uploaded Videos
Agents CAN watch video files uploaded by the user. Never say "I cannot watch videos."
Extract frames with ffmpeg, then view the resulting images.

```bash
# Extract 1 frame per second
ffmpeg -i /mnt/user-data/uploads/video.mp4 -vf "fps=1" /home/claude/frame%03d.jpg -y

# Extract a specific timestamp (e.g. 15 seconds in)
ffmpeg -i /mnt/user-data/uploads/video.mp4 -ss 15 -vframes 1 /home/claude/frame_15s.jpg -y
```

Protocol: extract frames → identify key moments → describe UI state exactly →
cross-reference with source code to diagnose the bug.

---

## Rule 33 — Never Await IPC Before Showing a Modal
Modal open functions must show the modal INSTANTLY. Never await IPC calls
(invoke, getLocalIp, etc.) before setting element.style.display = 'flex'.

Pattern:
1. Read cached/in-memory values synchronously → populate fields
2. Show modal immediately
3. Fire background Promise.all() for IPC → update fields silently if different

> GOTCHA: Sequential awaits before a modal open create visible lag the user
>         reads as "the button doesn't work." Show first, fetch after.

---

## Rule 34 — Always Deliver Changes as a Zip
When a session produces file changes, ALWAYS package the output as a single .zip
containing the files at their correct project-relative paths.

```
WinTaskPro_fixes_YYYY-MM-DD.zip
├── src/app.js
├── src/style.css
└── clean_project.ps1
```

Steps:
```bash
cd /home/claude/WinTaskPro
zip /mnt/user-data/outputs/WinTaskPro_fixes_YYYY-MM-DD.zip src/app.js src/style.css ...
unzip -l output.zip   # verify paths are relative, no /home/claude prefix
```

Rules:
- Zip name must include date
- Paths inside the zip MUST be relative (cd to project root first, then zip)
- Include ONLY changed files — never node_modules, target/, *.lock
- Run unzip -l to verify before presenting

> GOTCHA: zip /output/file.zip /home/claude/project/file.js embeds the full
>         absolute path. Always cd to the project root first.

---

---

## Rule 35 — CSP Must Never Be null
`"csp": null` in `tauri.conf.json` disables all WebView XSS protection and, combined with
`withGlobalTauri: true`, gives any injected script full access to every Tauri IPC command.
Always set a real CSP. Minimum safe policy for WinTaskPro:

```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://github.com; frame-ancestors 'none'"
```

> GOTCHA: Even with escHtml() applied everywhere, a null CSP means a single missed escape
>         anywhere in the codebase — including future code — is an immediate IPC takeover
>         running under the elevated process.

---

## Rule 36 — ShellExecuteW Requires URL Scheme Validation
`ShellExecuteW` is not a URL-only API. Passing it `C:\Windows\System32\calc.exe`,
a `.bat` path, or a `file://` URI will execute it. Any Tauri command that calls
`ShellExecuteW` with user-influenced input MUST validate the URL scheme first:

```rust
if !url.starts_with("https://") && !url.starts_with("http://") {
    return Err("Only http/https URLs are permitted".into());
}
```

> GOTCHA: A crafted update manifest (latest.json) or XSS payload can supply the `url`
>         argument. Without scheme validation this is trivially exploitable under Admin.

---

## Rule 37 — read_file / write_file Must Have Path Allowlists
These Tauri commands are exposed to the entire WebView surface. They MUST:
1. Reject relative paths (no `is_absolute()` = instant Err)
2. Reject any path containing `..` components
3. Allow only known-safe file extensions

Read allowlist: `["xml", "txt", "ps1", "bat", "cmd", "json", "log", "csv"]`
Write allowlist: `["xml", "txt", "ps1", "bat", "cmd", "json"]`

> GOTCHA: The app runs as Administrator. An unrestricted write_file can overwrite
>         system files or startup scripts. An unrestricted read_file can exfiltrate
>         SSH keys, credentials, NTLM hashes from AppData.

---

## Rule 38 — CoInitializeEx Must Be Balanced by CoUninitialize
Every `CoInitializeEx` call whose HRESULT is `S_OK` (return value `.0 == 0`) means
YOU own the COM apartment initialisation and MUST call `CoUninitialize()` to balance it.

Pattern:
```rust
let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
let com_owned = hr.0 == 0;  // true = we own it, false = already initialised
// ... do COM work ...
if com_owned { CoUninitialize(); }
```

`S_FALSE` (`.0 == 1`) and `RPC_E_CHANGED_MODE` (`.0 == 0x80010106u32 as i32`) mean COM
was already initialised by someone else — do NOT call `CoUninitialize` in those cases.
SchedulerEngine::Drop already handles this correctly — match that pattern everywhere.

> GOTCHA: Discarding the CoInitializeEx return value (`let _ = CoInitializeEx(...)`)
>         means you can never know whether you own the init, so you can never safely
>         uninitialise. Always capture the return.

---

## Rule 39 — cmd.exe Double-Quote Escaping for Path Arguments
When wrapping a command in `cmd.exe /c "..."`, every segment interpolated into the
outer double-quote context must escape `"` → `^"`. Use this function:

```rust
fn escape_cmd_path(s: &str) -> String {
    s.replace('"', "^"")
}
```

The existing `escape_cmd_value()` handles the env-var *values* (& | < > ^ ( ) ").
`escape_cmd_path()` is separate because paths have a different character risk profile.
Both are required whenever env_vars are set.

> GOTCHA: `program_path` may legally contain `"` in some UNC / quoted-path scenarios.
>         Without escaping, a path like `C:\foo" & evil_cmd & echo "` breaks out of
>         the outer quotes and injects arbitrary commands.

---

## Rule 40 — SYSTEMTIME Day Must Be Clamped After Month Arithmetic
After computing a future SYSTEMTIME by adding months, always clamp `wDay` to the
last valid day of the resulting month. `GetRunTimes` rejects invalid dates silently
(returns 0 results instead of an error):

```rust
let max_day: u16 = match end_st.wMonth {
    4 | 6 | 9 | 11 => 30,
    2 => if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) { 29 } else { 28 },
    _ => 31,
};
if end_st.wDay > max_day { end_st.wDay = max_day; }
```

> GOTCHA: January 31 + 3 months = April 31, which is invalid. Windows does NOT
>         roll this to May 1 in SYSTEMTIME contexts — it silently fails the API call.
>         Symptom: "Scheduled runs" panel is empty for users on the 29th–31st of some months.

---

## Rule 41 — Never Duplicate Rust Action-Builder Blocks
`create_task` and `update_task` share identical trigger / action / settings logic.
This logic MUST live in shared helper functions (`build_exec_action`, etc.).
If you copy-paste a block between these two functions for any reason, immediately
extract it. Any security fix applied to a copy-pasted block MUST be applied to
both copies — and it will be missed.

> GOTCHA: The env_vars escaping block was copy-pasted, and the HIGH-1 injection
>         fix would have been applied to only one copy if the duplication had persisted.

---

## Rule 42 — windows Crate Version Must Match tauri/wry/tao
The `windows` crate version in `Cargo.toml` should match the version used by tauri,
wry, and tao to avoid compiling multiple copies of the same Win32 FFI bindings.

Check the current tauri-required version:
```bash
cargo tree -p tauri | grep "^windows v"
```

Then update `[target.'cfg(windows)'.dependencies]` windows version to match.
Also check sysinfo — sysinfo 0.32+ uses `windows-sys` instead of `windows`,
avoiding a version conflict entirely.

> GOTCHA: Having windows 0.57, 0.58, and 0.61 all in Cargo.lock means three sets
>         of Win32 type definitions compiled into the binary — significant size bloat
>         and potentially confusing "type mismatch" errors if types from different
>         versions are mixed at API boundaries.

---

## Rule 43 — Audit getenv / No-Op Functions Before Shipping
Before any release, grep for functions whose body is a comment or empty:
```bash
grep -n "{ /\*.*\*/ }" src/app.js
```
A no-op function that is still being called (like `setStatus()` was) silently
discards information that may be important during debugging. Either restore the
function or remove all call sites.


---

## Rule 44 — Regular Closures Do NOT Inherit unsafe Context
A regular Rust closure `|| { ... }` does NOT inherit the `unsafe {}` context it is
defined inside. This is a compile error:

```rust
unsafe {
    let result = (|| -> Result<String, String> {
        some_unsafe_fn()?;  // ← ERROR: unsafe fn called in safe context
    })();
}
```

Fixes, in order of preference:
1. **RAII guard pattern** — eliminate the closure; use a Drop-based guard for cleanup:
   ```rust
   struct Guard(bool);
   impl Drop for Guard { fn drop(&mut self) { if self.0 { unsafe { cleanup(); } } } }
   unsafe { let _g = Guard(condition); unsafe_work()?; }
   ```
2. **Inner `unsafe {}` blocks** — wrap each unsafe call inside the closure:
   ```rust
   let result = (|| { unsafe { some_unsafe_fn() }.map_err(|e| e.to_string()) })();
   ```
3. **`unsafe` closure** — mark closure as unsafe and call with `unsafe { closure() }`:
   This syntax is not always available; prefer option 1 or 2.

> GOTCHA: This applies to ALL closures, including immediately-invoked ones like
>         `(|| { ... })()`. The surrounding `unsafe {}` block does not propagate.

---

## Rule 45 — Always Bind String Temporaries Before Borrowing as &str
`collection.contains(&value.to_string().as_str())` borrows from a temporary `String`
that may be dropped before the borrow is used, depending on the Rust edition and NLL
version. Always bind to a named variable:

```rust
// ❌ Fragile — temporary String may not live long enough:
allowed.contains(&ext.to_lowercase().as_str())

// ✓ Correct — String lives for the full statement:
let lower = ext.to_lowercase();
allowed.contains(&lower.as_str())
```

> GOTCHA: This is especially common in match arms where a method chain creates
>         a temporary that needs to be borrowed for a comparison.

---

## Rule 46 — unsafe fn Body Still Requires explicit unsafe {} for Lint Safety
In Rust 2021 edition, `unsafe_op_in_unsafe_fn` is enabled as a warning in many
lint configurations and may be deny-level in CI. Even inside an `unsafe fn`, wrap
each unsafe operation in an explicit `unsafe {}` block:

```rust
// ❌ Compiles but may warn (or error under strict lints):
unsafe fn my_fn() {
    some_unsafe_ffi_call();
}

// ✓ Explicit and lint-clean in all configurations:
unsafe fn my_fn() {
    unsafe { some_unsafe_ffi_call(); }
}
```

The BSTR/COM operations in build_exec_action and the scheduler use this pattern.

---

## Rule 47 — BSTR::from Does NOT Need a Null Terminator
`BSTR::from("my string")` handles null termination internally. Never append ` `
to a string before passing it to `BSTR::from` — the null byte becomes data:

```rust
// ❌ Bug:   is part of the string data in BSTR
let wrapped = format!("/c "..." ");
exec.SetArguments(&BSTR::from(wrapped.trim_end_matches(' ')))?;

// ✓ Correct:
let wrapped = format!("/c "..."");
exec.SetArguments(&BSTR::from(wrapped.as_str()))?;
```


---

## Rule 48 — CSP `script-src 'self'` Blocks Inline Event Handlers
`script-src 'self'` without `'unsafe-inline'` silently blocks ALL inline event
handlers — `onclick`, `oninput`, `onchange`, `onsubmit`, and all others. This
includes handlers in static HTML AND handlers injected via `innerHTML` in JavaScript.

WinTaskPro uses 30+ inline handlers in `index.html` and ~15 in modal `innerHTML`
strings. Without `'unsafe-inline'`, every button in the app becomes silently dead.

Required minimum for WinTaskPro:
```json
"script-src 'self' 'unsafe-inline'"
```

What `'unsafe-inline'` still does NOT allow:
- External scripts from other domains (still blocked by `'self'`)
- `eval()` / `new Function()` (still blocked — needs `'unsafe-eval'` which we never set)

> GOTCHA: A browser will NOT show a CSP error for blocked inline handlers in DevTools
>         in all configurations — the button just does nothing. This can look exactly
>         like a JavaScript logic bug and be very hard to diagnose without knowing to
>         check the CSP header.

---

## Rule 49 — CSP `connect-src` Covers fetch/XHR Targets, NOT IPC or ShellExecuteW
`connect-src` controls what `fetch()`, `XMLHttpRequest`, WebSocket, etc. can
connect to. It does NOT apply to:
- Tauri IPC (`invoke()`) — handled by the Tauri runtime, not the browser
- `ShellExecuteW` / `open_in_browser` — a Rust Win32 API call
- Any Rust-side network request

For WinTaskPro, only the update check `fetch('https://api.github.com/...')` is
controlled by `connect-src`. The `open_in_browser` command opens a browser window
via `ShellExecuteW` — it is invisible to CSP.

```json
"connect-src 'self' https://api.github.com"
```
Not `https://github.com` — that URL is only opened by Rust, not fetched by JS.

> GOTCHA: Adding `https://github.com` to connect-src "for the browser link" is
>         cargo-culting. The link opens via IPC → ShellExecuteW. Only add domains
>         that JS code directly `fetch()`es to connect-src.

---

## Rule 50 — app.manifest Version Must Be Updated with Every Release
`src-tauri/app.manifest` contains an `assemblyIdentity version` in `M.m.p.b`
(4-part Windows version) format. This must be updated when the app version changes.

Current mapping: app version `X.Y.Z` → manifest `X.Y.Z.0`

The manifest is embedded into the exe at build time. A stale version causes
Windows to mis-identify the executable in compatibility and crash reporting contexts.

Files to update on every version bump (add to the "Version bump" row of the
Coupled Files table):
| Change | Files to update |
| Version bump | `package.json` + `Cargo.toml` + `tauri.conf.json` + `index.html` + **`app.manifest`** |

---

## Rule 51 — `window.open` Does Not Work in Tauri Release Builds
`window.open(url, '_blank')` does not open an external browser window in Tauri
WebView2 release builds. The call is silently ignored. Always use the
`open_in_browser` Tauri command for external URLs:

```javascript
await invoke('open_in_browser', { url });
```

Any `window.open` call in the codebase is dead code in the release build context.
Replace with `console.error(...)` to log the failure, or remove entirely.


---

## Rule 52 — Inner Items Cannot See the Enclosing Function's `use` Imports
In Rust, items defined inside a function (`struct`, `impl`, `fn`, `enum`, `const`)
are resolved in the *module* scope, not the *function* scope. They cannot see the
function's `use` statements, local variables, or generic parameters.

```rust
fn my_fn() {
    use windows::Win32::System::Com::CoUninitialize;  // function-scope use

    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            // ❌ ERROR: CoUninitialize not in scope here — this is module scope
            unsafe { CoUninitialize(); }
        }
    }
}
```

Fix: use the fully qualified path inside the inner item:
```rust
impl Drop for Guard {
    fn drop(&mut self) {
        // ✓ Full path — always works regardless of enclosing scope
        unsafe { windows::Win32::System::Com::CoUninitialize(); }
    }
}
```
And remove the local `use` statement so the compiler doesn't warn `unused_imports`.

> GOTCHA: The Rust compiler error message says "cannot find function in this scope"
>         rather than "use imports not visible here", which can be confusing.
>         If a name is found in a function `use` block but not inside a nested
>         `impl`, this rule is the cause.



## Rule 44 — Use the dev logger; never silently swallow

Every meaningful action and every error MUST be logged.

**Backend (Rust):**
```rust
log_info!("scheduler::create_task", "name={} folder={}", p.name, p.folder_path);
log_warn!("ipc::delete_task", "path={}", path);          // destructive ops at WARN
log_error!("scheduler::register", "RegisterTaskDefinition failed: {}", err);
```

**Frontend (JS):**
```js
dinfo('submit_task', 'update OK', { name, path });
dwarn('refreshAll', 'partial enumeration', { count, expected });
derror('openEditDialog', 'task not found', { path });
```

**Forbidden patterns:**
- `try { ... } catch (_) {}` — at minimum, `derror('site', 'reason', { err: String(e) })` first.
- `let _ = some_call();` in Rust without a reason — log the error or document why it's ignored.
- `console.log` only — DevTools is not the only consumer; the file logger is what users send when reporting bugs.

The log file is the canonical bug-report artefact. If a bug isn't in the log, the next agent has nothing to work with.

> GOTCHA: A `let _ =` discard is usually a bug-in-waiting. If the call really
>         can't fail meaningfully, write a comment saying so. Otherwise log it.


## Rule 45 — Never let form fields override identifier-keyed operations

When implementing an "update" or "delete" against an addressable resource, the
operation key (path, ID, source location) MUST come from the identifier the
operation was invoked on, NEVER from a form field that the user could have
changed since the operation was framed.

```rust
// ✗ WRONG: form's folder_path overrides the source
fn update_task(task_path: &str, p: &CreateTaskParams) -> Result<()> {
    let folder = p.folder_path;  // ← user could have changed this in the form
    folder.RegisterTaskDefinition(&p.name, ...)  // → silently moves / duplicates
}

// ✓ RIGHT: source identity wins; form value is data, not address
fn update_task(task_path: &str, p: &CreateTaskParams) -> Result<()> {
    let (fp, _) = split_path(task_path);  // ← from the identifier
    let folder  = self.service.GetFolder(&BSTR::from(fp))?;
    folder.RegisterTaskDefinition(&p.name, ...)
}
```

The 2.1.0 release fixed this exact bug in `update_task`. If a future feature
genuinely needs to "move task between folders" semantics, that should be an
explicit `move_task(src_path, dst_folder)` operation, not a side-effect of
saving an edit form.

> GOTCHA: Form fields drift. Detail panels populate from list rows. List rows
>         can come from aggregated queries that don't preserve folder context.
>         Identifiers don't drift.


## Rule 46 — Refactor on the second copy, not the third

If two functions contain the same multi-line block, extract the helper NOW.
Don't wait for a third copy "to be sure it's a pattern." By the third copy,
one of the three has already silently diverged and you have a bug.

The `apply_triggers_to_definition()` helper in `scheduler.rs` exists because
~120 lines of trigger-construction code lived in both `create_task` and
`update_task` for too long. The result was a year of "edit task does X
correctly but create doesn't" / "create task does Y correctly but edit
doesn't" bugs, each one fixed in only one of the two copies because the
agent forgot the other existed.

The threshold is one duplication. Extract.

> GOTCHA: If you find yourself copy-pasting from one fn to another and then
>         "just changing this one line," stop. That one line is the divergence
>         that will cause next month's bug. Extract the helper, then change
>         the one line by passing it in as a parameter.


## For the Next Agent

Before touching any code:
1. Run SESSION STARTUP protocol (Rule 22)
2. Read all GOTCHA: comments in src-tauri/src/ and src/ — they document hard-won fixes
3. Check README.md "For AI Agents" — Files That Must Stay In Sync table
4. Never assume a Tauri command is registered — audit main.rs vs app.js (Rule 31)
5. Videos CAN be watched via ffmpeg frame extraction — never refuse (Rule 32)
6. Always deliver changes as a zip with relative paths (Rule 34)
7. clean_project.ps1 must stay PS 5.1 compatible — no ternary ?:, no ??, no ??=
