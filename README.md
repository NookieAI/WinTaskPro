<div align="center">

<img src="src/icon.png" width="80" alt="WinTaskPro icon" />

# WinTaskPro

**A modern Windows Task Scheduler manager built with Tauri + Rust**

[![Release](https://img.shields.io/github/v/release/NookieAI/WinTaskPro?style=flat-square)](https://github.com/NookieAI/WinTaskPro/releases/latest)
[![License](https://img.shields.io/github/license/NookieAI/WinTaskPro?style=flat-square)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-blue?style=flat-square)](https://tauri.app)

</div>

---

## What is WinTaskPro?

WinTaskPro is a desktop application for Windows that gives you a clean, modern interface to manage every scheduled task on your machine — including system tasks that the built-in Task Scheduler UI hides.

Built with **Tauri v2** (Rust backend) and a plain HTML/CSS/JS frontend, it talks directly to the Windows Task Scheduler COM API — so it's fast, lightweight (~4 MB installer), and requires no external runtime or framework.

---

## Features

| Feature | Description |
|---|---|
| 📋 **Task Manager** | View, create, edit, clone, enable/disable, and delete any scheduled task |
| 🏠 **Dashboard** | At-a-glance health overview — running, ready, disabled, and failed tasks |
| 🔴 **Live Monitor** | Real-time view of currently running tasks, auto-refreshing every 3 seconds |
| 📚 **Script Library** | Pre-built templates for common tasks — one click to pre-fill the create dialog |
| 📝 **Audit Log** | Full history of every action taken in the app, filterable and exportable as CSV |
| 🏷 **Task Tags** | Client-side labels to organise and filter tasks (stored locally, no admin rights needed) |
| 📊 **CSV / JSON Export** | Export your full task list for documentation, auditing, or backups |
| ☀ **Light / Dark theme** | Toggle between themes; preference is saved between sessions |
| 🔔 **Desktop notifications** | Get notified when a task transitions to a failed state |
| ⌨️ **Keyboard shortcuts** | Full keyboard navigation — see the [Shortcuts](#keyboard-shortcuts) table below |
| 🔄 **Auto-update** | Checks GitHub Releases on startup and installs updates in one click |

---

## Requirements

- **Windows 10** version 21H1 or later, or **Windows 11**
- **Administrator rights** — required to read and modify Task Scheduler entries
- **WebView2 runtime** — already present on all modern Windows installs. If missing, download it from [microsoft.com/edge/webview2](https://developer.microsoft.com/microsoft-edge/webview2/)

---

## Installation

### Download the installer (recommended)

1. Go to [**Releases**](https://github.com/NookieAI/WinTaskPro/releases/latest)
2. Download `WinTaskPro.exe`
3. Launch WinTaskPro from the standalone executable.

> **Always run as Administrator.** Right-click the shortcut → *Run as administrator*. To make this permanent: right-click the shortcut → Properties → Advanced → tick *Run as administrator*.

### Portable build

Download the standalone `WinTaskPro.exe` from the release assets. No installation needed — just run it directly (still requires admin rights).

---

## Auto-Update Setup (for maintainers publishing releases)

See **[UPDATER.md](UPDATER.md)** for the complete guide. In brief:

1. **Generate a signing key pair** — `npx @tauri-apps/cli signer generate -w ~/.tauri/wintaskpro.key`
2. **Add the public key** to `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
3. **Add the private key** as a GitHub Actions secret named `TAURI_SIGNING_PRIVATE_KEY`
4. **Bump the version** in `Cargo.toml` and `tauri.conf.json` (both must match)
5. **Push a tag** — `git tag v1.1.0 && git push origin main --tags`

The workflow at `.github/workflows/release.yml` handles building, signing, creating the GitHub Release, and uploading `latest.json` automatically.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `N` | New Task (Task Manager page only) |
| `F5` or `R` | Refresh all tasks |
| `E` | Edit the selected task |
| `Del` | Delete the selected task |
| `/` or `Ctrl+F` | Focus the search box |
| `Esc` | Close modal / close detail panel |
| `?` | Show keyboard shortcut reference |
| `1` | Go to Dashboard |
| `2` | Go to Task Manager |
| `3` | Go to Live Monitor |
| `4` | Go to Script Library |
| `5` | Go to Settings |

---
