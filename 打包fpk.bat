@echo off
rem ===========================================================================
rem  fnOS (FeiNiu) fpk builder for the NAS Local Music Player
rem  Usage: double-click this file, or run it from a terminal.
rem         Every path below is %~dp0-relative, so it always builds the project
rem         it sits in, no matter which folder the shell is in.
rem  Prereq: fnos\fnpack.exe (Windows x86) - download from
rem          https://developer.fnnas.com/docs/cli/fnpack/
rem          (the downloaded file has no extension: rename it to fnpack.exe)
rem  Output: <project root>\fpk\<appname>-<version>.fpk  (folder created on demand)
rem  NOTE: keep this file ASCII-only, batch parsing of non-ASCII is fragile.
rem ===========================================================================
setlocal
set "PROJ=%~dp0"
set "FNOS=%PROJ%fnos"
set "PKG=%FNOS%\nasmp"
set "SERVER=%PKG%\app\server"

echo === Build fnOS fpk: NAS Local Music Player ===
echo.

echo [1/6] Copy application files...
if exist "%SERVER%" rmdir /s /q "%SERVER%"
mkdir "%SERVER%"
copy /y "%PROJ%server.js" "%SERVER%\server.js" >nul
if errorlevel 1 goto fail
copy /y "%PROJ%package.json" "%SERVER%\package.json" >nul
if errorlevel 1 goto fail
if exist "%PROJ%version.json" copy /y "%PROJ%version.json" "%SERVER%\version.json" >nul
xcopy "%PROJ%public" "%SERVER%\public" /e /i /y /q >nul
if errorlevel 1 goto fail
if exist "%PROJ%online_sources" xcopy "%PROJ%online_sources" "%SERVER%\online_sources" /e /i /y /q >nul

echo [2/6] Copy runtime dependencies (node_modules)...
rem     Fully automatic: prefer the local node_modules (fast, offline). If it is
rem     missing, install the production deps straight into the package dir, so
rem     packaging never depends on the developer having run "npm install" first.
if not exist "%PROJ%node_modules\express" goto installdeps
xcopy "%PROJ%node_modules" "%SERVER%\node_modules" /e /i /y /q >nul
if errorlevel 1 goto fail
goto depsok
:installdeps
where npm >nul 2>nul
if errorlevel 1 goto nodeps
echo     node_modules missing - installing production deps with npm ...
pushd "%SERVER%"
call npm install --omit=dev --no-audit --no-fund --loglevel=error
popd
if not exist "%SERVER%\node_modules\express" goto nodeps
:depsok

echo [3/6] Generate app icons...
powershell -NoProfile -ExecutionPolicy Bypass -File "%FNOS%\make-icons.ps1"
if errorlevel 1 goto fail

echo [4/6] Sync manifest version from package.json...
powershell -NoProfile -ExecutionPolicy Bypass -File "%FNOS%\sync-version.ps1" -From "%PROJ%package.json" -Manifest "%PKG%\manifest"
if errorlevel 1 goto fail

echo [5/6] Normalize newlines to LF...
powershell -NoProfile -ExecutionPolicy Bypass -File "%FNOS%\normalize-lf.ps1" -Path "%PKG%"
if errorlevel 1 goto fail

echo [6/6] Locate fnpack, build and rename...
set "FNPACK="
if exist "%FNOS%\fnpack.exe" set "FNPACK=%FNOS%\fnpack.exe"
if not defined FNPACK if exist "%PROJ%fnpack.exe" set "FNPACK=%PROJ%fnpack.exe"
if not defined FNPACK for %%I in (fnpack.exe) do if not "%%~$PATH:I"=="" set "FNPACK=%%~$PATH:I"
if not defined FNPACK goto nofnpack
echo     %FNPACK%

pushd "%PKG%"
"%FNPACK%" build
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" goto fail

rem --- output folder: <project root>\fpk (created on demand) ---
set "OUTDIR=%PROJ%fpk"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
if errorlevel 1 goto fail

rem --- rename to <appname>-<version>.fpk and move it into the output folder ---
set "APPNAME="
set "VERSION="
for /f "tokens=2 delims==" %%V in ('findstr /b /c:"appname" "%PKG%\manifest"') do set "APPNAME=%%V"
for /f "tokens=2 delims==" %%V in ('findstr /b /c:"version" "%PKG%\manifest"') do set "VERSION=%%V"
set "APPNAME=%APPNAME: =%"
set "VERSION=%VERSION: =%"
if not defined APPNAME set "APPNAME=nasmp"
set "BUILT=%PKG%\%APPNAME%.fpk"
set "OUTNAME=%APPNAME%.fpk"
if defined VERSION set "OUTNAME=%APPNAME%-%VERSION%.fpk"
if not exist "%BUILT%" goto fail
move /y "%BUILT%" "%OUTDIR%\%OUTNAME%" >nul
if errorlevel 1 goto fail
set "OUT=%OUTDIR%\%OUTNAME%"

echo.
echo Done: %OUT%
echo Install: upload it in the fnOS App Center, or over SSH run
echo   appcenter-cli install-fpk "%OUT%"
echo.
rem --- open the output folder and highlight the package just built ---
explorer /select,"%OUT%"
echo.
pause
exit /b 0

:nofnpack
echo.
echo fnpack.exe not found.
echo Download the Windows x86 build from
echo   https://developer.fnnas.com/docs/cli/fnpack/
echo The downloaded file has no extension - rename it to fnpack.exe and put it in:
echo   %FNOS%
echo.
pause
exit /b 1

:nodeps
echo.
echo Failed to prepare the runtime dependencies.
echo Either "%PROJ%node_modules" is incomplete, or npm is not available.
echo Fix it once by doing ONE of these:
echo   1. cd /d "%PROJ%" ^&^& npm install
echo   2. drop a complete node_modules folder into "%PROJ%"
echo.
pause
exit /b 1

:fail
echo.
echo Build FAILED. See the output above.
echo.
pause
exit /b 1
