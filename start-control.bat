@echo off
setlocal
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"

rem Python 3.15 and the dependencies live in .venv, made by uv from pyproject.toml and uv.lock.
rem uv, its Python builds and its cache stay inside toolkit\uv, nothing is installed system wide.
set "UV_DIR=%~dp0toolkit\uv"
set "UV_INSTALL_DIR=%UV_DIR%"
set "UV_NO_MODIFY_PATH=1"
set "UV_PYTHON_INSTALL_DIR=%UV_DIR%\python"
set "UV_CACHE_DIR=%UV_DIR%\cache"
set "UV=%UV_DIR%\uv.exe"

if not exist "%UV%" (
    echo Installing uv to %UV_DIR%
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    if not exist "%UV%" (
        echo Failed to install uv. Install it manually to %UV_DIR%, see https://docs.astral.sh/uv/
        exit /b 1
    )
)
rem A no-op when .venv already matches uv.lock
"%UV%" sync --frozen --no-dev
if errorlevel 1 (
    echo uv sync failed, see the output above.
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
if not exist "alasd\bin\alasd.exe" (
    echo alasd\bin\alasd.exe is missing. Build it with alasd/build.sh on the development machine and copy it here.
    exit /b 1
)
rem .venv first so `python` is 3.15. Git and adb (AdbExecutable in deploy.yaml) still come from the
rem toolkit, its adbutils is the same 0.11.0 as in .venv so both use the same adb server version.
set "PATH=%~dp0.venv\Scripts;%~dp0toolkit\alias;%~dp0toolkit\command;%~dp0toolkit\Git\mingw64\bin;%~dp0toolkit\Lib\site-packages\adbutils\binaries;%PATH%"
rem The Go control server owns the Python workers, see alasd/
"alasd\bin\alasd.exe" %*
