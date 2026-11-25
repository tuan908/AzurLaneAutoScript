import type { ReactNode } from "react";

export function OptionRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-edge py-3 last-of-type:border-b-0 [&_label]:flex [&_label]:flex-col [&_label]:gap-0.5 [&_label]:text-[13px] [&_label]:font-semibold [&_label_span]:text-xs [&_label_span]:font-normal [&_label_span]:text-subtle [&_input[type=number]]:w-22.5">
      {children}
    </div>
  );
}
