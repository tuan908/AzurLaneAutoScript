# Reliability baseline status

The 48-hour blank window remains unclassified. No 72-hour Electron or browser probe CSV
was available in the Windows ALAS installation during implementation. A short isolated
smoke run on Windows Python 3.7.6 confirmed the control server, SyncManager and dashboard
started and that a fake worker survived closing and reopening a browser session.

The Electron and browser baseline runs and the final MuMu soak are still required.
See [soak-probe.md](soak-probe.md) and [operations.md](operations.md).
