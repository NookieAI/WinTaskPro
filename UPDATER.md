# WinTaskPro — Auto-Update Mechanism

This document describes how WinTaskPro auto-updates from
`https://github.com/NookieAI/WinTaskPro/releases`, the contract between the
GitHub Actions workflow and the in-app updater, and how to upgrade to a
cryptographically-signed flow when the project is ready.

---

## How it works (1.8.0+)

**Portable in-place self-replace.** The same pattern used by sister apps
(Kura, PS5 Vault).

```
                    ┌───────────────────────────────────────────────┐
                    │ github.com/NookieAI/WinTaskPro/releases       │
                    │   tag: v1.9.0                                 │
                    │   asset: WinTaskPro.exe   ← canonical name    │
                    └─────────────────────┬─────────────────────────┘
                                          │
              ┌───────────────────────────┴─────────────────────────────┐
              │                                                          │
              ▼  on launch                                                ▼  Update Now click
   GET api.github.com/repos/.../releases/latest          GET .../releases/download/v1.9.0/WinTaskPro.exe
              │                                                          │
              ▼                                                          ▼
   semverGt(latest, current)?                              %TEMP%\WinTaskPro_v1.9.0_new.exe
              │                                                          │
              │ yes                                                      ▼
              ▼                                                  PE header verify
   showUpdateBanner()                                                    │
              │                                                          ▼
              │                                            spawn detached PS swap helper
              │                                                          │
              ▼                                                          ▼
              click──────────────────────────────────────────► installUpdate()
                                                                         │
                                                                         ▼
                                                              app.exit(0)  ── helper waits ──►
                                                                                              │
                                                                                              ▼
                                                                                      Move-Item temp → live
                                                                                              │
                                                                                              ▼
                                                                                      Start-Process live exe
```

The contract is two filenames at one URL:

| Filename | URL pattern | Purpose |
|---|---|---|
| `WinTaskPro.exe` | `releases/latest/download/WinTaskPro.exe` | Always-latest portable; what the auto-updater downloads |
| `WinTaskPro.exe` | `releases/download/v{X.Y.Z}/WinTaskPro.exe` | Version-pinned; what `installUpdate()` actually requests |

The asset name MUST be exactly `WinTaskPro.exe` for both URLs to resolve. The
release workflow (`.github/workflows/release.yml`) renames the build output
to that name before uploading.

---

## Implementation

### Frontend (`src/app.js`)

`checkForUpdate()` polls `api.github.com/repos/NookieAI/WinTaskPro/releases/latest`
on each launch (3 s after init). When `tag_name` is greater than the running
version per `semverGt()`, it extracts the `WinTaskPro.exe` asset URL from
`data.assets[]` and renders a banner with three buttons:

- **🔄 Update Now** — calls `installUpdate(version, assetUrl)` (in-place flow)
- **↗ View on GitHub** — opens the release page in the user's browser (manual fallback)
- **✕** — dismiss

`installUpdate()` swaps the banner for a non-dismissable progress modal and
calls the `download_and_install_update` IPC. A successful update never
returns from the Promise — the Rust side calls `process::exit(0)` after
spawning the swap helper.

### Backend (`src-tauri/src/main.rs`)

`download_and_install_update(url, expected_version)`:

1. **URL allowlist.** Rejects anything that isn't `https://github.com/...`
   with `/releases/` in the path. Defence-in-depth against XSS-via-WebView
   passing a hostile URL to the IPC.

2. **Download via PowerShell.** `Invoke-WebRequest -Uri ... -OutFile ...
   -UseBasicParsing -TimeoutSec 120` writes to
   `%TEMP%\WinTaskPro_v{ver}_new.exe`. `$ProgressPreference = 'SilentlyContinue'`
   makes this 50× faster than the default (the progress-bar redraw is the
   slow part, not the network).

3. **PE verification.** `verify_pe_file()` checks size > 1 MB, size < 200 MB,
   `MZ` DOS header, and `PE\0\0` signature at the offset stored at 0x3C.
   This rejects 404 HTML pages, partial downloads, and random garbage. It
   does NOT verify a code-signing or Ed25519 signature — see "Upgrade path"
   below.

4. **Write swap helper.** A PowerShell script is written to
   `%TEMP%\wintaskpro_swap.ps1`. The script:
   - Waits for our PID to exit (with a 30 s cap)
   - Sleeps 800 ms (Windows file-lock cleanup tail)
   - `Move-Item -Force` new exe over current location, retrying up to 10×
     at 500 ms intervals on failure
   - Falls back to `Copy-Item` + `Remove-Item` if `Move-Item` fails
     (handles cross-volume swaps, e.g. `%TEMP%` on C: but the exe on D:)
   - `Start-Process` the (now-replaced) live exe path
   - Removes itself from `%TEMP%`
   - On any failure, writes a marker line to
     `%LOCALAPPDATA%\WinTaskPro\update_failed.txt` and tries to relaunch the
     OLD exe so the user has a working app.

5. **Spawn helper detached.** Uses `creation_flags(DETACHED_PROCESS |
   CREATE_NO_WINDOW)` so the helper survives our exit and doesn't pop a
   console window.

6. **`process::exit(0)`.** A 150 ms `sleep` first gives the helper time to
   detach and the log line to flush.

### Build (`build_portable.ps1` and `release.yml`)

Both produce `WinTaskPro.exe` as the canonical artefact. The local build also
emits `WinTaskPro_v{X.Y.Z}_portable.exe` for archiving. The CI workflow
uploads only `WinTaskPro.exe` because the release tag already encodes the
version.

---

## Failure modes and what each looks like

| Failure | User experience | Recovery |
|---|---|---|
| GitHub API unreachable | No banner. Log line `checkForUpdate fetch failed`. | Try again next launch |
| New release exists but no `WinTaskPro.exe` asset | Banner with only "View on GitHub" button (no Update Now) | Maintainer: re-upload asset; user: download manually |
| URL allowlist rejected the asset URL | Modal shows error, banner re-appears with "View on GitHub" | Manual download |
| Download fails (network, 404, timeout) | Modal shows error toast, banner re-appears | Click Update Now again, or use View on GitHub |
| Downloaded file fails PE verify (404 HTML, partial download, corrupt asset) | Modal shows "Downloaded file is not a valid Windows binary" | The bad download is auto-deleted from %TEMP%; retry |
| Swap helper fails to spawn | Modal shows error | Marker file in `%LOCALAPPDATA%\WinTaskPro\update_failed.txt` records why |
| Swap helper hangs waiting for our PID | App relaunched but no swap | After 30 s timeout the helper gives up, the user is now running the OLD version with a downloaded `_new.exe` orphaned in %TEMP% |
| New exe crashes on launch | App is gone, user is confused | Manual: download from GitHub release page directly. The marker file is empty in this case (helper succeeded). |

The marker file path is announced in the Settings → Developer Logs section
so users can include it in bug reports.

---

## AV / SmartScreen considerations

This pattern intentionally has an AV-detectable shape: an `.exe` writes a
PowerShell script to `%TEMP%`, spawns it detached, and exits. It then gets
overwritten by a different `.exe` from a different location. From a
behavioural-detection standpoint, this is the same shape as a dropper.

**Mitigations baked in:**

- The PowerShell helper is plaintext and short; nothing obfuscated.
- The download URL is logged at INFO before fetch, the SHA-256 of the
  downloaded file is logged at INFO after fetch.
- The script does NOT touch any directory outside `%TEMP%` and the
  current-exe location.
- Start-Process is called with no quoted-cmd-injection vector (the path is
  passed via `$args[2]`, never concatenated into a string).

**The real fix is code signing.** Once an Authenticode-signed binary makes
it through 100+ user installs, SmartScreen's reputation system kicks in and
the warning fades. EV certificates skip the reputation phase entirely.

To enable signing:
1. Acquire an Authenticode (OV or EV) cert.
2. Set the `WINTASKPRO_SIGN_THUMBPRINT` env var to the cert's SHA-1
   thumbprint.
3. Run `.\build_portable.ps1 -Sign`. The output `WinTaskPro.exe` and the
   versioned archive copy are both signed (SHA-256 hash is recomputed
   after signing).
4. For CI, add `WINDOWS_CERTIFICATE_THUMBPRINT` to GitHub Actions secrets
   and uncomment the env line in `release.yml`.

---

## Upgrade path: cryptographic update verification

What's missing in the current flow: we trust GitHub HTTPS as the only thing
between us and the binary. A compromised GitHub account or a sophisticated
on-path attack could inject a malicious `WinTaskPro.exe`. The PE header
check passes for any valid exe, including malware.

To upgrade to Ed25519-signed updates:

### Step 1 — Generate a keypair

```powershell
npm run tauri signer generate -- -w $env:USERPROFILE\.tauri\wintaskpro.key -p
```

Outputs:
- `~/.tauri/wintaskpro.key` — private. Goes in GitHub Actions secret
  `TAURI_SIGNING_PRIVATE_KEY`.
- `~/.tauri/wintaskpro.key.pub` — public. Goes in source.

### Step 2 — Sign each release

In CI, after building `WinTaskPro.exe`, generate a `.sig` companion file:

```powershell
npm run tauri signer sign -- -k $env:TAURI_SIGNING_PRIVATE_KEY \
  -p $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  WinTaskPro.exe
```

Upload both `WinTaskPro.exe` and `WinTaskPro.exe.sig` to the release.

### Step 3 — Verify in `download_and_install_update`

Add a fetch for `<asset_url>.sig`, then before the PE check, verify with the
public key embedded in the binary at compile time. The `tauri-plugin-updater`
crate has the verify routine, or a hand-rolled `ed25519-dalek` call works.

This eliminates the GitHub-trust dependency. A compromised release would
need both the GitHub account AND the signing key to push a malicious update.

---

## Verifying the update flow

After any change to update behaviour, verify in this order:

1. **Local check.** Edit `package.json` to a lower version (e.g. `1.0.0`),
   run `npm run tauri dev`, confirm:
   - Boot snapshot log line appears
   - 3 s later, `checkForUpdate new release found` log line appears
   - The banner appears with both "Update Now" and "View on GitHub" buttons.

2. **Click "View on GitHub".** Confirm it opens the release page in your
   default browser.

3. **Click "Update Now".** Confirm:
   - Modal appears with "Downloading WinTaskPro.exe…"
   - Log line `update::install starting | url=...` written
   - After 10–30 s, the app closes and re-launches with the new version
   - The version pill in the new instance shows the updated version
   - `%LOCALAPPDATA%\WinTaskPro\update_failed.txt` does NOT exist
     (or is empty — only failures write to it).

4. **Check logs.** `Settings → Developer Logs → 📜 View Logs` should show
   the full update flow:
   ```
   [INFO] [update::install] starting | url=... | target_version=...
   [INFO] [update::install] current_exe=... | new_exe=... | swap_script=...
   [INFO] [update::install] downloading (this can take 30-60s)…
   [INFO] [update::install] download ok | OK <bytes>
   [INFO] [update::install] PE verification ok
   [INFO] [update::install] swap helper written
   [INFO] [update::install] swap helper spawned | helper waits for pid=... | exiting now
   ```

5. **CI dry-run.** Tag a test release and confirm the workflow output
   contains the line `Tagged URL:  https://...releases/download/.../WinTaskPro.exe`
   and the verify step gets a 200/302 response from the latest URL.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Banner never appears | offline, GitHub rate-limit, or no newer release | Check `wintaskpro.log` for `checkForUpdate` lines |
| Banner appears but only shows "View on GitHub" | release is missing the `WinTaskPro.exe` asset | Maintainer: re-upload; user: manual download |
| "Update Now" → "Update failed: Update URL must be a GitHub release" | Frontend passed an unexpected URL to the IPC | Likely a release on a fork; check `data.html_url` matches the expected repo |
| "Update failed: Download failed: ..." | `Invoke-WebRequest` returned non-zero | Inspect log for the captured error message |
| "Downloaded file is not a valid Windows binary" | 404 HTML page returned, partial download, or corrupt asset | The download is auto-deleted; retry |
| App closes but doesn't re-open | Swap helper failed | Check `%LOCALAPPDATA%\WinTaskPro\update_failed.txt`; download manually |
| `update_failed.txt` says "Move-Item failed after 10 retries" | File lock wasn't released (rare; usually some other process scanning the exe) | Retry; if persistent, check AV / file indexer settings |
| New version launches but UI is broken | New release is genuinely buggy | Roll back: download an older version manually and replace the exe |

---

*1.8.0 — rewritten from the previous notification-only design to the
in-place portable self-replace flow shipped in this version.*
