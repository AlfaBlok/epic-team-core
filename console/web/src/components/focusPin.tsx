import { Pin, PinOff } from "lucide-react";
import { api, type Milestone } from "@/api";
import { useQuery } from "@/lib/data";
import { milestoneName } from "@/lib/format";
import { nextFocusPosition } from "@/lib/bigRoots";
import { useFocusSave } from "@/lib/useFocusSave";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useWords } from "@/lib/skin";

/**
 * the milestone page header pins the milestone he is on to focus, or unpins it, without going to Team
 * home. Same list and order as Team home: the same milestone list, the same save path (useFocusSave → PATCH bigRoot → the
 * team-state writer's commit to state/big-roots.json); a pin goes to the end of the focus list. Both skins.
 * L-38: the button spins while saving, then the result shows right under it.
 */
export function FocusPinButton({ m }: { m: Milestone }) {
  const ms = useQuery(() => api.listMilestones(), []);
  const { list, roots, busy, pressed, note, setFocus } = useFocusSave(ms.data);
  const pinned = list ? roots.some((r) => r.id === m.id) : m.bigRoot != null;
  const name = milestoneName(m);
  const w = useWords();
  return (
    <>
      {pinned ? (
        <Button size="sm" variant="outline" disabled={busy || !list} pending={pressed === `${m.id}:unpin`} pendingLabel="Unpinning…" data-testid="header-focus-pin" title={`Take this ${w.milestone} out of the focus list on Team home`} onClick={() => setFocus(`${m.id}:unpin`, `${name} unpinned from focus`, [{ id: m.id, bigRoot: null }])}>
          <PinOff /> Unpin
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy || !list} pending={pressed === `${m.id}:pin`} pendingLabel="Pinning…" data-testid="header-focus-pin" title={`Add this ${w.milestone} at the end of the focus list on Team home`} onClick={() => setFocus(`${m.id}:pin`, `${name} pinned to focus at ${nextFocusPosition(list)}`, [{ id: m.id, bigRoot: nextFocusPosition(list) }])}>
          <Pin /> Pin to focus
        </Button>
      )}
      {note && (
        <span role="status" data-testid="header-focus-note" className={cn("basis-full text-xs sm:max-w-xs sm:text-right", note.ok ? "text-muted-foreground" : "text-destructive")}>
          {note.text}
        </span>
      )}
    </>
  );
}
