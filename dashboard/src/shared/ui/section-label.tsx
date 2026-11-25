import type { ReactNode } from "react";

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-semibold tracking-[.06em] uppercase text-subtle">
      {children}
    </span>
  );
}
