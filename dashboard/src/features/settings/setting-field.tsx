import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { Textarea } from "@ui-sdk/react/textarea";

import type { ConfigField, ConfigValue } from "@/api/client";
import { Button } from "@/shared/ui/button";
import { Select } from "@/shared/ui/select";

import { SettingHelp } from "./setting-help";

/** "2020-01-01 00:00:00" <-> datetime-local "2020-01-01T00:00:00" */
const toLocalInput = (v: ConfigValue) =>
  typeof v === "string" ? v.replace(" ", "T").slice(0, 19) : "";

export function SettingField({
  field,
  value,
  edited,
  changed,
  showKey,
  disabled,
  error,
  onChange,
}: {
  field: ConfigField;
  value: ConfigValue;
  edited: boolean;
  changed: boolean;
  showKey: boolean;
  disabled: boolean;
  error: string | undefined;
  onChange: (v: ConfigValue) => void;
}) {
  const id = `f-${field.path}`;
  const errorId = `${id}-error`;
  const validation = {
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": error ? errorId : undefined,
  };
  let control;
  if (field.readOnly) {
    control = (
      <span className="font-code text-[12.5px] text-subtle">
        {value === null ? "—" : String(value)}
      </span>
    );
  } else if (field.type === "checkbox") {
    control = (
      <Switch
        {...validation}
        disabled={disabled}
        id={id}
        aria-label={`${field.label} ${field.path}`}
        checked={value === true}
        onCheckedChange={onChange}
      >
        <SwitchThumb />
      </Switch>
    );
  } else if (field.type === "select") {
    const options = field.options ?? [];
    const known = options.some((o) => String(o.value) === String(value));
    control = (
      <Select
        {...validation}
        id={id}
        label={`${field.label} ${field.path}`}
        disabled={disabled}
        items={[
          ...(!known ? [{ value: String(value), label: String(value) }] : []),
          ...options.map((o) => ({ value: String(o.value), label: o.label })),
        ]}
        value={String(value)}
        onValueChange={(next) => {
          const picked = options.find((o) => String(o.value) === next);
          onChange(picked ? picked.value : next);
        }}
      />
    );
  } else if (field.type === "datetime") {
    control = (
      <Input
        {...validation}
        disabled={disabled}
        id={id}
        type="datetime-local"
        step={1}
        value={toLocalInput(value)}
        onValueChange={onChange}
      />
    );
  } else if (field.type === "textarea") {
    control = (
      <Textarea
        {...validation}
        disabled={disabled}
        id={id}
        rows={4}
        value={value === null ? "" : String(value)}
        onValueChange={onChange}
      />
    );
  } else {
    control = (
      <Input
        {...validation}
        disabled={disabled}
        id={id}
        type="text"
        value={value === null ? "" : String(value)}
        onValueChange={onChange}
      />
    );
  }
  const defaultLabel =
    field.options?.find((o) => String(o.value) === String(field.default))?.label ??
    String(field.default);
  return (
    <div
      className={`-mx-4.5 grid grid-cols-1 gap-x-6 gap-y-1.5 border-t border-edge px-4.5 py-3 first-of-type:border-t-0 min-[981px]:grid-cols-[minmax(0,1fr)_18rem] [&>label]:flex [&>label]:flex-col [&>label]:gap-0.5 [&>label]:text-[13px] [&>label]:font-semibold ${error ? "bg-bad-soft/70 shadow-[inset_3px_0_0_var(--bad)]" : edited ? "bg-warn-soft/70 shadow-[inset_3px_0_0_var(--warn)]" : ""}`}
    >
      <label htmlFor={id} title={showKey ? undefined : field.path}>
        <span className="inline-flex flex-wrap items-center gap-x-2">
          {field.label}
          {changed && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent before:size-1.5 before:rounded-full before:bg-accent"
              title={`Default: ${defaultLabel}`}
            >
              Changed
            </span>
          )}
          {changed && !disabled && (
            <Button
              variant="ghost"
              size="small"
              className="-my-1 min-h-6! px-1.5! text-[11px]! text-accent!"
              aria-label={`Reset ${field.label} to default (${defaultLabel})`}
              title={`Reset to default: ${defaultLabel}`}
              onClick={() => onChange(field.default)}
            >
              Reset
            </Button>
          )}
        </span>
        {showKey && (
          <span className="wrap-anywhere font-code text-[11px] leading-[1.4] font-normal text-subtle">
            {field.path}
          </span>
        )}
      </label>
      <div className="flex min-w-0 items-center [&_[data-slot=select-trigger]]:w-full">
        {control}
      </div>
      {error && (
        <div id={errorId} className="col-span-full text-xs text-bad">
          {error}
        </div>
      )}
      {field.help && (
        <SettingHelp className="col-span-full" text={field.help} about={field.label} />
      )}
    </div>
  );
}
