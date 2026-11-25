import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { toast } from "@ui-sdk/react/toast";

import { api } from "@/api/client";

import { applyInstanceUpdate, instanceGeneration, instanceKey } from "./instance-cache";

type Action = "start" | "stop" | "restart";
export function useInstanceCommand(id: string) {
  const client = useQueryClient();
  const key = ["instance-command", id] as const;
  const pending = useMutationState({
    filters: { mutationKey: key, exact: true, status: "pending" },
    select: (mutation) => mutation.state.submittedAt,
  });
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: async ({ action, epoch }: { action: Action; epoch: number }) => {
      if (epoch !== instanceGeneration(client))
        throw new Error("Server changed before command execution");
      return api.command(id, action);
    },
    onSuccess: (status, variables) => {
      applyInstanceUpdate(client, status, variables.epoch);
      const done = { start: "Started", stop: "Stopped", restart: "Restarted" }[variables.action];
      toast.success(`${done} ${id}`, {
        description: status.processId ? `Worker PID ${status.processId}` : undefined,
      });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: instanceKey });
    },
  });
  return {
    isPending: pending.length > 0 || mutation.isPending,
    error: mutation.error,
    mutate(action: Action) {
      if (client.isMutating({ mutationKey: key, exact: true })) return;
      mutation.mutate({ action, epoch: instanceGeneration(client) });
    },
  };
}
