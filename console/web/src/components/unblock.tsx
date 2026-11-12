import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { KeyRound, Pencil } from "lucide-react";
import { api, jobActive, type Assignment, type NeedsOwner, type Persona, type Run, type WaitingItem } from "@/api";
import { mutate } from "@/lib/data";
import { cn } from "@/lib/utils";
import { ChatMarkdown, hasTable } from "@/lib/chatMarkdown";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWords } from "@/lib/skin";

// ----------: summaries that stay inside their card ----------

/** DOM id of a "Waiting on you" card, so other views can link to it (`?tab=waiting&item=<id>`). */
export const waitingAnchor = (itemId: string) => `waiting-${itemId}`;
export const waitingItemHref = (milestoneId: string, itemId: string) =>
  `/milestones/${encodeURIComponent(milestoneId)}?tab=waiting&item=${encodeURIComponent(itemId)}`;

/** One line of at most `max` chars, cut at a word boundary (same rule as the server's `shorten`). */
export function shorten(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, "") + "…";
}

const NJ_ID = /\bnj_[0-9a-f][0-9a-f-]*/g;

/** Text with bare `nj_…` ids turned into links to their Waiting-on-you card (plain text inside another link). */
export function Linkified({ text, milestoneId, links = true }: { text: string; milestoneId?: string; links?: boolean }) {
  if (!milestoneId || !links) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(NJ_ID)) {
    out.push(text.slice(last, m.index));
    out.push(
      <Link key={m.index} className="font-mono text-sky-700 hover:underline dark:text-sky-400" to={waitingItemHref(milestoneId, m[0])}>
        {m[0]}
      </Link>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</>;
}

/**
 * A run/assignment summary: wraps (long tokens break) and clamps to `lines`; "show more" when it was clamped.
 * Safe inside a card that is a link: the toggle does not follow it.
 * opened, a summary that holds a Markdown table renders it (ChatMarkdown) instead of raw pipes.
 */
export function ClampText({
  text,
  lines = 2,
  milestoneId,
  links = true,
  className,
}: {
  text: string;
  lines?: 1 | 2 | 3;
  milestoneId?: string;
  links?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open, lines]);
  const clamp = lines === 1 ? "line-clamp-1" : lines === 3 ? "line-clamp-3" : "line-clamp-2";
  return (
    <span className={cn("block min-w-0 max-w-full", className)} data-testid="clamp-text">
      <span ref={ref} title={text} className={cn("block min-w-0 whitespace-pre-line break-words [overflow-wrap:anywhere]", !open && clamp)}>
        {/* a summary with a Markdown table shows it as a table once opened (closed it stays the clamped lines) */}
        {open && hasTable(text) ? <ChatMarkdown text={text} /> : <Linkified text={text} milestoneId={milestoneId} links={links} />}
      </span>
      {(clamped || open) && (
        <button
          type="button"
          className="text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? "show less" : "show more"}
        </button>
      )}
    </span>
  );
}

// ----------: a blocked run shows how to unblock it ----------

/** heuristic: a Needs the owner item that asks for write access (question or proposed action). */
export const isWriteAsk = (i: { question?: string; proposedAction?: string }) =>
  /may ?write|write (access )?(to|on|in) git|git[- ]only write|write scope|write access|write permission/i.test(`${i.question ?? ""}\n${i.proposedAction ?? ""}`);

/**
 * Open Needs the owner items raised by this assignment's runs: each as a link to its Waiting-on-you card, its question
 * (short) and a bold "To unblock" line; write asks can be granted here. Headed "Blocked on you" while the last run
 * is blocked; items a later run moved past stay listed (still open) until the owner answers them.
 */
export function BlockedBy({
  last,
  runs,
  needsOwner,
  milestoneId,
}: {
  last?: Run;
  runs: Run[];
  needsOwner: NeedsOwner[];
  milestoneId: string;
}) {
  const [grant, setGrant] = useState<NeedsOwner>();
  if (!last) return null;
  const mine = new Set(runs.filter((r) => r.assignmentId === last.assignmentId).map((r) => r.id));
  const items = needsOwner.filter((n) => n.status === "open" && n.runId && mine.has(n.runId));
  if (items.length === 0) return null;
  const blocked = last.outcome === "blocked";
  return (
    <div
      className={cn("mt-2 grid gap-2 rounded-md border p-2.5 text-xs", blocked ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5")}
      data-testid="blocked-by"
    >
      <div className={cn("font-medium", blocked ? "text-red-700 dark:text-red-400" : "text-amber-800 dark:text-amber-300")}>
        {blocked ? `Blocked on you (${items.length}):` : `Still open from earlier runs (${items.length}):`}
      </div>
      <ul className="grid gap-2">
        {items.map((n) => (
          <li key={n.id} className="grid min-w-0 gap-0.5">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              <Link className="font-mono text-sky-700 hover:underline dark:text-sky-400" to={waitingItemHref(milestoneId, n.id)}>
                {n.id}
              </Link>{" "}
              <span className="text-muted-foreground">{shorten(n.question, 140)}</span>
            </span>
            {n.proposedAction && <span className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">To unblock: {shorten(n.proposedAction, 160)}</span>}
            {isWriteAsk(n) && (
              <span>
                <Button size="sm" variant="outline" className="h-7" onClick={() => setGrant(n)}>
                  <KeyRound /> Approve and grant write
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {grant && (
        <GrantWriteDialog
          open
          onOpenChange={(o) => !o && setGrant(undefined)}
          itemId={grant.id}
          milestoneId={milestoneId}
          question={grant.question}
          proposedAction={grant.proposedAction}
        />
      )}
    </div>
  );
}

// ----------: per-assignment write ----------

/** "Approve and grant write": approve the item and give the asking assignment write, limited to the scope typed here. */
export function GrantWriteDialog({
  open,
  onOpenChange,
  itemId,
  milestoneId,
  question,
  proposedAction,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  itemId: string;
  milestoneId: string;
  question: string;
  proposedAction?: string;
}) {
  const w = useWords();
  const [scope, setScope] = useState(proposedAction ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await mutate(() => api.respondToWaiting(itemId, { kind: "approve", text: note, milestoneId, grantWrite: { scope: scope.trim() } }));
      if (r.delivery !== "sent" && !jobActive(r)) setError(`Granted and approved; message not delivered: ${r.job?.error ?? r.deliveryError ?? r.delivery}`);
      else onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Approve and grant write</DialogTitle>
          <DialogDescription className="break-words">{shorten(question, 200)}</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Write scope</span>
          <textarea
            aria-label="Write scope"
            className="min-h-20 rounded-md border bg-background p-2 text-sm max-sm:text-base"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            Only this persona on this {w.milestone}. It may write only within this scope; anything outside it (prod, root, deploys, other repos) still comes to you. Revocable in the Personas tab.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Note (optional)</span>
          <input aria-label="Note" className="h-9 rounded-md border bg-background px-2 text-sm max-sm:text-base" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <div className="text-xs text-red-700 dark:text-red-400">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !scope.trim()} pending={busy} pendingLabel="Granting…" onClick={confirm}>
            <KeyRound /> Approve and grant write
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Extra action on a Waiting-on-you card for a write ask. */
export function GrantWriteAction({ item }: { item: WaitingItem }) {
  const [open, setOpen] = useState(false);
  if (item.source !== "needs_jordi" || item.state !== "open" || !isWriteAsk(item)) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <KeyRound /> Approve and grant write
      </Button>
      {open && (
        <GrantWriteDialog
          open
          onOpenChange={setOpen}
          itemId={item.id}
          milestoneId={item.milestoneId}
          question={item.question}
          proposedAction={item.proposedAction}
        />
      )}
    </>
  );
}

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
