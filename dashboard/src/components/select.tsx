import { Select as SdkSelect, SelectContent, SelectTrigger, SelectValue } from "@ui-sdk/react/select";

export function Select({ items, value, onValueChange, disabled, id, label }: {
  items: (string | { value: string; label: string })[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
}) {
  return (
    <SdkSelect items={items} value={value} disabled={disabled ?? false} onValueChange={(next) => {
      if (next !== null) onValueChange(next);
    }}>
      <SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent />
    </SdkSelect>
  );
}
