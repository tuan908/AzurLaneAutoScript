import type { ReactNode } from "react";
import { twMerge } from "tailwind-merge";

export function Banner({
  tone,
  heading,
  action,
  children,
  announce = true,
}: {
  tone: "bad" | "warn";
  heading?: string;
  action?: ReactNode;
  children: ReactNode;
  announce?: boolean;
}) {
  return (
    <div
      className={twMerge(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-alas border px-3.5 py-3 text-[13px] text-ink",
        tone === "bad" ? "border-bad/30 bg-bad-soft" : "border-warn/30 bg-warn-soft",
      )}
      role={announce ? (tone === "bad" ? "alert" : "status") : undefined}
    >
      <div className="min-w-60 flex-1">
        {heading && <strong className="block">{heading}</strong>}
        {children}
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}
