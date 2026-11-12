import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, type WaitingItem } from "@/api";
import { invalidate, mutate } from "@/lib/data";
import { relayOf, snoozeItem, unsnoozeItem } from "@/lib/snooze";
import { showClosed } from "@/lib/afterClose";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { askLead, projectLabel } from "@/lib/askLead";

/**
 * when one persona (the Advisor) has a set of recommendations in his inbox,
 * one "Accept all" for the set, next to accept one, ask a question back or say no on each. Every accept becomes a ready
 * row the team delivers (the approve goes with `asRow`: the console adds the row in the ask's spine, his accept the ready
 * stamp, root L-37). A set is two or more open approve asks a persona's own run wrote (`asker.via` ask or run, never the
 * milestone owner by default), so only asks that reached his list ('s gate runs first) are in one.
 */
export interface AskSetGroup {
  persona: string;
  items: WaitingItem[];
}

/**
 * An open approve ask a persona wrote: what a set is made of. One he just answered here stays in its set (its answer is
 * stored, the job writing it) so the set does not fall apart under his presses: its row shows what he pressed.
 */
export function inSet(i: WaitingItem): boolean {
  return (
    i.source === "ask" &&
    i.state === "open" &&
    i.ask === "approve" &&
    (!i.response || i.response.kind === "approve" || i.response.kind === "deny" || i.response.kind === "feedback") &&
    !i.secret &&
    !i.decidedBy &&
    !!i.asker?.personaName &&
    i.asker.via !== "owner"
  );
}

/** The sets in `cards` (two or more from one persona), in the order their first ask comes. */
export function askSets(cards: WaitingItem[]): AskSetGroup[] {
  const by = new Map<string, WaitingItem[]>();
  for (const i of cards) if (inSet(i)) by.set(i.asker!.personaName!, [...(by.get(i.asker!.personaName!) ?? []), i]);
  return [...by].filter(([, l]) => l.length >= 2).map(([persona, items]) => ({ persona, items }));
}

/** The one line he reads, as's cards say it (lib/askLead): what he approves, without "You approve:". */
export function setLine(i: WaitingItem): string {
  return askLead(i).what.replace(/\?$/, "");
}

/** The why in one line, as's cards say it: the ask's own `Why:`, else its why the owner, impact or context. */
export function setWhy(i: WaitingItem): string | undefined {
  return askLead(i).why || undefined;
}

type Done = { kind: "approve" | "feedback" | "deny"; error?: string };

const approve = (i: WaitingItem) => mutate(() => api.respondToWaiting(i.id, { kind: "approve", text: "", milestoneId: i.milestoneId, wake: true, asRow: true, ...relayOf(i) }));

export function AskSet({ group, readOnly }: { group: AskSetGroup; readOnly?: string }) {
  const [done, setDone] = useState<Record<string, Done>>({});
  const [busy, setBusy] = useState<string>();
  const [progress, setProgress] = useState<string>();
  // what he pressed: this page's press, else the answer stored for it (the list refreshed since, or another device)
  const pressed = (i: WaitingItem): Done | undefined => done[i.id] ?? (i.response ? { kind: i.response.kind as Done["kind"], ...(i.response.spine && i.response.spine.status !== "written" ? { error: i.response.spine.reason ?? "not written in the project" } : {}) } : undefined);
  const left = group.items.filter((i) => !pressed(i) || pressed(i)!.error);

  const press = async (i: WaitingItem, kind: Done["kind"], text = "") => {
    setBusy(i.id);
    try {
      if (kind === "approve") await approve(i);
      else await mutate(() => api.respondToWaiting(i.id, { kind, text, milestoneId: i.milestoneId, wake: true, ...relayOf(i) }));
      setDone((d) => ({ ...d, [i.id]: { kind } }));
    } catch (e) {
      setDone((d) => ({ ...d, [i.id]: { kind, error: (e as Error).message } }));
    } finally {
      setBusy(undefined);
      invalidate("inbox");
    }
  };

  const acceptAll = async () => {
    setBusy("all");
    const list = left;
    let n = 0;
    for (const i of list) {
      setProgress(`Accepting ${++n} of ${list.length}…`);
      try {
        await approve(i);
        setDone((d) => ({ ...d, [i.id]: { kind: "approve" } }));
      } catch (e) {
        setDone((d) => ({ ...d, [i.id]: { kind: "approve", error: (e as Error).message } }));
      }
    }
    setProgress(undefined);
    setBusy(undefined);
    invalidate("inbox");
  };

  // "Not now": every ask of the set snoozed for 3 days (only asks written in a spine can be).
  const snoozable = left.filter((i) => i.source === "ask" && i.state === "open" && !!i.path);
  const notNow = () => {
    for (const i of snoozable) void snoozeItem(i, { days: 3 });
    showClosed({ said: "Snoozed", title: `The ${group.persona}'s ${group.items.length} recommendations`, back: async () => (await Promise.all(snoozable.map((i) => unsnoozeItem(i))), { back: true, line: "They are back in your inbox." }) });
  };
  const project = projectLabel(group.items[0]?.milestoneTitle);
  // one quiet card, Accept all or Not now.
  return (
    <section className="grid min-w-0 grid-cols-1 rounded-xl border bg-card p-4 [overflow-wrap:anywhere]" data-testid="ask-set" data-persona={group.persona}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Approve</span>
        {project && <span>{project}</span>}
        <span>
          {group.items.length} from the {group.persona}
        </span>
      </div>
      <h3 className="mt-1.5 text-[15px] font-medium leading-snug text-foreground">
        The {group.persona}&apos;s {group.items.length} recommendations
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-foreground/85">Accept all, or say no to one below.</p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Why: each one you accept becomes a ready task the team delivers.</p>
      {progress && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="accept-all-progress">
          {progress}
        </p>
      )}
      <ol className="mt-2.5 list-decimal pl-5 text-sm text-foreground/85">
        {group.items.map((i) => (
          <SetRow key={i.id} item={i} done={pressed(i)} busy={busy} readOnly={readOnly} onPress={press} />
        ))}
      </ol>
      {!readOnly && left.length > 0 && (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button size="sm" className={cn("flex-1 sm:flex-none", PHONE_TAP)} disabled={!!busy} onClick={() => void acceptAll()} data-testid="accept-all">
            {busy === "all" && <Loader2 className="animate-spin" />} Accept all {left.length}
          </Button>
          {snoozable.length > 0 && (
            <Button size="sm" variant="outline" className={cn("flex-1 sm:flex-none", PHONE_TAP)} disabled={!!busy} onClick={notNow} data-testid="ask-set-not-now">
              Not now
            </Button>
          )}
        </div>
      )}
      <div className="mt-3 text-xs text-muted-foreground">{[project, `from the ${group.persona}`].filter(Boolean).join(" · ")}</div>
    </section>
  );
}

function SetRow({
  item: i,
  done,
  busy,
  readOnly,
  onPress,
}: {
  item: WaitingItem;
  done?: Done;
  busy?: string;
  readOnly?: string;
  onPress: (i: WaitingItem, kind: Done["kind"], text?: string) => Promise<void>;
}) {
  const [box, setBox] = useState<"feedback" | "deny">();
  const [words, setWords] = useState("");
  const why = setWhy(i);
  const settled = done && !done.error;
  const working = busy === i.id || (busy === "all" && !done);
  const quiet = "h-auto p-0 text-xs font-normal text-muted-foreground underline decoration-foreground/25 underline-offset-[3px] hover:text-foreground";
  return (
    <li className="py-1.5" data-testid="ask-set-row" data-code={i.code}>
      <div className="min-w-0">
        <p className="leading-relaxed text-foreground/85">{setLine(i)}</p>
        {why && <p className="text-[13px] text-muted-foreground">Why: {why}</p>}
      </div>
      {settled ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="ask-set-done">
          {done.kind === "approve" ? "✓ Accepted: it becomes a ready row" : done.kind === "deny" ? "✗ Said no" : "? Question sent to " + (i.asker?.personaName ?? "the team")}
        </p>
      ) : readOnly ? null : box ? (
        <div className="mt-1.5 grid gap-2">
          <textarea
            className="min-h-14 w-full rounded-md border bg-background p-2 text-sm"
            placeholder={box === "feedback" ? "Your question" : "Why not (optional)"}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            autoFocus
            data-testid="ask-set-words"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className={PHONE_TAP} disabled={!!busy || (box === "feedback" && !words.trim())} onClick={() => void onPress(i, box, words.trim()).then(() => setBox(undefined))} data-testid="ask-set-send">
              {working && <Loader2 className="animate-spin" />} {box === "deny" ? "Say no" : "Send question"}
            </Button>
            <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => setBox(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="ghost" className={quiet} disabled={!!busy} onClick={() => void onPress(i, "approve")} data-testid="ask-set-accept">
            {working && <Loader2 className="animate-spin" />} Accept
          </Button>
          <Button size="sm" variant="ghost" className={quiet} disabled={!!busy} onClick={() => setBox("feedback")} data-testid="ask-set-ask">
            Ask a question
          </Button>
          <Button size="sm" variant="ghost" className={quiet} disabled={!!busy} onClick={() => setBox("deny")} data-testid="ask-set-no">
            No
          </Button>
        </div>
      )}
      {done?.error && (
        <p className="text-sm text-destructive" data-testid="ask-set-error">
          Not sent: {done.error}
        </p>
      )}
    </li>
  );
}
