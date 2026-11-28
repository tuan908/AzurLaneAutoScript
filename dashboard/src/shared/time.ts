// Times and durations as the dashboard shows them.
//
// ALAS writes server-local times as "YYYY-MM-DD HH:MM:SS" (task next runs, config values);
// the API's own times are ISO with an offset. The server runs on the browser's machine, so
// local times are read in the browser's time zone.

const ALAS_LOCAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

/** Milliseconds since the epoch, NaN when the text is not a time. */
export function parseTime(value: string): number {
  return new Date(ALAS_LOCAL.test(value) ? value.replace(" ", "T") : value).getTime();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The ALAS local format, "2026-11-26 21:05:09". */
export function formatAlasTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The two largest units: "2d 5h", "3m 12s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Time elapsed since `value`, "—" without a time. */
export function since(value: string | null | undefined, now: number): string {
  if (!value) return "—";
  return formatDuration((now - parseTime(value)) / 1000);
}

/** "in 2h 5m", or "due now" once the time has passed. */
export function untilNextRun(value: string, now: number): string {
  const t = parseTime(value);
  if (Number.isNaN(t)) return value;
  const seconds = (t - now) / 1000;
  return seconds <= 0 ? "due now" : `in ${formatDuration(seconds)}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Localised relative time: "in 2 hours", "5 minutes ago". */
export function relativeTime(t: number, now: number): string {
  const seconds = Math.round((t - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86400), "day");
}
