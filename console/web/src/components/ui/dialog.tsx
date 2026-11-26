import { Suspense, forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from "react";
import { reloadForNewBuild } from "@/lib/lazyPage";

/**
 * the dialog library (Radix's dialog, focus trap and scroll lock, about 15 KB compressed) is read the first time
 * any dialog opens, never with the inbox: a closed dialog draws nothing, so its code waits. The parts (ui/dialogParts)
 * keep their names and props; once read, every dialog draws at once, open or closed, so closing keeps its animation.
 */
type Parts = typeof import("./dialogParts");
let parts: Parts | undefined;
let failed = false;
let asked: Promise<Parts> | undefined;
export const loadDialogParts = (): Promise<Parts> =>
  (asked ??= import("./dialogParts").then(
    (m) => (parts = m),
    (err: unknown) => {
      asked = undefined; // the next open asks again
      throw err;
    },
  ));
/** an open dialog's wait: a failed read reloads once onto a new build (lib/lazyPage), else the dialog stays closed */
const openParts = (): Promise<Parts> =>
  loadDialogParts().catch((err: unknown) => {
    if (reloadForNewBuild()) return new Promise<never>(() => undefined);
    failed = true; // never asked again in a loop
    throw err;
  });

type DialogProps = ComponentPropsWithoutRef<Parts["Dialog"]> & { children?: ReactNode };
/** the real dialog, or (inside Suspense, fallback nothing) a wait for its parts */
function Real(props: DialogProps) {
  if (parts) return <parts.Dialog {...props} />;
  if (failed) return null;
  throw openParts();
}

export function Dialog(props: DialogProps) {
  // one shape from the first open on, so an open dialog never remounts (its focus and fields stay)
  if (!parts && !props.open) return null;
  return (
    <Suspense fallback={null}>
      <Real {...props} />
    </Suspense>
  );
}

// the parts below are drawn only inside an open Dialog, so the library is in by then
const need = (): Parts => {
  if (!parts) throw openParts();
  return parts;
};
export const DialogContent = forwardRef<ElementRef<Parts["DialogContent"]>, ComponentPropsWithoutRef<Parts["DialogContent"]>>((props, ref) => {
  const P = need();
  return <P.DialogContent ref={ref} {...props} />;
});
DialogContent.displayName = "DialogContent";
export const DialogTitle = forwardRef<ElementRef<Parts["DialogTitle"]>, ComponentPropsWithoutRef<Parts["DialogTitle"]>>((props, ref) => {
  const P = need();
  return <P.DialogTitle ref={ref} {...props} />;
});
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = forwardRef<ElementRef<Parts["DialogDescription"]>, ComponentPropsWithoutRef<Parts["DialogDescription"]>>((props, ref) => {
  const P = need();
  return <P.DialogDescription ref={ref} {...props} />;
});
DialogDescription.displayName = "DialogDescription";
export const DialogHeader = (props: HTMLAttributes<HTMLDivElement>) => {
  const P = need();
  return <P.DialogHeader {...props} />;
};
export const DialogFooter = (props: HTMLAttributes<HTMLDivElement>) => {
  const P = need();
  return <P.DialogFooter {...props} />;
};
