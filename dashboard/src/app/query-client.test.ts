import { MutationObserver, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "@/api/query-keys";

import { createQueryClient } from "./query-client";

const seeded: QueryKey[] = [
  queryKeys.instances,
  queryKeys.tasks("a"),
  queryKeys.tasks("b"),
  queryKeys.health,
  queryKeys.recovery,
  queryKeys.config("a"),
];

function seededClient() {
  const client = createQueryClient();
  for (const key of seeded) client.setQueryData(key, { seeded: true });
  return client;
}

const invalidated = (client: ReturnType<typeof createQueryClient>) =>
  seeded.filter((key) => client.getQueryState(key)?.isInvalidated).map((key) => key.join("/"));

async function run(
  client: ReturnType<typeof createQueryClient>,
  options: { invalidates?: QueryKey[]; fail?: boolean },
) {
  const observer = new MutationObserver(client, {
    mutationFn: async () => {
      if (options.fail) throw new Error("rejected");
      return "ok";
    },
    ...(options.invalidates ? { meta: { invalidates: options.invalidates } } : {}),
  });
  await observer.mutate().catch(() => undefined);
}

describe("automatic invalidation after mutations", () => {
  it("invalidates only the keys a mutation declares", async () => {
    const client = seededClient();
    await run(client, { invalidates: [queryKeys.instances, queryKeys.health] });
    expect(invalidated(client)).toEqual(["instances", "health"]);
  });

  it("matches declared keys as prefixes", async () => {
    const client = seededClient();
    await run(client, { invalidates: [["tasks"]] });
    expect(invalidated(client)).toEqual(["tasks/a", "tasks/b"]);
  });

  it("invalidates everything when a mutation declares nothing", async () => {
    const client = seededClient();
    await run(client, {});
    expect(invalidated(client)).toEqual(seeded.map((key) => key.join("/")));
  });

  it("leaves the cache alone when a mutation fails", async () => {
    const client = seededClient();
    await run(client, { invalidates: [queryKeys.instances], fail: true });
    expect(invalidated(client)).toEqual([]);
  });

  it("lets a mutation wait for the refetch the global callback started, without a second request", async () => {
    const client = createQueryClient();
    let fetches = 0;
    let revision = 1;
    const key = queryKeys.config("a");
    const query = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => {
        fetches += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return revision;
      },
    });
    const unsubscribe = query.subscribe(() => undefined);
    await client.fetchQuery({ queryKey: key });
    fetches = 0;

    const save = new MutationObserver(client, {
      mutationFn: async () => {
        revision = 2;
        return "saved";
      },
      meta: { invalidates: [key] },
      onSuccess: () => client.invalidateQueries({ queryKey: key }, { cancelRefetch: false }),
    });
    await save.mutate();

    expect(client.getQueryData(key)).toBe(2);
    expect(fetches).toBe(1);
    unsubscribe();
  });
});
