Support: https://ko-fi.com/nookie_65120 :heart:
<div align="center">

<img src="src/icon.png" width="80" alt="WinTaskPro" />

# WinTaskPro

**The Windows Task Scheduler you always wanted — one `.exe`, no install.**

[![Version](https://img.shields.io/badge/version-1.15.2-blue?style=flat-square)](https://github.com/NookieAI/WinTaskPro/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11%20x64-0078d4?style=flat-square&logo=windows)](https://github.com/NookieAI/WinTaskPro/releases/latest)
[![Download](https://img.shields.io/badge/download-latest%20release-2ea44f?style=flat-square&logo=github)](https://github.com/NookieAI/WinTaskPro/releases/latest)
[![License](https://img.shields.io/github/license/NookieAI/WinTaskPro?style=flat-square)](LICENSE)

</div>

---

## What is it?

WinTaskPro is a modern replacement for the clunky built-in Windows Task Scheduler. It shows **every** scheduled task on your PC — including the hidden system tasks Microsoft's own tool buries — in a clean interface where you can create, edit, run, and inspect tasks, see when they last ran and whether they succeeded, and watch everything that's running live.

Just viewing tasks changes nothing. Nothing on your system is touched unless you explicitly click a button.

---

## ⬇️ Download & run

Everything ships from the **[Releases page](https://github.com/NookieAI/WinTaskPro/releases/latest)**. Grab one of:

| File | Use this if you want… |
|---|---|
| **`WinTaskPro.exe`** | **Just to run it.** Single portable file — desktop, USB stick, anywhere. No install. This is also the file the in-app updater downloads. |
| **`WinTaskPro_1.15.2_x64-setup.exe`** | A Start-Menu shortcut. Standard installer, same program. |
| **`WinTaskPro_1.15.2_x64_en-US.msi`** | Silent / managed deployment (IT admins). |

All three are the identical application. **Most people want `WinTaskPro.exe`** — download it and double-click.

> **One-line download** (portable, always newest):
> ```
> https://github.com/NookieAI/WinTaskPro/releases/latest/download/WinTaskPro.exe
> ```

---

## ▶️ First time you run it

Two prompts on first launch — both are normal for any Windows app not sold through the Microsoft Store.

**1. SmartScreen — "Windows protected your PC"**

WinTaskPro is not code-signed, so Windows shows a blue warning the first time. To continue:

1. Click **More info**
2. Click **Run anyway**

This happens once; Windows remembers the file afterward.

**2. Administrator (UAC) — "Do you want to allow this app to make changes?"**

Click **Yes.** Task Scheduler is a protected Windows component — reading or changing tasks *requires* Administrator rights, exactly like the built-in tool. Without it, WinTaskPro can't see your tasks.

> **Skip the UAC prompt every time:** right-click `WinTaskPro.exe` → **Properties** → **Compatibility** → tick **Run this program as an administrator** → **OK**.

---

## Requirements

| | |
|---|---|
| **OS** | Windows 10 (version 2004 / build 19041 or later) or Windows 11 — 64-bit |
| **Rights** | Administrator |
| **WebView2** | Already present on all modern Windows. If missing, Windows installs it automatically on first run. |
| **Disk** | ~15 MB. No background services, no runtime to install. |

---

## 🔄 Updating

WinTaskPro checks GitHub for a newer release on each launch (a single request to the GitHub releases API — no telemetry, no tracking).

- When an update exists, a banner appears. Click **🔄 Update Now** — it downloads the new `WinTaskPro.exe`, replaces the running file in place, and relaunches. Takes ~10–30 seconds.
- If that fails (offline, GitHub rate-limit, antivirus interference), the banner's **↗ View on GitHub** button opens the Releases page so you can download manually — just replace your old `WinTaskPro.exe` with the new one.

---

## What you can do

### Dashboard
At-a-glance health: how many tasks are running, ready, disabled, and failed right now. Click any stat to jump to that filtered list. Includes a **While You Were Away** 24-hour digest and a **Tamper Watch** card that flags when a task you've marked **Watched** has had its definition changed.

### Task Manager
The full list — every task, every folder.

- **Click a row** for the detail panel · **Right-click** for quick actions
- **Search** by name, trigger, or action · **🌐 All Folders** searches everything at once
- **Status filter** and **stat pills** narrow instantly
- **🕒 Timeline** — every run scheduled in the next 24 hours on a density chart
- **🌙 Activity** — last-24-hour digest of starts, completions, failures
- **Ctrl+K** — command palette to jump to any task, page, or action

### Creating & editing tasks
**➕ New Task**, or select a task and **✏️ Edit**. A four-tab form: **General** (name, folder, account), **Trigger** (daily / weekly / at startup / at login / on a schedule / on idle / interval), **Action** (program or script), **Advanced** (time limits, repetition, conditions, priority).

**Edits are safe by design.** WinTaskPro never silently mangles a task:

- Editing a task **preserves everything the form doesn't show** (e.g. its Author and the account it runs as) instead of blanking it.
- Tasks with **multiple triggers or multiple actions** (common for Windows' own tasks) can't be flattened by accident — WinTaskPro detects them and offers a **lossless raw-XML editor** so nothing is lost. You can also open that editor any time via right-click → **＜/＞ Edit XML**.
- A task is **never renamed in place** by an edit (that would create a duplicate). To rename, clone or export/import under the new name.

### Detail panel
Click any task to see its path, status, description, run account, triggers, actions, and **last/next run times in your local timezone**. The **Last Result** shows a **?** badge that decodes error codes into plain English. **📋 Load Full History** pulls real execution records from the Windows Event Log. Add your own **Tags** and **Notes** (stored on your PC only).

Panel buttons: **▶ Run**, **▶ Run Now** (under its real account), **🧪 Test Run** (as you, output captured), **⏹ Stop**, **⏸/▶** enable/disable, **✏️ Edit**, **📋 Clone**, **📝 Note**, **🛡 Watch**, **⚡ PS** (copy a PowerShell script that recreates it), **＜/＞ XML** (export / edit raw XML), **🗑 Delete** (with **Undo** + Recycle Bin recovery).

### Live Monitor
Real-time view of every task currently running. Refreshes every 3 seconds.

### Process Manager
Live list of every process with CPU time and memory. Kill any process directly.

### Recycle Bin
Deleted by mistake? Every deletion is captured first. An **Undo** appears immediately, and the Recycle Bin keeps your last 50 deletions for one-click restore. (System tasks that can't be exported aren't captured.)

### Script Library
Ten ready-made templates — log cleanup, disk checks, backups. Click one to pre-fill the create form.

### Audit Log
A searchable record of everything you've done in WinTaskPro, exportable as CSV.

### Settings
Auto-refresh interval · desktop notifications on task failure · show/hide Microsoft system tasks · accent colour · export task list as CSV/JSON · full **Backup / Restore** of every task to a single file.

---

## Folders & keyboard shortcuts

The number beside each sidebar folder is its task count. Click a folder to filter, **All Tasks** to show everything, right-click to delete (with confirmation), **＋** to create one.

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `Ctrl+K` | Command palette | | `/` or `Ctrl+F` | Focus search |
| `N` | New task | | `Esc` | Close panel / modal |
| `F5` or `R` | Refresh | | `?` | Show all shortcuts |
| `E` | Edit selected | | `1`–`6` | Dashboard · Tasks · Live Monitor · Scripts · Settings · Recycle Bin |
| `Del` | Delete selected | | | |

---

## FAQ

**Does opening it change anything on my system?**
No. Viewing is entirely read-only. Nothing changes unless you click a button.

**Why does it need Administrator?**
Task Scheduler is a protected component; reading and writing tasks requires elevation — the same reason the built-in tool does.

**SmartScreen warned me — is it safe?**
SmartScreen warns about every new unsigned `.exe` regardless of what it does. Click **More info → Run anyway**. If you'd rather verify first, every release lists its file hash on the Releases page.

**It says "Not running as Administrator."**
Close it, right-click `WinTaskPro.exe` → **Run as administrator**. To make it permanent: right-click → Properties → Compatibility → tick **Run this program as an administrator**.

**Will editing a Windows system task break it?**
No. Edits preserve the parts the form doesn't show, and any task with multiple triggers or actions is steered into the lossless XML editor instead of being flattened. If a save can't be applied cleanly, it fails with a message and leaves the original task untouched — it never half-writes a task.

**Task history says "Event Log unavailable."**
The Windows Task Scheduler operational log is off by default on some machines. Enable it: press `Win+R`, run `eventvwr.msc`, go to **Applications and Services Logs → Microsoft → Windows → TaskScheduler → Operational**, right-click **Operational → Enable Log**. WinTaskPro can then show real run history.

**My antivirus flagged it.**
A tool that reads and writes scheduled tasks and runs elevated can trip heuristic AV rules. The file you download is exactly what's published on the Releases page — verify it by its listed hash, or add an exclusion for `WinTaskPro.exe`.

**Where are my logs / settings?**
App logs: `%LOCALAPPDATA%\WinTaskPro\logs\`. Your tags, notes, and audit log live in the app's local storage on this PC only — nothing leaves your machine.

---

## License

MIT — free to use, modify, and distribute. See [LICENSE](LICENSE).

<div align="center"><sub>WinTaskPro · © 2026 NookieAI · <a href="https://github.com/NookieAI/WinTaskPro/releases">Releases</a></sub></div>

