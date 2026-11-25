import "zod/compile";
import { useMatches, useNavigate, useParams } from "@tanstack/react-router";
import * as z from "zod";

export const TAB_LABELS = {
  overview: "Overview",
  scheduler: "Scheduler",
  logs: "Logs",
  settings: "Settings",
  health: "Health",
} as const;
export const TabSchema = z.enum(Object.keys(TAB_LABELS) as [keyof typeof TAB_LABELS]);
export type Tab = z.infer<typeof TabSchema>;
export const TABS = TabSchema.options;

export function tabPath<T extends Tab>(tab: T): `/$instanceId/${T}` {
  return `/$instanceId/${tab}`;
}

export function useDashboardRoute() {
  const instanceId = useParams({
    strict: false,
    select: (params) => params.instanceId,
  });
  const tab = useMatches({
    select: (matches) => matches.at(-1)?.staticData.dashboardTab ?? "overview",
  });
  const navigate = useNavigate();
  const go = (id: string, next: Tab = "overview") => {
    void navigate({
      to: tabPath(next),
      params: { instanceId: id },
      search: {},
    });
  };
  return { instanceId, tab, go };
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    dashboardTab?: Tab;
  }
}
