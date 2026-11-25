import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Input } from "@ui-sdk/react/input";
import { useState } from "react";

import { api, type InstanceStatus } from "@/api/client";
import { Button } from "@/shared/ui/button";
import { Select } from "@/shared/ui/select";

import { applyInstanceUpdate, instanceKey } from "./instance-cache";

export default function ProfileDialog({
  instances,
  onClose,
  onCreate,
}: {
  instances: InstanceStatus[];
  onClose: () => void;
  onCreate: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [source, setSource] = useState("default");
  const create = useMutation({
    mutationFn: (id: string) =>
      api.createProfile(id, source === "default" ? null : source.slice(8)),
    onSuccess: (profile) => {
      applyInstanceUpdate(qc, profile);
      void qc.invalidateQueries({ queryKey: instanceKey });
      onCreate(profile.id);
      onClose();
    },
  });
  return (
    <Dialog
      open={true}
      onOpenChange={(open, details) => {
        if (!open && create.isPending) {
          details.cancel();
          return;
        }
        if (!open) onClose();
      }}
    >
      <DialogBackdrop />
      <DialogContent className="max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] overflow-auto p-6!">
        <DialogTitle>New automation profile</DialogTitle>
        <DialogDescription>
          Create a worker profile with default or copied settings.
        </DialogDescription>
        <form
          className="grid gap-4 [&_label]:grid [&_label]:gap-1.5 [&_label]:text-xs [&_label]:font-semibold [&_label]:text-secondary [&_[data-slot=input]]:w-full [&_[data-slot=select-trigger]]:w-full"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const name = String(fields.get("name") ?? "").trim();
            if (name) create.mutate(name);
          }}
        >
          <label htmlFor="profile-name">
            Profile name <Input id="profile-name" name="name" required maxLength={48} />
          </label>
          <div>
            <label htmlFor="profile-source">Copy from</label>
            <Select
              id="profile-source"
              items={[
                { value: "default", label: "Default settings" },
                ...instances.map((s) => ({
                  value: "profile:" + s.id,
                  label: s.id,
                })),
              ]}
              value={source}
              onValueChange={setSource}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="small" disabled={create.isPending}>
              Create
            </Button>
            <Button
              type="button"
              size="small"
              disabled={create.isPending}
              onClick={() => {
                create.reset();
                onClose();
              }}
            >
              Cancel
            </Button>
          </div>
          {create.error && (
            <p role="alert" className="text-bad text-xs">
              {create.error.message}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
