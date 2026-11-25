# Live events and disk logs

Each SSE connection polls the bounded instance log tails and keeps a cursor per profile.
It sends status deltas, log batches, a 15-second heartbeat and a resync event when a
connection opens or falls behind. After a resync the dashboard fetches REST snapshots and
merges live log lines. The stream session ID lets it clear old cursors after a server restart.
The dashboard retries connections with bounded backoff.

Each worker has a 256-entry live queue and a 2,000-entry server tail. When a queue fills,
the worker drops the live copy and the disk log keeps the record. The API limits text lines
to 16 KiB of UTF-8. The browser stores up to 2,000 lines per profile and virtualizes the
visible rows. Reconnects recover the latest retained tail. The service keeps no replay journal.

The file handler rolls at midnight or when the current file reaches 10 MiB. It keeps four
rotated segments plus the active file per log name. Existing historical daily files are
preserved. Rich tracebacks omit local variables.
