import { Input } from "@ui-sdk/react/input";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { Textarea } from "@ui-sdk/react/textarea";
import type { ConfigField, ConfigValue } from "../../api/client";
import { Select } from "../../shared/ui/select";
import { SettingHelp } from "./setting-help";

/** "2020-01-01 00:00:00" <-> datetime-local "2020-01-01T00:00:00" */
const toLocalInput = (v: ConfigValue) => (typeof v === "string" ? v.replace(" ", "T").slice(0, 19) : "");

export function SettingField({
  field,
  value,
  edited,
  disabled,
  error,
  onChange,
}: {
  field: ConfigField;
  value: ConfigValue;
  edited: boolean;
  disabled: boolean;
  error: string | undefined;
  onChange: (v: ConfigValue) => void;
}) {
  const id = `f-${field.path}`;
  let control;
  if (field.readOnly) {
    control = <span className="font-code text-[12.5px] text-subtle">{value === null ? "—" : String(value)}</span>;
  } else if (field.type === "checkbox") {
    control = (
      <Switch disabled={disabled} id={id} aria-label={`${field.label} ${field.path}`} checked={value === true} onCheckedChange={onChange}><SwitchThumb /></Switch>
    );
  } else if (field.type === "select") {
    const options = field.options ?? [];
    const known = options.some((o) => String(o.value) === String(value));
    control = (
      <Select id={id} label={`${field.label} ${field.path}`} disabled={disabled} items={[...(!known ? [{ value: String(value), label: String(value) }] : []), ...options.map(o => ({ value: String(o.value), label: o.label }))]} value={String(value)} onValueChange={(next) => {
          const picked = options.find(o => String(o.value) === next);
          onChange(picked ? picked.value : next);
        }} />
    );
  } else if (field.type === "datetime") {
    control = (
      <Input disabled={disabled} id={id} type="datetime-local" step={1} value={toLocalInput(value)} onValueChange={onChange} />
    );
  } else if (field.type === "textarea") {
    control = <Textarea disabled={disabled} id={id} rows={4} value={value === null ? "" : String(value)} onValueChange={onChange} />;
  } else {
    control = <Input disabled={disabled} id={id} type="text" value={value === null ? "" : String(value)} onValueChange={onChange} />;
  }
  return (
    <div className={`-mx-4.5 grid grid-cols-1 gap-x-6 gap-y-1.5 border-t border-edge px-4.5 py-3 first-of-type:border-t-0 min-[981px]:grid-cols-[minmax(200px,.9fr)_minmax(220px,1.1fr)] [&>label]:flex [&>label]:flex-col [&>label]:gap-0.5 [&>label]:text-[13px] [&>label]:font-semibold ${error ? "bg-bad-soft/70 shadow-[inset_3px_0_0_var(--bad)]" : edited ? "bg-warn-soft/70 shadow-[inset_3px_0_0_var(--warn)]" : ""}`}>
      <label htmlFor={id}>
        {field.label}
        <span className="wrap-anywhere font-code text-[11px] leading-[1.4] font-normal text-subtle">{field.path}</span>
      </label>
      <div className="flex min-w-0 items-center [&_[data-slot=select-trigger]]:w-full">{control}</div>
      {error && <div className="col-span-full text-xs text-bad">{error}</div>}
      {field.help && <SettingHelp className="col-span-full" text={field.help} about={field.label} />}
    </div>
  );
}
