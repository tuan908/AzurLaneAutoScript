import type { ReactNode } from "react";

export function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-alas border border-edge bg-panel px-4 py-3.5 shadow-alas">
      <dt className="text-xs font-medium text-subtle">{label}</dt>
      <dd className="mt-1 truncate text-xl font-semibold tracking-tight [&_small]:text-xs [&_small]:font-medium [&_small]:text-subtle">
        {children}
      </dd>
    </div>
  );
}
