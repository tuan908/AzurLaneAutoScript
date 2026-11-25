import type { ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { toneDot } from "./status-badge";

export function Chip({ tone, className, title, children }: {
  tone?: "ok" | "warn" | "bad";
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={twMerge("inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-panel-2 px-2.5 text-[12.5px] text-secondary [&_strong]:font-semibold [&_strong]:text-ink", className)}
    >
      {tone && <span className={`inline-block size-2 shrink-0 rounded-full ${toneDot(tone)}`} />}
      {children}
    </span>
  );
}
