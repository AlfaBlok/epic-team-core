import { ChevronDown } from "lucide-react";
import { MILESTONE_PAGE } from "@/lib/bigRoots";
import { cn } from "@/lib/utils";
import { useWords } from "@/lib/skin";

/** the line under a milestone list cut at about 20: "Load more" shows the next 20 (or what is left). */
export function LoadMore({ hidden, onMore, className, testId = "load-more" }: { hidden: number; onMore: () => void; className?: string; testId?: string }) {
  const w = useWords();
  if (hidden <= 0) return null;
  const next = Math.min(MILESTONE_PAGE, hidden);
  return (
    <button
      type="button"
      className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground", className)}
      data-testid={testId}
      title={`${hidden} more ${hidden === 1 ? w.milestone : w.milestonesWord} below, in priority order`}
      onClick={onMore}
    >
      <ChevronDown className="h-4 w-4" />
      Load more ({next === hidden ? hidden : `${next} of ${hidden}`})
    </button>
  );
}
