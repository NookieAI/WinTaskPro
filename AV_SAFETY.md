# WinTaskPro — AV / Firewall Safety Notes

WinTaskPro uses several Windows capabilities that security scanners may flag.
This document explains each one and why it is legitimate.

---

## Why the app needs Administrator rights

Windows Task Scheduler requires Administrator privileges to:
- Read tasks in system folders (`\Microsoft\Windows\*`)
- Create, edit, or delete scheduled tasks
- Start or stop running tasks

WinTaskPro requests elevation via a UAC prompt (`ShellExecuteW` with `runas`).
It **does not** bypass UAC or use token duplication to self-elevate silently.

---

## PowerShell usage (`get_event_log_history`)

**What it does:** Queries the `Microsoft-Windows-TaskScheduler/Operational`
event log to show real execution history (Event IDs 200 and 201) for each task.

**The command:**
```
powershell.exe -NoProfile -NonInteractive -Command <read-only EventLog query>
```

**Why PowerShell?** Directly querying the Windows Event Log from Rust requires
the complex `EvtQuery`/`EvtRender` WinAPI chain. PowerShell provides a clean
one-liner (`Get-WinEvent -FilterHashtable`) with built-in XML parsing.

**Is it dangerous?** No. The script:
- Only reads (never writes) event log data
- Runs as the same user as the app (elevated, same session)
- Does not access the network, download files, or modify system state
- Does not execute arbitrary code — the script is a literal string constant

**AV concern:** Some heuristic scanners flag apps that spawn `powershell.exe`.
This is a false positive. Signing the binary with an Authenticode certificate
(standard OV or EV) will suppress these warnings.

---

## Process termination (`kill_process`)

**What it does:** Calls `OpenProcess(PROCESS_TERMINATE)` + `TerminateProcess`
to end a process selected by the user in the Process Manager panel.

**Is it dangerous?** No. This is the standard Windows API for task manager
functionality. Every task manager (including Windows Task Manager itself) does
exactly this. The user must explicitly click "Kill" and confirm.

**AV concern:** Some behavioural shields flag `TerminateProcess` calls on
processes owned by third parties. This is expected behaviour for a process
manager. Signing the binary resolves this.

---

## `CheckNetIsolation.exe` (development builds only)

**What it does:** Adds a loopback exemption for the WebView2 AppContainer so
the dev server (`localhost:1420`) is reachable during development.

**Release builds?** This call is wrapped in `#[cfg(debug_assertions)]` and
is **completely absent from release binaries**. It only runs in `cargo build`
debug builds, never in the `.msi` or `.exe` you ship.

---

## Network access

WinTaskPro makes **one** outbound HTTPS request per session: a single GET to
`https://api.github.com/repos/NookieAI/WinTaskPro/releases/latest` to check
whether a newer tagged release is available. This request:
- Is made only on app startup (once per session)
- Can be disabled in Settings → Auto-update
- Reaches only the GitHub REST API — the `connect-src` CSP entry in
  `tauri.conf.json` is locked to `https://api.github.com`, no other host

If the user clicks **🔄 Update Now** in the update banner, a second HTTPS GET
fetches the `WinTaskPro.exe` asset from
`https://github.com/NookieAI/WinTaskPro/releases/download/<tag>/WinTaskPro.exe`.
That URL is locked to `github.com/.../releases/` by a prefix check in the
Rust `download_and_install_update` command — any other host is rejected
before the download starts.

The downloaded binary is then sanity-checked as a real Windows PE file
(MZ DOS header at offset 0, `PE\0\0` magic at the offset listed at 0x3C,
size between 1 MB and 200 MB) before any file replacement happens. **This
is a format check, not a cryptographic signature verification** — a real
Authenticode-signed updater is described in `UPDATER.md` as the next step.

The app makes **no other** network requests.

---

## File system access (`read_file` / `write_file`)

**What it does:** Two Tauri IPC commands allow the Script Editor and XML import/export
features to read and write files chosen by the user.

**Is it dangerous?** The commands are restricted by an allowlist enforced in `main.rs`:
- **Paths** must be absolute and contain no `..` traversal components.
- **Read** is limited to extensions: `.xml`, `.txt`, `.ps1`, `.bat`, `.cmd`, `.json`, `.log`, `.csv`
- **Write** is limited to: `.xml`, `.txt`, `.ps1`, `.bat`, `.cmd`, `.json`

Attempts to read outside these extensions (e.g. `.exe`, `.dll`, no extension) or write
to restricted paths are rejected with an "Access denied" error. These controls prevent
a hypothetical XSS-in-WebView from reading credential files or writing to arbitrary
system paths.

**AV concern:** Some heuristic scanners flag filesystem API usage from WebView-hosted
apps. These access patterns are intentional and restricted. Signing the binary resolves
false positives.

---

## URL opening (`open_in_browser`)

**What it does:** Opens a URL in the system default browser — used by the in-app update
banner to navigate to the GitHub release page.

**Is it dangerous?** The command validates that the URL starts with `https://` or `http://`
before calling `ShellExecuteW`. Non-URL strings (filesystem paths, protocol handlers other
than http/https) are rejected with an error. This prevents the command from being used as
an arbitrary process launcher.

**AV concern:** Some scanners flag `ShellExecuteW` calls with URL arguments. This is the
standard Windows idiom for opening a browser link and is expected behaviour.

---

## Summary for AV vendors / IT admins

| Capability | Reason | Release build only |
|---|---|---|
| Runs as Administrator | Task Scheduler COM API requires it | ✓ |
| COM automation (`ITaskService`) | Core Task Scheduler API | ✓ |
| `powershell.exe` spawn | Read-only event log query | ✓ |
| `OpenProcess` + `TerminateProcess` | User-initiated process kill | ✓ |
| `read_file` / `write_file` | Script editor & XML I/O (allowlisted paths/exts only) | ✓ |
| `ShellExecuteW` with URL | Open GitHub release page (https:// only) | ✓ |
| HTTPS to github.com | Update check (can be disabled) | ✓ |
| `CheckNetIsolation.exe` | Dev-only loopback exemption | Debug only |

**To suppress all AV/SmartScreen warnings:** sign the binary with an
Authenticode certificate. See `UPDATER.md` for details.
