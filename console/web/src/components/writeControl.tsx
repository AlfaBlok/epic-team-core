import { useState } from "react";
import { Pencil } from "lucide-react";
import { api, type Assignment, type Persona } from "@/api";
import { mutate } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useWords } from "@/lib/skin";
import { shorten } from "@/components/unblock";

// out of components/unblock, so the switch library loads with the goal page, never with the inbox.
/** Assignment row control: "Write: off" / "Write: on (scope…)", with the scope editable; revocable. */
export function WriteControl({ a, persona }: { a: Assignment; persona?: Persona }) {
  const w = useWords();
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState(a.writeScope ?? "");
  const [busy, setBusy] = useState(false);
  const on = !!a.writeEnabled;
  const save = async (patch: { writeEnabled?: boolean; writeScope?: string }) => {
    setBusy(true);
    try {
      await mutate(() => api.updateAssignment(a.id, patch));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1.5 grid min-w-0 gap-1 text-xs" data-testid="write-control">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-muted-foreground">
          <Switch
            aria-label={`Write on this ${w.milestone}`}
            checked={on}
            disabled={busy}
            onCheckedChange={(v) => (v && !(a.writeScope ?? "").trim() ? setEditing(true) : save({ writeEnabled: v }))}
          />
          <span className="font-medium text-foreground">Write: {on ? "on" : "off"}</span>
        </label>
        {on && (
          <span className="min-w-0 flex-1 break-words text-muted-foreground [overflow-wrap:anywhere]">
            scope: {a.writeScope ? shorten(a.writeScope, 120) : "—"}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          aria-label="Edit write scope"
          onClick={() => {
            setScope(a.writeScope ?? "");
            setEditing(true);
          }}
        >
          <Pencil /> scope
        </Button>
        {persona?.mayWrite && !on && <span className="text-muted-foreground">(persona default is write; this switch decides)</span>}
      </div>
      {editing && (
        <div className="grid gap-1.5">
          <textarea
            aria-label="Write scope"
            className="min-h-16 rounded-md border bg-background p-2 text-sm max-sm:text-base"
            placeholder="e.g. git only: branches one-logger*, spine main-direct; no prod/root"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !scope.trim()}
              pending={busy}
              pendingLabel="Saving…"
              onClick={async () => {
                await save({ writeScope: scope.trim(), writeEnabled: true });
                setEditing(false);
              }}
            >
              Save and turn on
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
