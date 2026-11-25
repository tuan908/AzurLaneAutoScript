import {
  Select as SdkSelect,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";

export function Select({
  items,
  value,
  onValueChange,
  disabled,
  id,
  label,
  className,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: {
  items: readonly (string | { value: string; label: string })[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  className?: string;
  "aria-invalid"?: true | undefined;
  "aria-describedby"?: string | undefined;
}) {
  return (
    <SdkSelect
      items={[...items]}
      value={value}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        {...(className ? { className } : {})}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent />
    </SdkSelect>
  );
}
