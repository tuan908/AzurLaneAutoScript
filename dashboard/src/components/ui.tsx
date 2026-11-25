import { Button as SdkButton } from "@ui-sdk/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { twMerge } from "tailwind-merge";

const buttonStyles = cva(
  "inline-flex! items-center justify-center gap-1.5 rounded-alas-sm! border font-medium whitespace-nowrap transition-colors disabled:opacity-55",
  {
    variants: {
      variant: {
        outline: "border-edge-strong bg-panel text-ink hover:bg-panel-3",
        primary: "border-accent! bg-accent! text-on-accent! hover:bg-accent-strong!",
        danger: "border-bad! bg-bad! text-white! hover:brightness-95",
        ghost: "border-transparent! bg-transparent! text-secondary! hover:bg-panel-3!",
      },
      size: {
        default: "min-h-8.5 px-3.5",
        small: "min-h-7! px-2.5! text-[12.5px]!",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

type ButtonProps = Omit<ComponentProps<typeof SdkButton>, "className"> &
  VariantProps<typeof buttonStyles> & { className?: string };

export function Button({ variant, size, className, ...props }: ButtonProps) {
  return <SdkButton {...props} className={twMerge(buttonStyles({ variant, size }), className)} />;
}

export function Card({ heading, description, action, className, children }: {
  heading?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={twMerge("rounded-alas border border-edge bg-panel px-4.5 py-4 shadow-alas", className)}>
      {heading != null && (
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <h3>{heading}</h3>
          {description && <span className="text-xs text-subtle">{description}</span>}
          {action && <div className="ml-auto">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-alas border border-edge bg-panel px-4 py-3.5 shadow-alas">
      <dt className="text-xs font-medium text-subtle">{label}</dt>
      <dd className="mt-1 truncate text-xl font-semibold tracking-tight [&_small]:text-xs [&_small]:font-medium [&_small]:text-subtle">{children}</dd>
    </div>
  );
}

export function Banner({ tone, heading, action, children }: { tone: "bad" | "warn"; heading?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div
      className={twMerge("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-alas border px-3.5 py-3 text-[13px] text-ink",
        tone === "bad" ? "border-bad/30 bg-bad-soft" : "border-warn/30 bg-warn-soft")}
      role={tone === "bad" ? "alert" : "status"}
    >
      <div className="min-w-60 flex-1">
        {heading && <strong className="block">{heading}</strong>}
        {children}
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}

const paths = {
  play: "M5 3.5v9l7.5-4.5z",
  stop: "M4 4h8v8H4z",
  restart: "M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3",
  plus: "M8 3v10M3 8h10",
  download: "M8 2.5v8m0 0 3-3m-3 3-3-3M3 13.5h10",
};

export function Icon({ name }: { name: keyof typeof paths }) {
  const filled = name === "play" || name === "stop";
  return (
    <svg className="size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true" fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}

export function StatusBadge({ tone, pulse, large, children }: { tone: string; pulse?: boolean; large?: boolean; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap before:size-[7px] before:rounded-full before:bg-current ${tonePill(tone)} ${pulse ? "motion-safe:before:animate-pulse" : ""} ${large ? "h-7 px-3 text-[13px]" : "h-5.5 px-[9px] text-xs"}`}>{children}</span>;
}

export function toneDot(tone: string) { switch (tone) { case "ok": return "bg-ok"; case "warn": return "bg-warn"; case "bad": return "bg-bad"; case "accent": return "bg-accent"; default: return "bg-idle"; } }
function tonePill(tone: string) { switch (tone) { case "ok": return "bg-ok-soft text-ok"; case "warn": return "bg-warn-soft text-warn"; case "bad": return "bg-bad-soft text-bad"; case "accent": return "bg-accent-soft text-accent"; default: return "bg-idle-soft text-idle"; } }
