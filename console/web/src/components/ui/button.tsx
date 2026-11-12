import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { Check, Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** this click is running: spinner in place of the icon, `pendingLabel` ("Sending…") as the text, aria-busy, disabled. */
  pending?: boolean;
  pendingLabel?: React.ReactNode;
  /** this click was saved: a check and `savedLabel` ("Saved ✓") in green, disabled, until the card moves on. */
  saved?: boolean;
  savedLabel?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, pending, pendingLabel, saved, savedLabel, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    if (pending && !asChild)
      return (
        <Comp className={cn(buttonVariants({ variant, size, className }), "disabled:opacity-100")} ref={ref} {...props} disabled aria-busy="true" data-press="sending">
          <Loader2 className="animate-spin" data-testid="button-spinner" aria-hidden />
          {pendingLabel === undefined ? children : pendingLabel}
        </Comp>
      );
    if (saved && !asChild)
      return (
        <Comp
          className={cn(buttonVariants({ variant, size, className }), "border-transparent bg-emerald-600 text-white disabled:opacity-100")}
          ref={ref}
          {...props}
          disabled
          data-press="saved"
        >
          <Check aria-hidden />
          {savedLabel === undefined ? children : savedLabel}
        </Comp>
      );
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} disabled={disabled} {...props}>
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";
