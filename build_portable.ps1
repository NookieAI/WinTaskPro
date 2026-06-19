# ─────────────────────────────────────────────────────────────────────────────
# WinTaskPro — Portable EXE Build Script  v1.0
#
# ⚠ THIS FILE MUST BE SAVED AS UTF-8 WITH BOM (byte-order mark).
#   PowerShell 5.1 (the version Windows ships with by default) reads .ps1
#   files using the system ANSI codepage UNLESS the file starts with a
#   UTF-8 BOM (0xEF 0xBB 0xBF). Without the BOM, the box-drawing characters
#   used in the banner below decode as garbage and the parser cascades
#   "Missing closing }" errors all over the file.
#
#   If you edit this file in VS Code: bottom-right corner status bar
#   should show "UTF-8 with BOM". If it shows "UTF-8", click it and pick
#   "Save with encoding → UTF-8 with BOM".
#   If you edit in Notepad: it saves UTF-8 with BOM by default. OK.
#   If you edit in PowerShell ISE: it saves UTF-16 LE with BOM by default,
#   which also works but bloats the file. Prefer UTF-8 with BOM.
#
# Builds WinTaskPro.exe via `tauri build --no-bundle` and copies it to dist\.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File build_portable.ps1
#   powershell -ExecutionPolicy Bypass -File build_portable.ps1 -Clean
#   powershell -ExecutionPolicy Bypass -File build_portable.ps1 -Clean -SkipNpm
#   powershell -ExecutionPolicy Bypass -File build_portable.ps1 -Debug
#
# FLAGS
#   -Clean      Run `cargo clean` before building.
#               REQUIRED when any .rs file changed since the last build.
#               Without this, Rust may use stale compiled artifacts.
#   -SkipNpm    Skip `npm ci`. Use when only Rust files changed.
#   -Debug      Build a debug exe (faster compile, no optimisations).
#               Output: src-tauri\target\debug\WinTaskPro.exe
#   -Sign       Authenticode-sign the output with signtool.
#               Requires env var WINTASKPRO_SIGN_THUMBPRINT to be set to the
#               SHA-1 thumbprint of a code-signing cert in the user's cert
#               store. signtool.exe must be on PATH (Windows SDK).
#   -Help       Show this message and exit.
#
# PREREQUISITES (must be on PATH)
#   - Node.js  >= 18     https://nodejs.org
#   - Rust / cargo       https://rustup.rs  (stable toolchain, MSVC)
#   - @tauri-apps/cli    installed via npm ci (handled automatically)
#
# OUTPUT
#   dist\WinTaskPro.exe                    ← upload this to GitHub releases (auto-update target)
#   dist\WinTaskPro_vX.Y.Z_portable.exe    ← archive copy with version stamp
#   dist\WinTaskPro_latest.exe             ← legacy alias
#
# COMPATIBILITY: PowerShell 5.1+ (Windows default). No ternary ?:, no ??, no ??=.
# ─────────────────────────────────────────────────────────────────────────────
param(
    [switch] $Clean,
    [switch] $SkipNpm,
    [switch] $Debug,
    [switch] $Sign,
    [switch] $Help
)

Set-StrictMode -Version Latest
# Do NOT set $ErrorActionPreference = 'Stop' at script level —
# it aborts on the first non-zero exit from external tools and
# prevents our own error-handling logic from running.

# ── Colour helpers (matching clean_project.ps1 style) ────────────────────────
function Write-Ok   { param($msg) Write-Host "  [OK]  $msg" -ForegroundColor Green  }
function Write-Warn { param($msg) Write-Host "  [!!]  $msg" -ForegroundColor Yellow }
function Write-Info { param($msg) Write-Host "   -   $msg"  -ForegroundColor Cyan   }
function Write-Bad  { param($msg) Write-Host "  [!!]  $msg" -ForegroundColor Red    }
function Write-Bold { param($msg) Write-Host "  $msg"       -ForegroundColor White  }
function Write-Dim  { param($msg) Write-Host "  $msg"       -ForegroundColor DarkGray }
function Write-Sep  { Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor DarkGray }
function Write-Step { param($n, $total, $msg) Write-Host "  [${n}/${total}] $msg" -ForegroundColor White }

function Write-Header {
    Clear-Host
    Write-Host ""
    Write-Host "  ██╗    ██╗████████╗██████╗ " -ForegroundColor Cyan
    Write-Host "  ██║    ██║╚══██╔══╝██╔══██╗" -ForegroundColor Cyan
    Write-Host "  ██║ █╗ ██║   ██║   ██████╔╝" -ForegroundColor Cyan
    Write-Host "  ██║███╗██║   ██║   ██╔═══╝ " -ForegroundColor Cyan
    Write-Host "  ╚███╔███╔╝   ██║   ██║     " -ForegroundColor Cyan
    Write-Host "   ╚══╝╚══╝    ╚═╝   ╚═╝     " -ForegroundColor Cyan
    Write-Host "  WinTaskPro — Portable Build  v1.0" -ForegroundColor DarkGray
    Write-Sep
    Write-Host ""
}

function Format-Bytes {
    param([long] $bytes)
    if ($bytes -ge 1MB) {
        return ("{0:F1} MB" -f ($bytes / 1MB))
    }
    elseif ($bytes -ge 1KB) {
        return ("{0:F0} KB" -f ($bytes / 1KB))
    }
    else {
        return "$bytes B"
    }
}

function Format-Duration {
    param([timespan] $ts)
    if ($ts.TotalHours -ge 1) {
        return ("{0}h {1}m {2}s" -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds)
    }
    elseif ($ts.TotalMinutes -ge 1) {
        return ("{0}m {1}s" -f [int]$ts.TotalMinutes, $ts.Seconds)
    }
    else {
        return ("{0}s" -f [int]$ts.TotalSeconds)
    }
}

# ── Help ──────────────────────────────────────────────────────────────────────
if ($Help) {
    Write-Header
    Write-Bold "USAGE"
    Write-Host ""
    Write-Dim  "  powershell -ExecutionPolicy Bypass -File build_portable.ps1 [flags]"
    Write-Host ""
    Write-Bold "FLAGS"
    Write-Host "   -Clean      cargo clean before building (use when .rs files changed)" -ForegroundColor White
    Write-Host "   -SkipNpm    Skip npm ci (use when only .rs files changed)"            -ForegroundColor White
    Write-Host "   -Debug      Build debug exe (faster, no optimisations)"               -ForegroundColor White
    Write-Host "   -Sign       Authenticode-sign output (needs WINTASKPRO_SIGN_THUMBPRINT)" -ForegroundColor White
    Write-Host "   -Help       Show this help and exit"                                  -ForegroundColor White
    Write-Host ""
    Write-Bold "OUTPUT"
    Write-Dim  "  dist\WinTaskPro.exe                    (upload this to GitHub releases)"
    Write-Dim  "  dist\WinTaskPro_vX.Y.Z_portable.exe    (archive copy with version stamp)"
    Write-Host ""
    exit 0
}

# ── Initialise ────────────────────────────────────────────────────────────────
Write-Header

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = $ScriptDir
# 7 mandatory steps now (added "Verify frontend JS syntax" before the build).
$TotalSteps  = 7
if ($Clean)  { $TotalSteps++ }
if (-not $SkipNpm) { $TotalSteps++ }
if ($Sign)   { $TotalSteps++ }

# ── Step 0: Verify we are in the project root ─────────────────────────────────
Write-Step 0 $TotalSteps "Verifying project root"

$RequiredFiles = @(
    "package.json",
    "src-tauri\Cargo.toml",
    "src-tauri\tauri.conf.json",
    "src\index.html"
)
$MissingFiles = @()
foreach ($f in $RequiredFiles) {
    $full = Join-Path $ProjectRoot $f
    if (-not (Test-Path $full)) {
        $MissingFiles += $f
    }
}
if ($MissingFiles.Count -gt 0) {
    Write-Bad "Not in WinTaskPro project root. Missing:"
    foreach ($f in $MissingFiles) { Write-Bad "  $f" }
    Write-Warn "Run this script from the project root directory."
    exit 1
}
Set-Location $ProjectRoot
Write-Ok "Project root: $ProjectRoot"

# ── Read version from package.json ────────────────────────────────────────────
try {
    $PkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $AppVersion = $PkgJson.version
}
catch {
    Write-Bad "Could not read version from package.json: $_"
    exit 1
}

# Read Cargo.toml version and verify consistency
$CargoContent = Get-Content "src-tauri\Cargo.toml" -Raw
$CargoVersionMatch = [regex]::Match($CargoContent, '^version\s*=\s*"([^"]+)"', [System.Text.RegularExpressions.RegexOptions]::Multiline)
if ($CargoVersionMatch.Success) {
    $CargoVersion = $CargoVersionMatch.Groups[1].Value
    if ($CargoVersion -ne $AppVersion) {
        Write-Warn "Version mismatch: package.json=$AppVersion  Cargo.toml=$CargoVersion"
        Write-Warn "Continuing — update all version files before shipping."
    }
    else {
        Write-Ok "Version: v$AppVersion (package.json + Cargo.toml consistent)"
    }
}
else {
    Write-Warn "Could not parse version from Cargo.toml"
    $CargoVersion = $AppVersion
}

Write-Host ""
$StepNum = 1

# ── Step 1: Check prerequisites ───────────────────────────────────────────────
Write-Step $StepNum $TotalSteps "Checking prerequisites"
$StepNum++

$PrereqOk = $true

# Node.js
try {
    $NodeVer = (node --version 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "node exited $LASTEXITCODE" }
    Write-Ok "Node.js $NodeVer"
}
catch {
    Write-Bad "Node.js not found on PATH."
    Write-Warn "Install from https://nodejs.org (LTS recommended, >= 18)"
    $PrereqOk = $false
}

# npm
try {
    $NpmVer = (npm --version 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "npm exited $LASTEXITCODE" }
    Write-Ok "npm $NpmVer"
}
catch {
    Write-Bad "npm not found on PATH."
    $PrereqOk = $false
}

# cargo (Rust)
try {
    $CargoVer = (cargo --version 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "cargo exited $LASTEXITCODE" }
    Write-Ok "Rust  $CargoVer"
}
catch {
    Write-Bad "cargo not found on PATH."
    Write-Warn "Install Rust from https://rustup.rs — choose the MSVC toolchain."
    $PrereqOk = $false
}

# rustup target (MSVC, not GNU)
if ($PrereqOk) {
    $ActiveToolchain = (rustup show active-toolchain 2>&1)
    if ($ActiveToolchain -match "gnu") {
        Write-Warn "Active Rust toolchain appears to be GNU: $ActiveToolchain"
        Write-Warn "WinTaskPro requires the MSVC toolchain for Windows COM APIs."
        Write-Warn "Fix: rustup default stable-x86_64-pc-windows-msvc"
    }
    elseif ($ActiveToolchain -match "msvc") {
        Write-Ok "Rust toolchain: MSVC (correct)"
    }
    # If rustup isn't installed, skip this check silently
}

if (-not $PrereqOk) {
    Write-Host ""
    Write-Bad "One or more prerequisites are missing. Install them and retry."
    exit 1
}

Write-Host ""

# ── Step 2 (optional): cargo clean ───────────────────────────────────────────
if ($Clean) {
    Write-Step $StepNum $TotalSteps "Cleaning Rust build artifacts (cargo clean)"
    $StepNum++
    Write-Warn "This forces a full recompile — expected time: 5-15 min."
    Write-Host ""

    Push-Location "src-tauri"
    cargo clean 2>&1 | ForEach-Object { Write-Dim "  $_" }
    $ExitCode = $LASTEXITCODE
    Pop-Location

    if ($ExitCode -ne 0) {
        Write-Bad "cargo clean failed (exit $ExitCode)"
        exit 1
    }
    Write-Ok "Rust target directory cleaned"
    Write-Host ""
}

# ── Step 3 (optional): npm ci ─────────────────────────────────────────────────
if (-not $SkipNpm) {
    Write-Step $StepNum $TotalSteps "Installing npm dependencies (npm ci)"
    $StepNum++

    $NodeModulesOk = Test-Path (Join-Path $ProjectRoot "node_modules")
    if ($NodeModulesOk -and -not $Clean) {
        Write-Info "node_modules present — running npm ci to verify lockfile"
    }

    npm ci 2>&1 | ForEach-Object { Write-Dim "  $_" }
    $ExitCode = $LASTEXITCODE

    if ($ExitCode -ne 0) {
        Write-Bad "npm ci failed (exit $ExitCode)"
        Write-Warn "Try deleting node_modules\ and package-lock.json, then run npm install."
        exit 1
    }
    Write-Ok "npm dependencies installed"
    Write-Host ""
}

# ── Step 4: Verify @tauri-apps/cli is available ───────────────────────────────
Write-Step $StepNum $TotalSteps "Verifying Tauri CLI"
$StepNum++

# npx tauri --version works regardless of global/local install
$TauriVer = (npx tauri --version 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Bad "Tauri CLI not found."
    Write-Warn "@tauri-apps/cli must be in devDependencies and npm ci must have run."
    Write-Warn "Run without -SkipNpm to let the script install it."
    exit 1
}
Write-Ok "Tauri CLI $TauriVer"
Write-Host ""

# ── Step 4.5: Verify frontend JS syntax (fast-fail) ──────────────────────────
# Runs in <1s. A syntax error caught here saves the user a 1-15 minute Rust
# compile that would succeed only to ship a broken WebView. node --check is
# pure parse — does not execute the file, so no side-effects on the build env.
Write-Step $StepNum $TotalSteps "Verifying frontend JS syntax (node --check)"
$StepNum++

$JsFiles = @("src\app.js", "devserver.js")
$JsErrors = 0
foreach ($jsFile in $JsFiles) {
    $full = Join-Path $ProjectRoot $jsFile
    if (-not (Test-Path $full)) {
        Write-Warn "Skipping (not present): $jsFile"
        continue
    }
    & node --check $full 2>&1 | ForEach-Object { Write-Dim "  $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Bad "Syntax error in $jsFile (exit $LASTEXITCODE)"
        $JsErrors++
    } else {
        Write-Ok "OK: $jsFile"
    }
}
if ($JsErrors -gt 0) {
    Write-Host ""
    Write-Bad "Frontend JS has $JsErrors syntax error(s). Fix before building."
    exit 1
}
Write-Host ""

# ── Step 5: Build ─────────────────────────────────────────────────────────────
Write-Step $StepNum $TotalSteps "Building portable exe"
$StepNum++

if ($Debug) {
    Write-Warn "Building DEBUG profile (no optimisations, larger exe, console window visible)"
    $BuildArgs = @("tauri", "build", "--no-bundle", "--debug")
    $TargetSubdir = "debug"
}
else {
    Write-Info "Building RELEASE profile (opt-level=s, LTO, strip — this takes a while)"
    $BuildArgs = @("tauri", "build", "--no-bundle")
    $TargetSubdir = "release"
}

if ($Clean) {
    Write-Warn "Expect 5-15 min (cold build after cargo clean)"
}
else {
    Write-Info "Expect 1-5 min (incremental — only changed crates recompile)"
}
Write-Host ""

$BuildStart = Get-Date
$BuildLogPath = Join-Path $ProjectRoot "build.log"

# Direct invocation of npx.cmd — avoids the powershell→cmd.exe→npx.cmd→node
# chain the previous version went through. Output is streamed live AND captured
# to build.log for post-mortem.
# 2>&1 redirection in PS captures both streams into one pipeline.
& npx.cmd @BuildArgs 2>&1 | Tee-Object -FilePath $BuildLogPath
$ExitCode      = $LASTEXITCODE
$BuildDuration = (Get-Date) - $BuildStart

Write-Host ""
if ($ExitCode -ne 0) {
    Write-Bad "Build FAILED (exit $ExitCode) after $(Format-Duration $BuildDuration)"
    Write-Host ""
    Write-Bold "Common causes:"
    Write-Warn "  - Rust file changed without -Clean flag → run with -Clean"
    Write-Warn "  - Missing Visual Studio Build Tools (MSVC)"
    Write-Warn "  - WebView2 runtime not installed on build machine"
    Write-Warn "  - Cargo.lock out of date → run: cargo update"
    exit 1
}

Write-Ok "Build succeeded in $(Format-Duration $BuildDuration)"
Write-Host ""

# ── Step 6: Locate the built exe ─────────────────────────────────────────────
Write-Step $StepNum $TotalSteps "Locating output exe"
$StepNum++

# Tauri can output to either of these depending on whether --target was passed.
# 1.14.2: binary renamed from wintaskpro.exe → WinTaskPro.exe via Cargo.toml
# [[bin]] name override. We still check the lowercase variant as a fallback
# so a stale incremental build from a pre-1.14.2 checkout still locates the
# artifact and the script doesn't fail with a confusing "not found" error.
$CandidatePaths = @(
    "src-tauri\target\$TargetSubdir\WinTaskPro.exe",
    "src-tauri\target\x86_64-pc-windows-msvc\$TargetSubdir\WinTaskPro.exe",
    "src-tauri\target\x86_64-pc-windows-gnu\$TargetSubdir\WinTaskPro.exe",
    # Legacy fallbacks (pre-1.14.2 builds, or stale incremental output)
    "src-tauri\target\$TargetSubdir\wintaskpro.exe",
    "src-tauri\target\x86_64-pc-windows-msvc\$TargetSubdir\wintaskpro.exe",
    "src-tauri\target\x86_64-pc-windows-gnu\$TargetSubdir\wintaskpro.exe"
)

$BuiltExe = $null
foreach ($candidate in $CandidatePaths) {
    $full = Join-Path $ProjectRoot $candidate
    if (Test-Path $full) {
        $BuiltExe = $full
        break
    }
}

if ($null -eq $BuiltExe) {
    Write-Bad "Could not find WinTaskPro.exe in any expected output path:"
    foreach ($c in $CandidatePaths) { Write-Dim "    $c" }
    Write-Warn "Build may have succeeded but output was placed elsewhere."
    Write-Warn "Check src-tauri\target\ manually."
    exit 1
}

$ExeInfo   = Get-Item $BuiltExe
$ExeSize   = Format-Bytes $ExeInfo.Length
$ExeHash   = (Get-FileHash $BuiltExe -Algorithm SHA256).Hash

Write-Ok "Found: $BuiltExe"
Write-Ok "Size:  $ExeSize"
Write-Dim "SHA256: $ExeHash"
Write-Host ""

# ── Step 6.5: Authenticode sign (optional) ───────────────────────────────────
# Run before the copy-to-dist step so the dist artefact carries the signature.
# Re-hash after signing — the SHA-256 changes when a signature is appended.
$Signed = $false
if ($Sign) {
    Write-Step $StepNum $TotalSteps "Code signing with signtool"
    $StepNum++

    $Thumbprint = $env:WINTASKPRO_SIGN_THUMBPRINT
    if (-not $Thumbprint) {
        Write-Bad "WINTASKPRO_SIGN_THUMBPRINT env var not set."
        Write-Warn "Set it to the SHA-1 thumbprint of your code-signing certificate:"
        Write-Dim  "  `$env:WINTASKPRO_SIGN_THUMBPRINT = 'ABC123...'"
        exit 1
    }
    $SigntoolCmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if (-not $SigntoolCmd) {
        Write-Bad "signtool.exe not found on PATH."
        Write-Warn "Install Windows SDK, or add a Windows SDK bin directory to PATH."
        Write-Dim  "  e.g. C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64\"
        exit 1
    }

    Write-Info "Signing with thumbprint: $Thumbprint"
    & $SigntoolCmd.Source sign `
        /sha1 $Thumbprint `
        /fd sha256 `
        /tr http://timestamp.digicert.com `
        /td sha256 `
        /d "WinTaskPro" `
        $BuiltExe
    if ($LASTEXITCODE -ne 0) {
        Write-Bad "signtool failed (exit $LASTEXITCODE)"
        exit 1
    }
    # Re-hash after signing
    $ExeHash = (Get-FileHash $BuiltExe -Algorithm SHA256).Hash
    $ExeSize = Format-Bytes (Get-Item $BuiltExe).Length
    $Signed  = $true
    Write-Ok "Signed successfully — new SHA-256: $ExeHash"
    Write-Host ""
}

# ── Step 7: Copy to dist\ ─────────────────────────────────────────────────────
Write-Step $StepNum $TotalSteps "Copying to dist\"
$StepNum++

$DistDir = Join-Path $ProjectRoot "dist"
if (-not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir | Out-Null
    Write-Info "Created dist\"
}

# Versioned name (archive copy) + canonical name `WinTaskPro.exe` that matches
# the asset name uploaded to GitHub releases. The canonical name is what the
# in-app auto-updater downloads and replaces — keep this filename in lockstep
# with .github/workflows/release.yml.
if ($Debug) {
    $VersionedName = "WinTaskPro_v${AppVersion}_portable_debug.exe"
}
else {
    $VersionedName = "WinTaskPro_v${AppVersion}_portable.exe"
}
$CanonicalName = "WinTaskPro.exe"

$VersionedDest = Join-Path $DistDir $VersionedName
$CanonicalDest = Join-Path $DistDir $CanonicalName
$LatestDest    = Join-Path $DistDir "WinTaskPro_latest.exe"  # legacy alias

Copy-Item $BuiltExe $VersionedDest -Force
Copy-Item $BuiltExe $CanonicalDest -Force
Copy-Item $BuiltExe $LatestDest    -Force

Write-Ok "Versioned: dist\$VersionedName"
Write-Ok "Canonical: dist\$CanonicalName  ← upload this to GitHub releases"
Write-Ok "Alias:     dist\WinTaskPro_latest.exe"
Write-Host ""

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Sep
Write-Host ""
Write-Host "  ✅  BUILD COMPLETE" -ForegroundColor Green
Write-Host ""
Write-Host ("  App version  : v" + $AppVersion)      -ForegroundColor White
Write-Host ("  Profile      : " + $TargetSubdir.ToUpper()) -ForegroundColor White
Write-Host ("  Size         : " + $ExeSize)           -ForegroundColor White
Write-Host ("  Build time   : " + (Format-Duration $BuildDuration)) -ForegroundColor White
Write-Host ("  Output       : dist\" + $CanonicalName + "  (upload this)") -ForegroundColor White
Write-Host ("  Archive copy : dist\" + $VersionedName) -ForegroundColor DarkGray
if ($Signed) {
    Write-Host  "  Signed       : YES (Authenticode)" -ForegroundColor Green
}
else {
    Write-Host  "  Signed       : no (use -Sign to enable)" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  SHA-256: $ExeHash" -ForegroundColor DarkGray
Write-Host "  Build log: $BuildLogPath" -ForegroundColor DarkGray
Write-Host ""
Write-Sep
Write-Host ""

# ── AV / SmartScreen reminder ────────────────────────────────────────────────
if (-not $Signed) {
    Write-Host "  ⚠  UNSIGNED BUILD — expected warnings:" -ForegroundColor Yellow
    Write-Host ""
    Write-Dim "  • Windows SmartScreen will block the first run ('unrecognised publisher')."
    Write-Dim "    Click 'More info' → 'Run anyway', or right-click → Properties → Unblock."
    Write-Dim "  • Some AV tools flag spawning powershell.exe (event log query) and"
    Write-Dim "    TerminateProcess (process manager). These are expected — see AV_SAFETY.md."
    Write-Dim "  • To eliminate all warnings: sign with -Sign and a code-signing cert."
    Write-Dim "    See UPDATER.md for the signing setup guide."
    Write-Host ""
}
Write-Host "  Run as Administrator — Task Scheduler requires elevated access." -ForegroundColor Yellow
Write-Host ""
