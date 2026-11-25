import type { ReactNode } from "react";
import { twMerge } from "tailwind-merge";

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
