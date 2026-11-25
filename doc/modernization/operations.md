# Run the control server on Windows

Build the dashboard from this checkout before copying the code and `dashboard/dist` into the
Windows ALAS installation. Keep the installation's `toolkit/` and `config/` directories.

```sh
cd dashboard
bun install --frozen-lockfile
bun run build
```

Stop the existing ALAS launcher before starting the control server for that installation.
From the Windows ALAS folder, run:

```bat
start-control.bat
```

Open [ALAS Control Center](http://127.0.0.1:22267/dashboard/). The batch file builds missing
dashboard assets if Bun is available. After a code update, rebuild on the development machine
and replace `dashboard/dist` with the new build. Use `start-control.bat --port 22367` when the
default port is occupied, or pass `--run profile-name` to start an existing profile on launch.
Press Ctrl+C in the launcher window for a graceful shutdown. Closing the browser leaves the
worker running. The headless server honors the ALAS deploy password and startup profiles.
The API uses the password as a bearer token when configured. The launcher always binds to
127.0.0.1. Use `gui.py` if you need PyWebIO or its updater.

## Optional Windows startup task

In the Windows user session that runs MuMu, run these commands from the installed ALAS folder.
Registration installs a logon trigger, retry on failure and an ignore-new policy. The first
run starts at the next login. To start sooner, use Run in Task Scheduler.

```powershell
.\deploy\Windows\register-control-task.ps1
.\deploy\Windows\register-control-task.ps1 -Unregister
```

To upgrade, stop the scheduled task, update the checkout and built dashboard, then start the
task again. Keep the working directory, profile configs and toolkit together.

## Diagnostics and soak

Use the Health tab or `GET /api/v1/health/details` for the server, log queue, instance
state and counters. The rollout still needs the two original 72-hour baseline runs and a
72-hour run with MuMu on this build. Keep each probe CSV and record when the browser closes,
the renderer blanks, devices disconnect or a worker stops. The probe can sample HTTP status
and latency on an isolated no-password control server with:

```bat
toolkit\python.exe dev_tools\soak_probe.py --url http://127.0.0.1:22267/api/v1/health/details --out log\soak-final.csv --interval 60 --duration 259200
```

## Fake-worker browser smoke

Use a separate copy of the checkout with the Windows toolkit, the template config, and a
built dashboard. The smoke creates a profile in that copy.

```bat
toolkit\python.exe -m dev_tools.smoke_control_runtime
```

From `dashboard/` in WSL, run the test against that server:

```sh
bunx playwright install chromium
ALAS_E2E_BASE=http://127.0.0.1:22368 bun run test:e2e
```
