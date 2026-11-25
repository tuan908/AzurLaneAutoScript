# Soak probe (P0.1)

`dev_tools/soak_probe.py` records the evidence for the P0 reliability baseline: it appends one
CSV of process, log and HTTP health rows next to a running ALAS, so a 72h soak can show **which
layer degrades first** (Electron, the PyWebIO/uvicorn server, the SyncManager, a worker, or MuMu).
P0.2 runs it, the `alas-soak` workflow analyses its CSV, and P0.3 writes the result to
`baseline.md`.

It uses only the standard library and psutil (already pinned in `requirements.txt`) and imports
nothing from `module.`, so it runs beside ALAS on the bundled Python 3.7 and cannot change what it
measures.

## Running it on Windows

The probe is not pushed anywhere. Copy `dev_tools/soak_probe.py` from `modernize/main` into the
Windows checkout (for example `D:\AzurLaneAutoScript\dev_tools\`) and leave the rest of that
checkout unchanged, so the baseline measures unmodified ALAS.

```bat
cd D:\AzurLaneAutoScript
:: 10-minute check that every role is recognised
toolkit\python.exe dev_tools\soak_probe.py --duration 600 --interval 10
:: 72h soak (stop with Ctrl+C)
toolkit\python.exe dev_tools\soak_probe.py --out log\soak.csv --interval 60
```

Run it from an elevated prompt if you need MuMu metrics; otherwise those rows have blank metrics
and `error=AccessDenied`.

Analyse a finished soak from WSL:

```bash
t3 workflow start alas-soak --key soak/p0-a --input \
  '{"label":"p0-electron","csvPath":"/mnt/d/AzurLaneAutoScript/log/soak.csv","hours":72}'
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `--out` | `<alas-root>/log/soak.csv` | CSV path (`log/` is git-ignored; the probe only reads `*.txt` there) |
| `--interval` | 60 | seconds between samples |
| `--duration` / `--samples` / `--once` | forever | when to stop |
| `--url` | from the running `gui.py` command line, else `config/deploy.yaml`, else `http://127.0.0.1:22267/` | GUI URL to `GET` |
| `--http-timeout` | 10 | hard deadline of the HTTP request (s) |
| `--insecure` | off | skip TLS verification (WebuiSSL) |
| `--handle-timeout` | 5 | deadline of the open-files helper process (s) |
| `--electron-name` | `alas.exe`, `electron.exe` | Electron process names (repeatable) |
| `--mumu-pattern` | `MuMuPlayer*`, `MuMuVMMHeadless*` | MuMu name patterns (repeatable) |
| `--extra-pattern`, `--pid` | none | extra processes to watch, e.g. `adb*.exe` |
| `--log-window-hours`, `--log-limit` | 48, 10 | which `log/*.txt` files are reported |
| `--alas-root` | parent of `dev_tools` | ALAS folder |

## What the CSV contains

One header and 30 fixed columns:
`ts, sample, kind, role, instance, tree, orphan, pid, ppid, name, status, create_time, rss_mb,
vms_mb, threads, handles, fds, cpu_pct, cmdline, path, size_bytes, mtime_age_s, last_line_ts,
last_line_age_s, url, http_status, latency_ms, counts, sample_ms, error`. Columns that do not apply
to a row are empty.

| `kind` | One row per | Signals |
|---|---|---|
| `proc` | process of interest per sample | RSS/VMS (MB), threads, handles (Windows) or fds (POSIX), CPU % since last sample, status |
| `log` | recent `log/*.txt` file | size, mtime age, timestamp and age of the last timestamped line (worker progress) |
| `http` | sample | status and latency of `GET` on the GUI |
| `probe` | sample | the probe's own RSS, sample duration, and role counts such as `server=1;sync_manager=1;worker=2;orphan=0` |
| `error` | problem while sampling | exception type and message; the probe keeps running |

Roles: `gui_launcher` (the `EnableReload` parent), `server` (listens on the GUI port),
`sync_manager` (earliest server child, created by `State.init()`), `worker` (instance name from
its open `log/<date>_<name>.txt`), `unknown`, `python_descendant`, `descendant`, `electron_main`,
`electron_renderer`, `electron_other`, `mumu`, `extra`, `pinned`, `zombie`.

How to read a soak:

- **Growth**: compare `rss_mb`, `threads` and `handles` per role over time. A role whose memory
  or handle count only ever goes up is the leak candidate.
- **A process disappeared**: the role count in the `probe` row drops (for example `worker=0`) even
  though that process has no row of its own any more.
- **Orphans**: processes left behind after their server exits keep their role and get
  `orphan=1` (finding F7).
- **UI blank but automation alive**: `http` rows still return 200 while `log` rows keep a small
  `last_line_age_s`, which points at Electron or the PyWebIO session rather than the worker.
- **Automation stalled**: `last_line_age_s` grows while the worker row still exists.

## Guarantees

- **A dying target never crashes the probe**: every psutil call is guarded, and a process that
  exits mid-sample gives `status=gone` or blank fields.
- **A hung lookup never hangs the probe**: handle lookups run in a helper process with a hard
  timeout, and the HTTP request has a hard overall deadline.
- **PID reuse is detected**: identity is (pid, create_time), so a recycled PID is treated as a new
  process.
- **The CSV stays consistent**: each batch is written in one append. A write interrupted after
  the file was opened (disk full, file locked, or Ctrl+C mid-write) is cut back to the previous
  size before anything else is appended. While the file is not writable (for example, open in
  Excel), up to 20000 rows are buffered; drops are reported in an `error` row.
- **The schema never mixes**: an existing CSV with a different header is left alone, and rows go
  to a timestamped sibling file.
- **Secrets are not recorded**: the GUI password (`-k` / `--key`) is redacted from command lines.
- **Exit codes**: 0 on a normal stop or Ctrl+C; 1 if rows were dropped or left unwritten.

## Known limitations

- **Roles are best-effort on Windows.** Multiprocessing children share the same `spawn_main`
  command line, and a worker is recognised only once its log file handle is visible. Check the
  labels during the 10-minute run; the raw pid, ppid, create_time and cmdline let the analysis
  re-classify.
- **`GET /` only proves that uvicorn and Starlette answer.** It does not exercise a PyWebIO
  websocket session or the SyncManager queue; the `log` rows and your notes cover that gap.
- **Just after a reload restart**, before the new server listens, a launcher can be guessed as the
  server for one sample.
- **POSIX fork reparenting** (not the Windows runtime): a worker reparented after its server exits
  keeps the `gui.py` command line and may inherit the listening socket, so it can be taken for a
  new server root. Windows uses spawn, which is not affected. Open review finding from P0.1.
- **A narrow PID-reuse window**: handle and listener results are joined to the sample by PID. If
  a target dies during the helper lookup and the OS reuses its PID within that sample, the late
  data can be attributed to the dead process for one sample. Open review finding from P0.1.
- **Volume**: at 60 s a 72h run is about 100k rows (20–30 MB); `--interval 5` is about 12× that.
- **Tests run on Linux with fakes.** Windows-only paths (`num_handles`, Electron `--type`
  arguments) are only verified by the 10-minute run on the host.
