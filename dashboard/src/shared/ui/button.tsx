import { Button as SdkButton } from "@ui-sdk/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
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
