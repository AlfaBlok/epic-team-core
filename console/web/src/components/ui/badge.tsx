import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        green: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        amber: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
        red: "border-transparent bg-red-500/15 text-red-700 dark:text-red-400",
        blue: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
        violet: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400",
        gray: "border-transparent bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
