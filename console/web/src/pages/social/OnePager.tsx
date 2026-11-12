import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageCircle } from "lucide-react";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import { ONE_PAGER_KEYS, type OnePager, type OnePagerKey, type OnePagerPart } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { mutate } from "@/lib/data";
import { useSocial, worldId } from "@/lib/useSocial";

/**
 * the campaign one-pager, the first parts of the campaign spine's
 * `## Campaign plan`, on top of its Brief & directions tab. the owner owns every line: Save commits them as him. "Draft it
 * with me" asks the campaign's chat (its Repo desk) to draft it; the desk holds the draft for him as a review card, and
 * it shows here marked as a draft until he approves it there or saves it here. Agents never write his lines.
 */
export const DRAFT_SEED = "Help me draft this campaign's one-pager.";

const HINTS: Record<OnePagerPart, { hint: string; rows: number }> = {
  "Why this campaign": { hint: "What it is and what changes if it works: one sentence, your intent", rows: 2 },
  "The bet": { hint: "The strategy in 2-3 lines: what we do and why it should work", rows: 3 },
  "What we measure": { hint: "Leading signals each week, and the result", rows: 3 },
  "What we hope": { hint: "Numbers by the end, said plainly as hopes: followers, traction", rows: 3 },
  "My calls": { hint: "How you decide: the patterns behind your Approves and Revises, one per line", rows: 4 },
  "Not doing": { hint: "What this campaign will not do", rows: 2 },
  Approval: { hint: "One line: what waits for your Approve, from your hold rules", rows: 2 },
};

const KEYS = Object.entries(ONE_PAGER_KEYS) as [OnePagerKey, OnePagerPart][];
type Form = Record<OnePagerKey, string>;
const formOf = (f: Partial<Record<OnePagerPart, string>>): Form => Object.fromEntries(KEYS.map(([k, part]) => [k, f[part] ?? ""])) as Form;

/** The plan Markdown without the one-pager parts and the held draft (shown above it in their own block). */
export function planWithoutOnePager(plan: string): string {
  const drop = new Set([...Object.values(ONE_PAGER_KEYS), "One-pager draft"].map((h) => h.toLowerCase()));
  const parts = plan.split(/^(?=###[ \t]+)/m);
  return parts
    .filter((p) => {
      const h = /^###[ \t]+(.+?)[ \t]*$/m.exec(p);
      return !(h && p.startsWith("###") && drop.has(h[1].trim().toLowerCase()));
    })
    .join("")
    .replace(/^\s*(?:[-*]\s*)?One-pager:.*\n?/im, "")
    .replace(/^\s*(?:[-*]\s*)?Deck:.*\n?/im, "")
    .trim();
}

/** "drafted by X on D from Y." from the draft's note (its row and the "not his decision" sentence are said around it). */
export const draftedBy = (note: string) => {
  const m = /drafted by (.+?)(?:\.\s+Not his decision.*)?$/is.exec(note.trim());
  return m ? `Drafted by ${m[1].replace(/\.$/, "")}.` : note;
};

export function OnePagerPanel({ card, milestoneId }: { card: CampaignCard; milestoneId: string }) {
  const { data } = useSocial();
  const navigate = useNavigate();
  const [saved, setSaved] = useState<OnePager>();
  const op: OnePager | undefined = saved ?? data?.campaign?.onePager;
  const draft = op?.draft ?? null;
  // The form starts from the held draft when there is one (the newest proposal), else his own lines.
  const base = useMemo(() => formOf(draft?.fields ?? op?.fields ?? {}), [draft, op]);
  const [form, setForm] = useState<Form>(base);
  const baseKey = JSON.stringify(base);
  useEffect(() => setForm(base), [baseKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = KEYS.some(([k]) => form[k] !== formOf(op?.fields ?? {})[k]);
  const [busy, setBusy] = useState<"save" | "draft">();
  const [note, setNote] = useState<{ ok: boolean; text: string; at: "save" | "draft" }>();

  const save = async () => {
    setBusy("save");
    setNote(undefined);
    try {
      const r = await mutate(async () => api.saveOnePager(await worldId(), milestoneId, form));
      if (r.onePager) setSaved(r.onePager);
      setNote({ ok: true, at: "save", text: `Saved as yours${r.commit ? ` · commit ${r.commit.slice(0, 7)}` : ""}${r.closedDraft ? ` · draft ${r.closedDraft} closed` : ""}. Its personas work to it from their next wake.` });
    } catch (e) {
      setNote({ ok: false, at: "save", text: `Not saved: ${(e as Error).message}` });
    } finally {
      setBusy(undefined);
    }
  };

  const draftWithMe = async () => {
    setBusy("draft");
    setNote(undefined);
    try {
      await api.sendMilestoneChatMessage(milestoneId, DRAFT_SEED, `${card.campaign?.name ?? card.repo} · Brief & directions`, `onepager-seed:${milestoneId}:${Date.now()}`);
      navigate(`/milestones/${encodeURIComponent(milestoneId)}?tab=chat`);
    } catch (e) {
      setNote({ ok: false, at: "draft", text: `The chat did not take it: ${(e as Error).message}` });
      setBusy(undefined);
    }
  };

  // a one-pager folded into the campaign's product deck is a single line here, pointing to the Product tab.
  if (op?.moved)
    return (
      <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm" data-testid="onepager-moved">
        This campaign's one-pager moved into its one deck:{" "}
        <Link to={`/milestones/${encodeURIComponent(milestoneId)}?tab=product`} className="font-medium text-primary underline underline-offset-4">
          open the Product tab
        </Link>
        .
      </p>
    );

  const status = (at: "save" | "draft") =>
    note?.at === at ? (
      <span role="status" className={note.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"} data-testid={`onepager-${at}-note`}>
        {note.text}
      </span>
    ) : null;

  return (
    <section className={`grid gap-3 rounded-lg border p-4 ${draft ? "border-amber-500/60" : ""}`} data-testid="campaign-onepager">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold">Campaign one-pager</h2>
        <span className="text-xs text-muted-foreground">
          <span className="font-mono">{card.campaign?.path}</span> · you own every line
        </span>
        {card.campaign?.deck && (
          // the campaign's strategy deck, a plain link in this tab (L-5: no new tab).
          <a href={card.campaign.deck} className="text-sm font-medium text-primary underline underline-offset-4" data-testid="campaign-deck-link">
            Strategy deck
          </a>
        )}
        <span className="flex flex-col items-end gap-1">
          <Button size="sm" variant="outline" onClick={draftWithMe} pending={busy === "draft"} pendingLabel="Opening the chat…" data-testid="onepager-draft-with-me" title="Opens this campaign's Chat with the draft request">
            <MessageCircle /> Draft it with me
          </Button>
          {status("draft")}
        </span>
      </div>
      {draft ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200" data-testid="onepager-draft-banner">
          <span className="font-medium">Draft, not yours yet{draft.row ? ` (${draft.row})` : ""}.</span> {draftedBy(draft.note)} It waits on your review list: Approve makes it yours, or change it here and Save.
        </div>
      ) : op?.state === "empty" ? (
        <p className="text-sm text-muted-foreground" data-testid="onepager-empty">
          No one-pager yet. Draft it with me opens this campaign's chat: the desk reads the plan, the brief, the last 14 days of posts and your notes, asks you at most five questions, and holds a draft for your review.
        </p>
      ) : op?.line ? (
        <p className="text-xs text-muted-foreground" data-testid="onepager-line">
          {op.line}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {KEYS.map(([k, part]) => (
          <label key={k} className={`grid min-w-0 gap-1 text-sm ${k === "bet" || k === "calls" ? "md:col-span-2" : ""}`}>
            <span className="font-medium">
              {part}
              {draft?.fields[part] && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-800 dark:text-amber-300">draft</span>}
            </span>
            <span className="text-xs text-muted-foreground">{HINTS[part].hint}</span>
            <Textarea autoGrow aria-label={part} rows={HINTS[part].rows} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} data-testid={`onepager-${k}`} />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status("save")}
        <Button size="sm" onClick={save} disabled={!!busy || (!changed && !draft)} pending={busy === "save"} pendingLabel="Saving…" data-testid="onepager-save">
          {draft ? "Save as mine" : "Save"}
        </Button>
      </div>
    </section>
  );
}
