# Health and recovery

Existing ALAS recovery handles ADB reconnect in `module/device/connection.py`, game
restart after stuck/click-limit errors in `alas.py`, and Windows emulator startup in
`module/device/platform/platform_windows.py`. The dashboard adds observation and opt-in
worker restart on crashes or stalls. Leave those policies disabled until the instance has
evidence they would help.

The health monitor treats an idle scheduler separately from a task with stale activity.
It waits for exit logs before recovering, blocks automatic recovery after a human-takeover
request or loss of the log manager, and checks the same worker state immediately before
a scheduled restart. It uses an hourly budget and bounded backoff. The health tab surfaces
recent attempts and the give-up state.

The details endpoint exposes uptime, worker state and counters for scheduler outcomes,
successful automatic restarts and accepted live connections. Counters reset on server
restart. Task outcomes come from the live worker log, so missing live messages can
undercount completions. ADB readiness and MuMu hangs still require device-side evidence.
