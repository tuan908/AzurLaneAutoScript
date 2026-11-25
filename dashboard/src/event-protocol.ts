import type { InstanceStatus, LogLine } from "./api";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const nullableString = (value: unknown) => value === null || typeof value === "string";
const nullableNumber = (value: unknown) => value === null || integer(value);
function health(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!record(value) || typeof value["detail"] !== "string" ||
      !["ok", "idle", "stopped", "stalled", "crashed", "human_takeover", "unmanaged"].includes(typeof value["state"] === "string" ? value["state"] : "")) return false;
  const r = value["recovery"];
  if (!record(r) || typeof r["gaveUp"] !== "boolean" || !nullableString(r["nextAttemptAt"]) ||
      !nullableString(r["pendingReason"]) || !integer(r["restartsLastHour"])) return false;
  const p = r["policy"];
  return record(p) && typeof p["autoRestart"] === "boolean" && typeof p["restartOnStall"] === "boolean" && integer(p["stallMinutes"]);
}
function status(value: unknown): value is InstanceStatus {
  return record(value) && typeof value["id"] === "string" &&
    typeof value["state"] === "string" &&
    ["stopped", "starting", "running", "stopping", "failed"].includes(value["state"]) &&
    integer(value["revision"]) && integer(value["legacyState"]) && integer(value["runLogStartSeq"]) &&
    integer(value["taskFailures"]) && integer(value["taskSuccesses"]) &&
    typeof value["unmanaged"] === "boolean" && typeof value["logDraining"] === "boolean" &&
    nullableNumber(value["exitCode"]) && nullableNumber(value["processId"]) &&
    nullableString(value["currentTask"]) && nullableString(value["lastActivityAt"]) &&
    nullableString(value["lastError"]) && nullableString(value["startedAt"]) && nullableString(value["stoppedAt"]) && health(value["health"]);
}
function logLine(value: unknown): value is LogLine {
  return record(value) && integer(value["seq"]) && value["seq"] > 0 && typeof value["text"] === "string";
}
export type StreamEvent =
  | { type: "resync"; streamId: string }
  | { type: "instance.status.changed"; data: InstanceStatus }
  | { type: "log.appended"; instanceId: string; lines: LogLine[] };

export function parseEvent(event: string | undefined, data: string): StreamEvent | null {
  let payload: unknown;
  try { payload = JSON.parse(data); } catch { return null; }
  if (!record(payload)) return null;
  if (event === "resync" && typeof payload["streamId"] === "string" && payload["streamId"].length > 0) return { type: event, streamId: payload["streamId"] };
  if (event === "instance.status.changed" && status(payload["data"])) return { type: event, data: payload["data"] };
  if (event === "log.appended" && typeof payload["instanceId"] === "string" && Array.isArray(payload["lines"]) && payload["lines"].every(logLine)) {
    return { type: event, instanceId: payload["instanceId"], lines: payload["lines"] };
  }
  return null;
}
