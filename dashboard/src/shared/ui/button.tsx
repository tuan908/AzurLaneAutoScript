import { Button as SdkButton } from "@ui-sdk/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

const buttonStyles = cva(
  "inline-flex! items-center justify-center gap-1.5 rounded-alas-sm! border font-medium whitespace-nowrap transition-[background-color,filter] active:brightness-95 disabled:opacity-45",
  {
    variants: {
      variant: {
        outline: "border-transparent! bg-fill! text-ink hover:bg-fill-strong!",
        primary: "border-accent-fill! bg-accent-fill! text-on-accent! hover:brightness-110",
        danger: "border-bad-fill! bg-bad-fill! text-white! hover:brightness-110",
        ghost: "border-transparent! bg-transparent! text-secondary! hover:bg-fill!",
      },
      size: {
        default: "min-h-8 px-3.5",
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
