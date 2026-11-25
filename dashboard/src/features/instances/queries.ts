import { useQuery, useQueryClient } from "@tanstack/react-query";

import { instanceOptions } from "./instance-cache";

export function useInstances() {
  return useQuery(instanceOptions(useQueryClient()));
}
