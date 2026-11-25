import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type InstanceStatus } from "../../api/client";
import { applyInstanceUpdate, beginInstanceGeneration, instanceGeneration, instanceKey, instanceOptions } from "./instance-cache";
import { deferred, instanceFixture } from "./test-fixtures";

afterEach(() => vi.restoreAllMocks());

const status = (revision: number) => instanceFixture({ revision });
describe("instance reconciliation", () => {
  it("keeps an SSE revision ahead of a REST response that started earlier", async () => {
    const client = new QueryClient();
    const rest = deferred<InstanceStatus[]>();
    vi.spyOn(api, "instances").mockReturnValue(rest.promise);
    const snapshot = client.fetchQuery(instanceOptions(client));
    client.setQueryData(instanceKey, [status(10)]);
    applyInstanceUpdate(client, status(12));
    rest.resolve([status(11)]);
    await snapshot;
    expect(client.getQueryData(instanceKey)).toEqual([status(12)]);
  });

  it("preserves the displayed roster until the new generation has a snapshot", async () => {
    const client = new QueryClient();
    const getInstances = vi.spyOn(api, "instances").mockResolvedValue([status(12)]);
    await beginInstanceGeneration(client, "old");
    await client.fetchQuery(instanceOptions(client));
    const epoch = instanceGeneration(client);

    await beginInstanceGeneration(client, "new");
    expect(client.getQueryData(instanceKey)).toEqual([status(12)]);
    expect(applyInstanceUpdate(client, status(13), epoch)).toBe(false);
    getInstances.mockResolvedValue([status(1)]);
    await client.fetchQuery({ ...instanceOptions(client), staleTime: 0 });
    expect(client.getQueryData(instanceKey)).toEqual([status(1)]);
    expect(applyInstanceUpdate(client, status(2))).toBe(true);
    expect(client.getQueryData(instanceKey)).toEqual([status(2)]);
  });
});
