import { useState } from "react";
import { OctagonX, Plus, Send } from "lucide-react";
import type { Run } from "@/api";
import { Button } from "@/components/ui/button";
import { AddDialog, SteerDialog, StopDialog } from "@/components/dialogs";
import { cn } from "@/lib/utils";

/**
 * Steer and Stop on a running run, a persona wake or a child worker. `workers` = running child runs of this
 * one (Stop offers "and its workers" when there are some). Wraps on a phone (412 px). Nothing renders for a finished run.
 */
export function RunControls({ run, workers = 0, who, className }: { run: Run; workers?: number; who?: string; className?: string }) {
  const [steering, setSteering] = useState(false);
  const [stopping, setStopping] = useState(false);
  if (run.outcome !== "running") return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)} data-testid="run-controls">
      <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setSteering(true)} disabled={!run.threadId} title={run.threadId ? undefined : "No thread yet to steer"}>
        <Send className="h-3.5 w-3.5" /> Steer
      </Button>
      <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-red-700 dark:text-red-400" onClick={() => setStopping(true)} disabled={!run.threadId} title={run.threadId ? undefined : "No thread yet to stop"}>
        <OctagonX className="h-3.5 w-3.5" /> Stop
      </Button>
      <SteerDialog open={steering} onOpenChange={setSteering} run={run} personaName={who} />
      <StopDialog open={stopping} onOpenChange={setStopping} run={run} workers={workers} who={who} />
    </span>
  );
}

/** Add (a row, Done-means line or child epic) on a spine node of the tree; ready unless "Just register it". */
export function AddButton({ milestoneId, path, nodeTitle, className }: { milestoneId: string; path?: string; nodeTitle?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={className}>
      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setOpen(true)} data-testid="tree-add" title="Add a row, Done-means line or child epic here (ready: the Delivery manager works it)">
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
      <AddDialog open={open} onOpenChange={setOpen} milestoneId={milestoneId} path={path} nodeTitle={nodeTitle} />
    </span>
  );
}
