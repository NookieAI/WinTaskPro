# WinTaskPro — Build & Auto-Update Audit

> **Scope.** Deep-dive review of: portable EXE build pipeline, dev↔release parity,
> auto-update mechanism, AV/SmartScreen surface, and supply-chain integrity. This
> document complements `HANDOVER.md`, `UPDATER.md`, and `AV_SAFETY.md` — read those
> first if you're new to the project.
>
> **Audit baseline:** snapshot dated 2026-04-27, version 2.1.0.
> **Verdict:** *Buildable, but not bulletproof.* Auto-update is **notification-only,
> not in-place**. Several latent issues will bite the next clean build.

---

## TL;DR

| # | Severity   | Area                  | Issue                                                   |
|---|------------|-----------------------|---------------------------------------------------------|
| 1 | **CRIT**   | Source                | Orphaned `src-tauri/src/log.rs` (renamed to `devlog.rs`) |
| 2 | **CRIT**   | CI                    | `includeUpdaterJson: true` will fail without signing key |
| 3 | **HIGH**   | Auto-update           | No `tauri-plugin-updater` wired up — banner-only        |
| 4 | **HIGH**   | Portable parity       | Portable `.exe` has no in-place self-replace path       |
| 5 | **HIGH**   | Bundle config         | Targets are `nsis + msi`; no portable target            |
| 6 | **MED**    | Cargo deps            | Three versions of `windows` crate linked simultaneously |
| 7 | **MED**    | WebView2              | Portable `.exe` has no runtime check for missing WV2    |
| 8 | **MED**    | Docs                  | README badge stuck at `1.7.0`; setting still says "key not configured" |
| 9 | **LOW**    | Build script          | `build_portable.bat` `if errorlevel 0` always pauses    |
|10 | **LOW**    | Build script          | `Start-Process cmd.exe /c npx …` — two-process detour   |
|11 | **LOW**    | Frontend              | `setTimeout(checkForUpdate, 3000)` not cancellable      |
|12 | **LOW**    | Frontend              | `semverGt()` ignores prerelease tags & 4-component vers |

The rest of this document expands each item with the **why**, the **fix**, and a
**verification step**.

---

## Part 1 — Critical correctness issues

### 1.1  Stale `src-tauri/src/log.rs` still in the tree

**What's there now.** `diff src-tauri/src/devlog.rs src-tauri/src/log.rs` shows
they're 99% identical — the only differences are the title comment and the
internal module path used by the `#[macro_export] macro_rules! log_*` macros.
`log.rs` references `$crate::log::log_line(...)`; `devlog.rs` references
`$crate::devlog::log_line(...)`.

**Why it's critical.** `main.rs` declares `mod devlog;` only — `log.rs` is dead
code today. But it's a tripwire:

- Both files contain `#[macro_export] macro_rules! log_info!` etc. The instant
  someone adds `mod log;` (e.g. a future agent who sees the canonical filename
  and assumes that's the one to use), the crate fails to compile with **"the
  name `log_info` is defined multiple times"**, and the failure is at the
  dependency root, not at the duplicate site — a confusing error.
- The original 2.1.0 hotfix note in `CHANGELOG.md` explicitly says the rename
  to `devlog` was forced by the *external* `log` crate (Tauri's transitive
  dep). Leaving a file called `log.rs` in the same directory invites the exact
  bug the rename was supposed to eliminate.
- Shippable source trees should not contain dead code. Auditors will (rightly)
  ask why it's there.

**Fix.** Delete `src-tauri/src/log.rs`. One commit, one line in CHANGELOG.

```powershell
git rm src-tauri/src/log.rs
git commit -m "chore: remove stale log.rs (orphaned by 2.1.0 hotfix rename)"
```

**Verification.**
```powershell
cd src-tauri
cargo clean
cargo check        # must pass; if it fails, log.rs WAS being picked up somewhere
```

---

### 1.2  `release.yml` will fail-fast on first tag — `includeUpdaterJson: true` without a signing key

**What's there now.** `.github/workflows/release.yml` line 89:

```yaml
includeUpdaterJson: true
```

…but no signing key has been generated, no `pubkey` field exists in
`tauri.conf.json`, and `tauri-plugin-updater` is not in `Cargo.toml`. The
`tauri-action` step reads `TAURI_SIGNING_PRIVATE_KEY` from secrets. If the
secret is absent or the plugin is not installed, the action's behavior is
**implementation-defined** — historically it errors out at build time with
`Error: signature failed: no signing key provided`.

**Why it's critical.** This is the *only* CI workflow in the repo. The first
`git push origin v2.1.1` will go red on the build runner, no artifacts will
be published, and the failure mode is opaque (signing happens deep inside
the action). Whoever cuts the next release will hit this and have no idea
why because the local build (`build_portable.ps1`) doesn't sign anything and
works fine.

**Fix — pick one of two:**

**Option A — Disable updater bits until plugin is wired up (do this NOW):**
```yaml
# .github/workflows/release.yml line 89
includeUpdaterJson: false
```
Remove the two `TAURI_SIGNING_*` env lines too — they're noise without the
plugin. CI will then publish only `.msi` and `.exe` installers, which is
exactly today's behavior of the manual builds.

**Option B — Wire up updater fully (multi-step; see §2.1 below).**

Whichever is chosen, the workflow must agree with the runtime: if
`latest.json` is published, the app must verify it; if it's not published,
the app must fall back to the GitHub-API check (current behavior).

**Verification.** Tag a non-public test release first:
```powershell
git tag v2.1.0-test
git push origin v2.1.0-test
# watch the GHA run; if green, untag and re-tag the real version
git push origin :refs/tags/v2.1.0-test
git tag -d v2.1.0-test
```

---

## Part 2 — Auto-update: what works, what doesn't, what to do

### 2.1  Current implementation is "notification + manual download"

**What today's flow actually does** (`src/app.js` lines 3015–3069):

1. 3 s after init, fetch `https://api.github.com/repos/NookieAI/WinTaskPro/releases/latest`
2. Parse `tag_name`, compare to local version via `semverGt()`
3. If newer, render a banner with a **Download** button
4. Download button calls `invoke('open_in_browser', { url })` → opens GitHub
   release page in the user's default browser
5. **User manually downloads, closes the running app, replaces the `.exe`,
   relaunches**

The `UPDATER.md` document describes a **different, aspirational system** based
on Tauri's plugin-updater. None of that system is wired up:

| `UPDATER.md` claim                         | Actual repo state                |
|---------------------------------------------|----------------------------------|
| "Tauri v2 updater plugin"                   | `tauri-plugin-updater` not in `Cargo.toml` |
| `pubkey` in `tauri.conf.json`               | Missing — no `plugins.updater` block at all |
| `npm run tauri signer generate`             | Never run — no key file exists in repo |
| `invoke('check_for_update')` from frontend  | No such command registered in `main.rs` |
| `latest.json` signature verification        | Cannot happen — no public key to verify against |

The CSP in `tauri.conf.json` allows `connect-src 'self' https://api.github.com`
which permits the current GitHub-API call, but the Tauri updater uses Rust HTTP
(not browser fetch), so CSP doesn't matter for the plugin path. That's a
non-issue either way.

### 2.2  Three viable paths forward — pick one and document it

These are mutually exclusive. **Don't half-implement two of them** — that's
how the current state happened.

#### Path A — Keep notification-only, drop the aspirational docs

**Best for:** small user base, public unsigned binary, low release cadence.

**Steps:**
1. Set `includeUpdaterJson: false` in `release.yml` (per §1.2).
2. Update `UPDATER.md` to reflect reality: it documents the GitHub-API
   notification flow, not a signed-update flow.
3. Update the Settings text in `app.js` line 2669 from "Auto-update signing
   key not yet configured — updates are disabled" to "Update notifications
   enabled. The app will alert you when a new release is published; you'll
   download manually from GitHub."
4. Update `README.md` line 218 — replace "click Install Update to apply it
   silently" with the honest description.

**Why this is honest:** the current code IS a working update notification
system. It's just not what the docs claim it is.

#### Path B — Wire up Tauri plugin-updater for installer builds

**Best for:** users who install via NSIS/MSI; auto-update for them, manual
for portable.

**Cargo.toml additions** (`src-tauri/Cargo.toml`):
```toml
[dependencies]
tauri-plugin-updater = "2"
```

**package.json additions:**
```json
"dependencies": {
  "@tauri-apps/api": "^2.0.0",
  "@tauri-apps/plugin-updater": "^2.0.0",
  "@tauri-apps/plugin-process": "^2.0.0"
}
```

**`tauri.conf.json` plugins block** (sibling of `bundle`):
```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/NookieAI/WinTaskPro/releases/latest/download/latest.json"
    ],
    "pubkey": "PASTE_FROM_signer_generate"
  }
}
```

**`main.rs` plugin registration** (in `tauri::Builder::default()` chain):
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

**Capabilities** (`src-tauri/capabilities/default.json`) — add:
```json
"updater:default",
"process:allow-restart"
```

**Frontend replacement** (`src/app.js` — replace `checkForUpdate()`):
```js
async function checkForUpdate() {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const { relaunch } = await import('@tauri-apps/plugin-process');
    const update = await check();
    if (!update?.available) return;
    showUpdateBanner(update.version, update.body || '', null, async () => {
      await update.downloadAndInstall();
      await relaunch();
    });
  } catch (err) {
    dwarn('checkForUpdate', 'plugin-updater failed', { err: String(err) });
  }
}
```
> Note: with `withGlobalTauri: true` and no bundler, dynamic ESM imports in
> the WebView require either a bundle step or replacing the import with the
> globals (`window.__TAURI__.updater.check`). Use the global path — keeps
> the no-bundler architecture intact.

**Generate the keypair** (one-time, do this in an **Administrator** terminal):
```powershell
npm run tauri signer generate -- -w $env:USERPROFILE\.tauri\wintaskpro.key -p
```
- Use `-p` to passphrase-protect the key (recommended).
- Add `TAURI_SIGNING_PRIVATE_KEY` (entire file contents) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as GitHub Actions secrets.
- Paste the public key (printed at the end of `signer generate`) into the
  `pubkey` field above.
- Set `includeUpdaterJson: true` in `release.yml`.

**Caveat — and this is the important one:** Tauri's plugin-updater on Windows
**only updates NSIS and MSI installs**. The replacement strategy is to
download the new installer, exit the app, and run the installer silently. It
does **not** work for the portable single-`.exe` build. Path B gives auto-
update only to users who installed via the `.msi` or NSIS `.exe`.

#### Path C — Custom self-replace for the portable EXE

**Best for:** if the portable `.exe` is the primary distribution channel.

The challenge is that on Windows you cannot overwrite a running `.exe` —
the OS holds an exclusive lock. The standard pattern (used by Notepad++
portable, IrfanView, etc.):

1. Download new exe to `%TEMP%\WinTaskPro_v{ver}_new.exe`.
2. Verify SHA-256 (and ideally Ed25519 sig) before continuing.
3. Spawn a detached helper (small `.bat` or PowerShell script) and exit.
4. Helper waits for the parent PID to terminate, then `Move` the new exe
   over the old, then relaunches.

**Sketch of the Rust command** to add to `main.rs` (rough — needs error
handling, path validation, signature check):

```rust
#[tauri::command]
#[cfg(windows)]
fn install_portable_update(new_exe_path: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let cur_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();
    let helper_ps1 = std::env::temp_dir().join("wintaskpro_swap.ps1");
    let cur_path = cur_exe.to_string_lossy().to_string();
    let script = format!(r#"
        Wait-Process -Id {pid} -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        Move-Item -Force -Path "{new_exe}" -Destination "{cur}"
        Start-Process -FilePath "{cur}"
    "#, pid = pid, new_exe = new_exe_path.replace('"', "`\""),
       cur = cur_path.replace('"', "`\""));
    std::fs::write(&helper_ps1, script).map_err(|e| e.to_string())?;
    // 0x00000008 = DETACHED_PROCESS
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-File"])
        .arg(&helper_ps1)
        .creation_flags(0x00000008)
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
```

**Risks:**
- Without code signing, AV will flag this as classic dropper behavior — a
  process writing a `.ps1` to temp and spawning detached PowerShell that
  modifies an `.exe`. This is *literally* the malware playbook. Authenticode
  signing the binary mitigates.
- The new exe must itself be Authenticode-signed or SmartScreen will block
  the relaunch.
- Without Ed25519 signature verification on the downloaded artifact,
  this is a **download-and-execute-arbitrary-code** vector if GitHub itself
  is compromised or if a MITM intercepts the HTTPS (rare but not impossible
  on corporate proxies). **Do not ship Path C without signature verification.**
  Reuse the same Ed25519 keypair from Path B; verify on the Rust side
  before invoking the helper.

**Recommendation.** Start with **Path A** (honest about what it does), and
graduate to **Path B** once you've shipped 1–2 releases and confirmed the
signing pipeline works in CI. **Path C** is only worth the AV/security
exposure if portable is your primary distribution channel and you're willing
to maintain the verification logic yourself.

---

## Part 3 — Portable build & dev↔release parity

### 3.1  "Same as dev mode" — what's actually different

The user's goal: portable `.exe` should behave **exactly like dev mode**.
Today, the differences are:

| Aspect                  | `tauri dev`                       | `tauri build --no-bundle` (release) |
|-------------------------|-----------------------------------|-------------------------------------|
| Frontend source         | HTTP from `localhost:1420`        | Embedded in binary (`generate_context!`) |
| `is_dev()`              | `true`                            | `false`                             |
| `windows_subsystem`     | (default — console attached)      | `"windows"` (no console)            |
| DevTools                | Available (dev capability `local: true`) | **Disabled**                  |
| `CheckNetIsolation` call| Runs (debug_assertions on)        | Skipped                             |
| Optimisations           | `opt-level = 0`                   | `opt-level = "s"`, LTO, strip       |
| Binary size             | ~80–120 MB                        | ~8–12 MB (after strip)              |

These differences are **all intentional and correct**. None of them changes
what the app *does*. If the user's worry is functional drift between dev and
release, the answer is: **there is none**. The frontend code is identical
(same `src/`), the IPC commands are identical, the COM bindings are
identical, the manifest is identical.

### 3.2  Capabilities — confirm dev privileges don't leak

`src-tauri/capabilities/dev.json` has `"local": true` which Tauri's
capability system honors by **excluding it from release builds automatically**.
DevTools toggle is therefore unreachable in the portable `.exe`. Verified.

### 3.3  CSP in release builds

The CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; …` is
enforced in BOTH dev and release. `'unsafe-inline'` for `script-src` is
required by the inline `onclick` handlers in `index.html` (per `HANDOVER.md`
line 240). Removing `'unsafe-inline'` would break every button. Don't.

### 3.4  Bundle targets vs portable build

`tauri.conf.json` has:
```json
"targets": ["nsis", "msi"]
```

This means `npm run tauri build` (without `--no-bundle`) produces installers,
**not** a portable exe. The portable exe path is `tauri build --no-bundle`,
which `build_portable.ps1` uses correctly.

The catch: when CI runs `tauri-action`, it produces NSIS+MSI artifacts
**only**. The portable `.exe` is **not in the GitHub release** — users who
prefer portable have to either build it themselves or copy the NSIS-installed
exe out of `Program Files`. The README claims a portable `.exe` is one of
the two distribution methods. **It's not actually being released.**

**Fix.** Add a portable-build step to `release.yml` and upload it as a
release asset:

```yaml
- name: Build portable exe
  run: npm run build:portable
- name: Upload portable artifact
  uses: actions/upload-release-asset@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    upload_url: ${{ steps.tauri.outputs.releaseUploadUrl }}
    asset_path: src-tauri/target/release/wintaskpro.exe
    asset_name: WinTaskPro_${{ github.ref_name }}_portable.exe
    asset_content_type: application/vnd.microsoft.portable-executable
```

This gives users a true single-file portable `.exe` from the same build that
produces the installers. Both installer and portable carry the same `.exe`
internally, so they're functionally identical (Path C custom updater notwithstanding).

### 3.5  WebView2 runtime — silent failure on old Windows

`tauri.conf.json` line 51:
```json
"webviewInstallMode": { "type": "downloadBootstrapper" }
```

This applies to the **NSIS/MSI installer**, which will download the WebView2
bootstrapper if missing. **The portable `.exe` does not run this check.** On
Windows 10 < 21H1 or any LTSC build that hasn't seen WV2, the portable will
launch, the window will appear blank or black, and the user gets no
diagnostic. Logs show nothing because the JS layer never loaded.

**Fix.** Add a startup probe in `main()`:

```rust
#[cfg(windows)]
fn check_webview2() -> Result<(), String> {
    use windows::Win32::System::Registry::*;
    use windows::core::PCWSTR;
    // Check both HKLM and HKCU for WebView2 client install
    const KEYS: &[&str] = &[
        "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    for k in KEYS {
        let wide: Vec<u16> = k.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let mut h = HKEY::default();
            let r = RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(wide.as_ptr()),
                                  0, KEY_READ, &mut h);
            if r.is_ok() { let _ = RegCloseKey(h); return Ok(()); }
        }
    }
    Err("WebView2 Runtime not detected".into())
}

// In main(), before tauri::Builder::default():
#[cfg(windows)]
if let Err(_) = check_webview2() {
    use windows::Win32::UI::WindowsAndMessaging::*;
    use windows::core::PCWSTR;
    let title: Vec<u16> = "WinTaskPro".encode_utf16().chain([0]).collect();
    let body:  Vec<u16> = "WebView2 Runtime is required.\n\n\
        Download from:\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n\
        After installing, relaunch WinTaskPro.".encode_utf16().chain([0]).collect();
    unsafe {
        MessageBoxW(None, PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()),
                    MB_OK | MB_ICONERROR);
    }
    std::process::exit(1);
}
```

**Verification.** On a fresh Windows 10 1809 VM (no WV2), launch the portable.
A clear MessageBox should appear. Without this, the symptom is "app launches,
window is blank, user has no idea what to do."

---

## Part 4 — Cargo dependency hygiene

### 4.1  Three versions of `windows` crate linked together

The `[deferred]` comment in `Cargo.toml` documents the issue:

> sysinfo 0.31 pulls in windows 0.57, creating a 3-version conflict alongside
> our 0.58 and tauri's 0.61.

`cargo tree -p wintaskpro --duplicates` would confirm. Effects:

- All three versions are compiled and statically linked. Each duplicates
  Win32 FFI bindings — the `.exe` carries roughly 3× the cold Win32 import
  weight.
- LTO partially deduplicates at link time, but identical functions are still
  monomorphized per-version.
- Cargo build cache is bigger, builds take longer.

**Fix.** Bump `sysinfo` to `0.32` (uses `windows-sys`, which is far smaller
and unifies with Tauri's `windows` 0.61):

```toml
sysinfo = { version = "0.32", default-features = false, features = ["system"] }
```

The `sysinfo` 0.32 process API renamed `refresh_processes()` to take a
`ProcessesToUpdate` enum:

```rust
// Before (0.31):
sys.refresh_processes();
// After (0.32):
sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
```

Then bump the explicit `windows` dep from `0.58` to `0.61` to match Tauri.
A few imports may move (e.g. some symbols got reorganized between 0.58 and
0.61) but the surface area used in this project (`Win32_System_TaskScheduler`,
`Win32_UI_Shell`, etc.) is stable.

**Why this hasn't been done yet.** The Cargo.toml comment notes it's
"deferred — needs cargo build verification on Windows". Fair — but the
verification is a single `cargo build --release` on a Windows box, and
Path B above will need this resolved anyway because plugin-updater's
HTTP layer pulls in newer windows crate features.

**Verification:**
```powershell
cd src-tauri
cargo tree -p wintaskpro --duplicates
# After fix, no `windows` lines should appear; only one `windows-sys` line.
```

---

## Part 5 — Build script polish

### 5.1  `build_portable.bat` always pauses on exit

Lines 64–65:
```bat
choice /n /t 5 /d n /m "  (Window closes in 5 seconds...)" >nul 2>&1
if errorlevel 0 pause
```

`if errorlevel 0` is true if errorlevel is **≥ 0**, which is always true. The
`pause` runs unconditionally, including in CI. Probably the author meant
"if interactive" but the heuristic doesn't work.

**Fix.** Either drop the pause entirely (let the wrapper window stay open
naturally on double-click, since CMD doesn't auto-close on script end), or
detect interactive mode properly:

```bat
:: Pause only if launched without a console parent (i.e. double-click)
echo %CMDCMDLINE% | find /i "/c " >nul && pause
```

Honestly the `choice` line should just go — the script's value is the build,
not the exit handling.

### 5.2  `build_portable.ps1` invokes `npx tauri` via two extra processes

Line 324–328:
```powershell
$BuildCmd  = "npx " + ($BuildArgs -join " ")
$BuildProc = Start-Process -FilePath "cmd.exe" `
              -ArgumentList "/c $BuildCmd 2>&1" `
              -WorkingDirectory $ProjectRoot `
              -NoNewWindow -PassThru -Wait
```

This is `powershell → cmd.exe → npx.cmd → node.exe → tauri-cli`. Five
processes. The `cmd.exe /c` wrapper is unnecessary; PowerShell can run
`npx.cmd` directly:

```powershell
$BuildArgs = if ($Debug) { @("tauri","build","--no-bundle","--debug") }
             else        { @("tauri","build","--no-bundle") }
& npx.cmd @BuildArgs 2>&1 | Tee-Object -FilePath build.log
$ExitCode = $LASTEXITCODE
```

Cleaner, faster startup, and the build log is captured to a file for later
inspection (currently it's lost when the console scrolls).

### 5.3  Build script has no signing step

`build_portable.ps1` currently produces an unsigned `.exe`. SmartScreen will
block it on first run. If the project ever acquires an Authenticode
certificate, signing should be one flag away:

```powershell
param(
    [switch] $Clean,
    [switch] $SkipNpm,
    [switch] $Debug,
    [switch] $Sign,         # NEW
    [switch] $Help
)
# ... after Step 6 (locating exe) ...
if ($Sign) {
    $thumbprint = $env:WINTASKPRO_SIGN_THUMBPRINT
    if (-not $thumbprint) {
        Write-Bad "WINTASKPRO_SIGN_THUMBPRINT env var not set; cannot sign."
        exit 1
    }
    $signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue)?.Source
    if (-not $signtool) { Write-Bad "signtool.exe not on PATH"; exit 1 }
    & $signtool sign /sha1 $thumbprint /fd sha256 `
        /tr http://timestamp.digicert.com /td sha256 `
        $BuiltExe
    if ($LASTEXITCODE -ne 0) { Write-Bad "signtool failed"; exit 1 }
    Write-Ok "Authenticode signed with thumbprint $thumbprint"
}
```

### 5.4  No reproducibility / SHA verification on inputs

The script SHA-256s the **output** but not the inputs. Two consecutive runs
on the same source can produce different exes (timestamps, build IDs). For
release reproducibility (Sigstore/SLSA-style), capture both:

```powershell
# Before build: snapshot the source tree hash
$SourceHash = (Get-ChildItem -Recurse -File src, src-tauri | `
    Where-Object { $_.FullName -notmatch 'target|node_modules' } | `
    Get-FileHash -Algorithm SHA256 | Sort-Object Path | `
    ForEach-Object { $_.Hash + " " + $_.Path }) -join "`n" | `
    Out-String
Add-Content -Path "$DistDir\$VersionedName.manifest" -Value @"
=== WinTaskPro v$AppVersion build manifest ===
Built:    $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
Output:   $VersionedName ($ExeSize)
SHA-256:  $ExeHash
Source hash:
$SourceHash
"@
```

Optional but cheap, and useful for "is this the exe I think it is?"
forensic questions later.

---

## Part 6 — Documentation drift

### 6.1  README.md version badge

Line 9:
```markdown
[![Version](https://img.shields.io/badge/version-1.7.0-blue?style=flat-square)]
```
Actual version everywhere else: `2.1.0`. Bump to `2.1.0`.

### 6.2  Settings panel "auto-update disabled" message

`src/app.js` line 2669 — the Settings → About panel still says:

> Auto-update signing key not yet configured — updates are disabled. See `UPDATER.md` for setup instructions.

This contradicts the actual behavior (`checkForUpdate()` does run, every
launch). Fix per chosen Path A/B/C.

### 6.3  README "Auto-updates" section

Line 218:
> The installer version checks for updates at startup. When one is available, a banner appears — click **Install Update** to apply it silently.

There is no "Install Update" button — the button label is "⬇ Download" and
it opens a browser. Either fix the README or fix the button (the button
label is honest if the destination is a download page).

### 6.4  Re-link the version files

`README.md` already lists the four files that must be bumped on every
release (line 274). Add a fifth — `src-tauri/app.manifest` `assemblyIdentity`
version field — which is also listed in the gotchas (line 296) but not in
the table at line 274. The two should agree.

---

## Part 7 — Concrete remediation checklist

Ordered by ROI. Items 1–4 should ship before the next release tag.

```
[ ] 1. Delete src-tauri/src/log.rs                                 (5 min)
[ ] 2. Set release.yml: includeUpdaterJson: false                  (1 min)
[ ] 3. README.md badge: 1.7.0 → 2.1.0                              (1 min)
[ ] 4. Pick auto-update path (A/B/C) and document the choice       (varies)
[ ] 5. Add WebView2 startup probe in main.rs                       (30 min)
[ ] 6. Add portable.exe upload step to release.yml                 (15 min)
[ ] 7. Bump sysinfo 0.31 → 0.32, windows 0.58 → 0.61               (1–2 hr; needs Win box)
[ ] 8. Fix build_portable.bat errorlevel-0 pause bug               (5 min)
[ ] 9. Refactor build_portable.ps1 to skip cmd.exe wrapper         (15 min)
[ ] 10. Add -Sign flag to build_portable.ps1                       (20 min)
[ ] 11. Settings panel update text — match real behavior           (5 min)
[ ] 12. README "Auto-updates" section — match real behavior        (5 min)
```

---

## Part 8 — What "bulletproof" actually buys you

You said *"flawless build, bulletproof app exe."* Here's the realistic ladder
of how bulletproof you can make this without changing what the product is:

| Tier   | What you ship                          | Cost                | What it buys                  |
|--------|----------------------------------------|---------------------|-------------------------------|
| **0**  | Today's state                          | $0                  | Functional, but trips on the issues above |
| **1**  | Fix the 12 issues in this audit        | ~half a day         | Reliable builds, honest docs, no latent CI break |
| **2**  | Tier 1 + path B (signed updater)       | + 2–4 hrs           | Auto-update for installer users; CI green on tag |
| **3**  | Tier 2 + Authenticode OV cert (~$300/yr) | + 1 day setup     | Builds reputation; SmartScreen warning fades after ~weeks of installs |
| **4**  | Tier 3 + EV cert (~$500/yr)            | + 1 day setup       | SmartScreen warning gone immediately on first run |
| **5**  | Tier 4 + path C (portable self-update) | + 1–2 days          | True one-file portable that auto-updates |

Tiers 0→1 are pure engineering and should happen regardless of distribution
decisions. Tier 2 is where "auto-update" stops being a banner and starts
being real. Tier 4 is where SmartScreen stops being a thing your users have
to click past.

The tier you actually need depends on user count and update cadence. If
WinTaskPro stays small and you ship a release every few months, **Tier 1** is
genuinely fine — the GitHub-API banner is functional, honest, and costs
nothing. If you're shipping weekly to thousands of users, **Tier 4** pays for
itself in support time saved.

---

*Audit prepared 2026-04-27. If new files are added that change the build
surface (new plugins, new Cargo deps, new bundle targets), reopen this
checklist and refresh.*
