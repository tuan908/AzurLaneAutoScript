import type { InstanceStatus } from "../../api/client";

export function instanceFixture(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    id: "alas", state: "stopped", processId: null, startedAt: null, stoppedAt: null,
    exitCode: null, currentTask: null, lastActivityAt: null, lastError: null, legacyState: 2,
    revision: 0, runLogStartSeq: 0, logDraining: false, unmanaged: false, taskFailures: 0, taskSuccesses: 0,
    ...overrides,
  };
}

const noop = () => {};

export function deferred<T>() {
  let resolve: (value: T) => void = noop;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
