import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useState } from "react";
import { api, type InstancePolicy, type InstanceStatus } from "../../api/client";
import { Banner } from "../../shared/ui/banner";
import { Card } from "../../shared/ui/card";
import { OptionRow } from "./option-row";
import { recoveryQuery } from "./queries";

export function RecoveryControls({ status }: { status: InstanceStatus }) {
  const qc = useQueryClient();
  const recovery = useQuery(recoveryQuery());
  const [stallDraft, setStallDraft] = useState<string | null>(null);
  const policy = status.health?.recovery.policy;
  const stallMinutes = stallDraft ?? String(policy?.stallMinutes ?? "");
  const global = recovery.data?.policy;

  const update = useMutation({
    mutationFn: (changes: Partial<InstancePolicy>) => api.updatePolicy({ instances: { [status.id]: changes } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recovery"] });
      void qc.invalidateQueries({ queryKey: ["instances"] });
    },
  });
  const updateGlobal = useMutation({
    mutationFn: api.updatePolicy,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["recovery"] }),
  });

  return (
  <Card heading={<>Recovery for {status.id}</>}>
    {policy ? <>
      <OptionRow>
        <label htmlFor="r-auto">
          Restart when the worker crashes
          <span>Never after a deliberate stop, a normal finish, an update or a human-takeover request</span>
        </label>
        <Switch id="r-auto" aria-label="Restart when the worker crashes" checked={policy.autoRestart} disabled={update.isPending} onCheckedChange={(next, details) => { details.cancel(); update.mutate({ autoRestart: next }); }}><SwitchThumb /></Switch>
      </OptionRow>
      <OptionRow>
        <label htmlFor="r-stall">
          Restart when a task stalls
          <span>A task is running but nothing was logged for the stall time</span>
        </label>
        <Switch id="r-stall" aria-label="Restart when a task stalls" checked={policy.restartOnStall} disabled={update.isPending} onCheckedChange={(next, details) => { details.cancel(); update.mutate({ restartOnStall: next }); }}><SwitchThumb /></Switch>
      </OptionRow>
      <OptionRow>
        <label htmlFor="r-stall-min">
          Stall time (minutes)
          <span>0 turns stall detection off</span>
        </label>
        <Input id="r-stall-min" type="number" min={0} max={1440} value={stallMinutes} disabled={update.isPending}
          onValueChange={setStallDraft}
          onBlur={() => {
            const n = Number(stallMinutes);
            if (stallMinutes.trim() && Number.isInteger(n) && n >= 0 && n <= 1440 && n !== policy.stallMinutes) update.mutate({ stallMinutes: n });
            setStallDraft(null);
          }} />
      </OptionRow>
    </> : <p role="status" className="text-sm text-subtle">Waiting for instance health data…</p>}
    {global && (
      <OptionRow>
        <label htmlFor="r-max">
          Restarts per hour, all instances
          <span>Waits {global.backoffSeconds.join("s, ")}s between attempts, then gives up</span>
        </label>
        <Input id="r-max" type="number" min={0} max={60} key={global.maxRestartsPerHour} defaultValue={String(global.maxRestartsPerHour)} disabled={updateGlobal.isPending || recovery.isError}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (e.target.value.trim() && Number.isInteger(n) && n >= 0 && n <= 60 && n !== global.maxRestartsPerHour) updateGlobal.mutate({ maxRestartsPerHour: n });
          }} />
      </OptionRow>
    )}
    {(update.error || updateGlobal.error) && (
      <Banner tone="bad">{(update.error ?? updateGlobal.error)?.message}</Banner>
    )}
  </Card>
  );
}
