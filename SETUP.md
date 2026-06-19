# WinTaskPro — Development Setup

## ⚠️ CRITICAL: Always run your terminal as Administrator

WinTaskPro accesses Windows Task Scheduler, which requires administrator rights.
The dev HTTP server and the Tauri app must run at the **same privilege level**
so WebView2 can reach the dev server on localhost.

**If you run from a non-admin terminal, you will get `ERR_CONNECTION_REFUSED`
every single time — the WebView2 AppContainer blocks loopback connections to
non-elevated processes. No amount of code changes fixes this.**

### ✅ Correct dev workflow

1. Right-click Windows Terminal / PowerShell → **Run as Administrator**
2. `cd C:\TEMP\WinTaskPro`
3. `npm run tauri dev`

That's the complete workflow. The "Not Admin" banner that appears in the app
is expected when running non-elevated, but for **development** you must start
the terminal itself as Administrator so the dev server also runs elevated.

---

## Prerequisites

```powershell
# 1. Rust
winget install Rustlang.Rustup
rustup update stable
rustup target add x86_64-pc-windows-msvc

# 2. Node.js (LTS)
winget install OpenJS.NodeJS.LTS

# 3. Tauri CLI (installed locally via npm — no global install needed)
cd C:\TEMP\WinTaskPro
npm install

# 4. WebView2 Runtime
# Already present on Windows 10 21H1+ and Windows 11.
# If missing: https://developer.microsoft.com/en-us/microsoft-edge/webview2/
```

## Dev commands

```powershell
# Start dev server (MUST be in an admin terminal)
npm run tauri dev

# Production build
npm run tauri build

# Portable build (no installer)
npm run tauri build -- --no-bundle

# Project maintenance (health check, backup, clean)
powershell -ExecutionPolicy Bypass -File clean_project.ps1
```

## Hot reload

The dev server (`devserver.js`) serves static files. To pick up changes to
`src/app.js` or `src/style.css`, press **Ctrl+R** inside the app window —
changes appear immediately without restarting the dev server.

Rust (`src-tauri/src/`) changes trigger a full recompile automatically via
Tauri's file watcher (~8–10 seconds).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ERR_CONNECTION_REFUSED` on localhost:1420 | **Open a new terminal as Administrator** |
| `Missing script: "tauri"` | `npm install` |
| `No port number in the URL` | Don't set `devUrl` to a custom scheme (e.g. `wtpdev://`) — must be HTTP with a port |
| App exits immediately, no error | Check `src-tauri/src/main.rs` compiles — run `cargo check --manifest-path src-tauri/Cargo.toml` |
| `sysinfo` compile error after dep bump | Cargo.toml pins `sysinfo = "0.32"`. After bumping, run `cd src-tauri && cargo build` from a clean state — 0.x crates aren't semver-stable and minor bumps can break source-level API. |
