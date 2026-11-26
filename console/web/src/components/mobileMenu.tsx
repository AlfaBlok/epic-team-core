import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/**
 * the phone's menu, a dialog, in its own script: the dialog library (about 15 KB compressed) left the app's main
 * script. The phone reads it with the sidebar's scripts once its inbox list is in (lib/sidebarScripts), before he opens it.
 */
export function MobileMenu({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* data-sidebar: the phone's menu is a dialog, and navigation keeps its own look (no link underline, polish.css) */}
      <SheetContent aria-describedby={undefined} className="overflow-hidden" data-sidebar="">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
