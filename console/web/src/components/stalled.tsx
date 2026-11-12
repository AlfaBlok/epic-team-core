import { useState } from "react";
import { api, type PendingItem } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { mutate } from "@/lib/data";
import { useWords } from "@/lib/skin";

/**
 * the Stalled pending line's actions, under the header strip. Switch on the suggested persona (the same
 * assignment toggle as the Personas tab, so the cycle sync starts its cadence; confirmed first, since it starts
 * write-capable agents), or pause the milestone. Orange, never red: Stalled is an alarm, not an ask.
 */
export function StalledActions({ item }: { item: PendingItem }) {
  const target = item.switchOn?.[0];
  const w = useWords();
  const [confirm, setConfirm] = useState<"on" | "pause">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await mutate<unknown>(() => (confirm === "on" && target ? api.updateAssignment(target.assignmentId, { enabled: true }) : api.updateMilestone(item.milestoneId, { paused: true })));
      setConfirm(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="stalled-item">
      <span className="inline-flex items-center rounded-full bg-orange-500 px-2 py-0.5 font-semibold text-white">Stalled</span>
      <span className="min-w-0 text-orange-800 dark:text-orange-300">{item.title}</span>
      {target && (
        <Button size="sm" className="h-7 bg-orange-600 text-white hover:bg-orange-700" onClick={() => setConfirm("on")}>
          Switch on {target.persona}
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-7" onClick={() => setConfirm("pause")}>
        Pause the {w.milestone}
      </Button>
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(undefined)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm === "on" ? `Switch on ${target?.persona}?` : `Pause the ${w.milestone}?`}</DialogTitle>
            <DialogDescription>
              {confirm === "on"
                ? `${target?.persona} starts waking on its cadence and works the ready steps; its wakes may launch write-capable agents within its write rule.`
                : "No persona wakes on it until you resume it. The ready steps stay where they are."}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(undefined)}>
              Cancel
            </Button>
            <Button disabled={busy} pending={busy} pendingLabel={confirm === "on" ? "Switching on…" : "Pausing…"} onClick={() => void act()}>
              {confirm === "on" ? "Switch on" : "Pause"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
