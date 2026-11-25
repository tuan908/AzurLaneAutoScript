import type { ReactNode } from "react";

export function StatusBadge({
  tone,
  pulse,
  large,
  children,
}: {
  tone: string;
  pulse?: boolean;
  large?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap before:size-1.75 before:rounded-full before:bg-current ${tonePill(tone)} ${pulse ? "motion-safe:before:animate-pulse" : ""} ${large ? "h-7 px-3 text-[13px]" : "h-5.5 px-2.25 text-xs"}`}
    >
      {children}
    </span>
  );
}

export function toneDot(tone: string) {
  switch (tone) {
    case "ok":
      return "bg-ok";
    case "warn":
      return "bg-warn";
    case "bad":
      return "bg-bad";
    case "accent":
      return "bg-accent";
    default:
      return "bg-idle";
  }
}
function tonePill(tone: string) {
  switch (tone) {
    case "ok":
      return "bg-ok-soft text-ok";
    case "warn":
      return "bg-warn-soft text-warn";
    case "bad":
      return "bg-bad-soft text-bad";
    case "accent":
      return "bg-accent-soft text-accent";
    default:
      return "bg-idle-soft text-idle";
  }
}
