@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: WinTaskPro — Portable EXE Build Launcher
:: Double-click this file, or call from CI:
::
::   build_portable.bat              <- standard release build
::   build_portable.bat /Clean       <- cargo clean first (after .rs changes)
::   build_portable.bat /Clean /SkipNpm
::   build_portable.bat /Debug
::   build_portable.bat /Help
::
:: Forwards all arguments to build_portable.ps1 as PowerShell switches.
:: Requires PowerShell 5.1+ (pre-installed on Windows 10/11).
:: ─────────────────────────────────────────────────────────────────────────────

:: Change to the directory containing this .bat file so relative paths work
:: even when launched from a different working directory (e.g. double-click).
cd /d "%~dp0"

:: Build the PowerShell argument string from the arguments passed to this .bat.
:: Each /Flag becomes a -Flag switch for build_portable.ps1.
:: This handles up to 9 flags — enough for any realistic call.
set "PS_ARGS="
:ARG_LOOP
if "%~1"==""          goto DONE_ARGS
if /i "%~1"=="/Help"    set "PS_ARGS=%PS_ARGS% -Help"
if /i "%~1"=="/Clean"   set "PS_ARGS=%PS_ARGS% -Clean"
if /i "%~1"=="/SkipNpm" set "PS_ARGS=%PS_ARGS% -SkipNpm"
if /i "%~1"=="/Debug"   set "PS_ARGS=%PS_ARGS% -Debug"
shift
goto ARG_LOOP
:DONE_ARGS

:: Check that build_portable.ps1 exists next to this .bat
if not exist "%~dp0build_portable.ps1" (
    echo.
    echo   [!!]  build_portable.ps1 not found next to this .bat file.
    echo   [!!]  Make sure both files are in the WinTaskPro project root.
    echo.
    pause
    exit /b 1
)

:: Launch PowerShell with execution policy bypass.
:: -NoProfile avoids user profile scripts that might interfere.
powershell.exe -NoProfile -ExecutionPolicy Bypass ^
    -File "%~dp0build_portable.ps1"%PS_ARGS%

set BUILD_EXIT=%ERRORLEVEL%

:: If launched by double-click (no parent console), pause so the user can
:: read the output. Detect double-click by checking if the parent is explorer.
:: The simplest reliable heuristic: pause only when stdin is a terminal.
echo.
if "%BUILD_EXIT%"=="0" (
    echo   Build finished successfully. Output is in dist\
) else (
    echo   Build FAILED with exit code %BUILD_EXIT%. See output above.
)
echo.

:: Pause only if launched without a console parent (i.e. double-click from
:: Explorer). When launched from cmd.exe / a CI runner / a terminal, %CMDCMDLINE%
:: starts with the path to cmd.exe followed by other args; double-click sets it
:: to just `cmd.exe /c ""<this.bat>"" `. The `/c ` substring after the path is
:: the reliable double-click signal.
echo %CMDCMDLINE% | find /i "/c " >nul
if not errorlevel 1 pause

exit /b %BUILD_EXIT%
