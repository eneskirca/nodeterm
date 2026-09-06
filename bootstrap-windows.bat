@echo off
setlocal EnableExtensions
rem =============================================================================================
rem bootstrap-windows.bat — take a fresh Windows checkout to an installed, buildable nodeterm.
rem
rem What it does: verifies the toolchain a native-module Electron build needs (Node >= 20, npm,
rem Visual Studio Build Tools with the C++ workload + x64 Spectre libraries, Python 3 — node-pty
rem and smart-whisper are compiled against Electron's ABI by the npm `postinstall` hook), then
rem runs `npm ci`.
rem
rem What it does NOT do: install anything machine-wide. Each missing tool is reported with the
rem exact winget command to run — installs that touch Program Files are a decision for the
rem human at the keyboard, not for a bootstrap script.
rem
rem Invoke by ABSOLUTE path from automation (cmd /c "C:\path\to\repo\bootstrap-windows.bat"):
rem on machines with NoDefaultCurrentDirectoryInExePath=1 a relative `cmd /c bootstrap-windows.bat`
rem fails even though the file exists, because cmd refuses to search the current directory.
rem
rem After it succeeds:
rem   npm run dev        - development mode with HMR
rem   npm run dist:win   - unsigned NSIS installer + zip into dist\ (packaging smoke test)
rem =============================================================================================

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
set "_NODETERM_VSWHERE_OVERRIDE="

rem Keep the Visual Studio probe independently runnable for diagnostics and CI regression tests.
rem GitHub-hosted Windows runners are elevated, while the full bootstrap intentionally refuses
rem elevation before npm lifecycle scripts; this mode runs only the toolchain probe and never npm.
if /i "%~1"=="--check-vs-build-tools" goto :check_vs_build_tools_only

rem --- Refuse elevation: npm lifecycle scripts must never run as Administrator. ----------------
"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 86}else{exit 0}" >nul 2>nul
if errorlevel 86 (
    echo [FAILED] Do not run this script as Administrator. Open a normal prompt and rerun.
    exit /b 1
)

echo === nodeterm Windows bootstrap ===
echo Repository: "%REPO%"
echo.

rem --- Node.js >= 20 ----------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [MISSING] Node.js was not found on PATH.
    echo   Install:  winget install OpenJS.NodeJS.LTS
    echo   then open a NEW prompt and rerun this script.
    exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 (
    echo [FAILED] Node.js ^>= 20 is required; found major version %NODE_MAJOR%.
    echo   Upgrade:  winget install OpenJS.NodeJS.LTS
    exit /b 1
)
echo [OK] Node.js major %NODE_MAJOR%

rem --- Visual Studio Build Tools with the C++ workload (node-gyp / electron-rebuild) ------------
call :check_vs_build_tools
if errorlevel 1 exit /b 1

rem --- Python 3 (node-gyp) -----------------------------------------------------------------------
py -3 --version >nul 2>nul
if errorlevel 1 (
    python --version >nul 2>nul
    if errorlevel 1 (
        echo [MISSING] Python 3 was not found ^(node-gyp needs it^).
        echo   Install:  winget install Python.Python.3.12
        echo   then open a NEW prompt and rerun this script.
        exit /b 1
    )
)
echo [OK] Python 3

rem --- Install dependencies (postinstall patches node-pty + rebuilds native modules) ------------
echo.
echo Running npm ci ...
pushd "%REPO%"
rem Official Node 26 Windows builds carry clang/lld ThinLTO settings in process.config. node-gyp
rem 12 copies them into MSVC addon projects, where link.exe rejects /opt:lldltojobs (LNK1117).
rem npm forwards these overrides to node-gyp with higher precedence than process.config.
set "npm_config_enable_thin_lto=false"
set "npm_config_enable_lto=false"
call npm ci
set "NPM_EXIT=%ERRORLEVEL%"
popd
if not "%NPM_EXIT%"=="0" (
    echo [FAILED] npm ci exited with code %NPM_EXIT%. See the output above.
    exit /b %NPM_EXIT%
)

echo.
echo [DONE] Dependencies installed and native modules rebuilt against Electron's ABI.
echo   npm run dev        - development mode with HMR
echo   npm run dist:win   - unsigned NSIS installer + zip into dist\
exit /b 0

:check_vs_build_tools_only
if "%NODETERM_BOOTSTRAP_TESTING%"=="1" set "_NODETERM_VSWHERE_OVERRIDE=%NODETERM_TEST_VSWHERE%"
call :check_vs_build_tools
exit /b %ERRORLEVEL%

:check_vs_build_tools
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
rem The check-only mode may inject a fixture; the full bootstrap always uses vswhere's canonical
rem installer location so an inherited environment variable cannot redirect the production probe.
if defined _NODETERM_VSWHERE_OVERRIDE set "VSWHERE=%_NODETERM_VSWHERE_OVERRIDE%"
if not exist "%VSWHERE%" (
    echo [MISSING] Visual Studio Build Tools were not found ^(vswhere.exe absent^).
    echo   Install:  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    echo   ^(elevated; then open a NEW prompt and rerun this script^)
    exit /b 1
)

set "VSWHERE_ARGS=-products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath"
rem vswhere returns exit code 0 even when the query matches nothing. Capture the first path and
rem test the value itself; checking only ERRORLEVEL silently accepts a machine without C++ tools.
set "VS_INSTALLATION="
rem CALL is intentional: production uses vswhere.exe, but the cmd.exe tests inject a .cmd fixture
rem that must return control to this script.
for /f "usebackq delims=" %%I in (`call "%VSWHERE%" %VSWHERE_ARGS% 2^>nul`) do if not defined VS_INSTALLATION set "VS_INSTALLATION=%%I"
if not defined VS_INSTALLATION (
    rem FOR /F does not preserve the nested command's exit status. Query again only after an empty
    rem capture so the retry status classifies query failure versus no matching installation.
    call "%VSWHERE%" %VSWHERE_ARGS% >nul 2>nul
    if errorlevel 1 (
        echo [FAILED] vswhere could not query Visual Studio installations.
        exit /b 1
    )
    echo [MISSING] No Visual Studio installation with the C++ build tools component was found.
    echo   Install:  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    exit /b 1
)
if not exist "%VS_INSTALLATION%\." (
    echo [FAILED] vswhere reported a Visual Studio path that does not exist: "%VS_INSTALLATION%"
    exit /b 1
)

rem node-pty builds with /Qspectre and requires the matching x64 Spectre runtime libraries.
rem Checking only the compiler workload reports a healthy toolchain that fails later with MSB8040.
set "SPECTRE_RUNTIME="
for /d %%D in ("%VS_INSTALLATION%\VC\Tools\MSVC\*") do if exist "%%~fD\lib\spectre\x64\vcruntime.lib" if not defined SPECTRE_RUNTIME set "SPECTRE_RUNTIME=%%~fD\lib\spectre\x64\vcruntime.lib"
if not defined SPECTRE_RUNTIME (
    echo [MISSING] Visual Studio C++ Spectre-mitigated libraries were not found.
    echo   Open Visual Studio Installer, modify Build Tools, then under Individual components install:
    echo   MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs ^(Latest^)
    exit /b 1
)

echo [OK] Visual Studio C++ build tools: "%VS_INSTALLATION%"
echo [OK] Visual Studio C++ Spectre-mitigated libraries
exit /b 0
