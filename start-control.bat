@echo off
setlocal
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
if not exist "toolkit\python.exe" (
    echo ALAS toolkit Python was not found. Run this from the installed ALAS folder.
    exit /b 1
)
if not exist "dashboard\dist\index.html" (
    where bun >nul 2>&1
    if errorlevel 1 (
        echo Build dashboard/dist with Bun on the development machine and copy it here.
        exit /b 1
    )
    pushd dashboard
    call bun install --frozen-lockfile && call bun run build
    if errorlevel 1 (
        popd
        exit /b 1
    )
    popd
)
set "PATH=%~dp0toolkit\alias;%~dp0toolkit\command;%~dp0toolkit;%~dp0toolkit\Scripts;%~dp0toolkit\Git\mingw64\bin;%~dp0toolkit\Lib\site-packages\adbutils\binaries;%PATH%"
"toolkit\python.exe" control_server.py %*
