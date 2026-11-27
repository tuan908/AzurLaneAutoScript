# Run the control server on Windows

From the repository root in WSL, run the sync script with Git, Bun and rsync installed:

```sh
bash deploy/Windows/sync-from-wsl.sh
```

It builds the dashboard, records and stops running profiles, and syncs tracked source
files to `D:\alas-modernize`. It then starts the server with `start-control.vbs` and
resumes the same profiles. Automatic restart requires the installed Windows toolkit
and a local control API without a password.

Pass an alternate WSL path such as `/mnt/d/AnotherAlas` to update a different installation.
Pass the control port as the second argument if that installation uses a port other than
22267. Replaced files are backed up beside the installation. Local configuration, logs,
toolkit and Git metadata are preserved. Files deleted from source stay in the target.

For a manual launch, double-click `start-control.vbs` in File Explorer.
Startup output goes to `log/control-launch.log`.

Open [ALAS Control Center](http://127.0.0.1:22267/dashboard/). The batch file builds missing
dashboard assets if Bun is available. Run the sync script again after a code update.
For a visible diagnostic launch or to start
a specific profile, use `start-control.bat` with `--port 22367` or `--run profile-name` as needed.
Press Ctrl+C in a visible launcher window for a graceful shutdown. For a manual hidden launch,
stop any running profiles from the dashboard before ending the server in Task Manager. Closing the browser leaves the
worker running. The headless server honors the ALAS deploy password and startup profiles.
The API uses the password as a bearer token when configured. The launcher always binds to
127.0.0.1. Use `gui.py` if you need PyWebIO or its updater.

## Optional Windows startup task

In the Windows user session that runs MuMu, run these commands from the installed ALAS folder.
Registration uses the hidden launcher with a logon trigger, retry on failure and an ignore-new policy. The first
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
.venv\Scripts\python.exe dev_tools\soak_probe.py --url http://127.0.0.1:22267/api/v1/health/details --out log\soak-final.csv --interval 60 --duration 259200
```

## Fake-worker browser smoke

Use a separate copy of the checkout with the Windows toolkit, the template config, and a
built dashboard. The smoke creates a profile in that copy.

```bat
.venv\Scripts\python.exe -m dev_tools.smoke_control_runtime
```

From `dashboard/` in WSL, run the test against that server:

```sh
bunx playwright install chromium
ALAS_E2E_BASE=http://127.0.0.1:22368 bun run test:e2e
```
