import { Banner } from "./banner";
import { Button } from "./button";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

type QueryState<T> = Pick<UseQueryResult<T>, "data" | "error" | "isError" | "isFetching" | "refetch">;

export function QueryNotice({ query, label }: { query: QueryState<unknown>; label: string }) {
  if (query.isError) {
    const stale = query.data !== undefined;
    return (
      <Banner tone={stale ? "warn" : "bad"}>
        <div className="flex flex-wrap items-center gap-2">
          <span title={query.error?.message}>{stale ? `Showing stale ${label}. The latest request failed.` : `Could not load ${label}.`}</span>
          <Button size="small" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry {label}</Button>
        </div>
      </Banner>
    );
  }
  if (query.data === undefined) return <p className="text-sm text-subtle" role="status">Loading {label}…</p>;
  return null;
}

export function QueryContent<T>({ query, label, children }: {
  query: QueryState<T>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  return <><QueryNotice query={query} label={label} />{query.data !== undefined && children(query.data)}</>;
}
