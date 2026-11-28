import { useEffect, useMemo, useState } from "react";
import { api, type SocialData, type SocialWriteAction } from "@/api";
import { useSocial } from "@/lib/useSocial";
import {
  countIdeas,
  filterIdeas,
  IDEA_FILTERS,
  ideaViews,
  isUrl,
  monthRows,
  prioritiesBody,
  weekRows,
  writeIssues,
  type IdeaFilter,
  type IdeaView,
  type MonthRow,
  type WeekRow,
} from "@/lib/ideas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { cn } from "@/lib/utils";
import { ownerName } from "@/lib/identity";
import { IDEAS_PATH } from "@/lib/routePaths";
export { IDEAS_PATH };

/** route of "My ideas & priorities" (social skin, lib/skin.tsx "ideas"). */
export const IDEAS_LABEL = "Ideas & priorities";

/** Pack issue lines (422) or the error, shown right where the write was made. */
function Issues({ lines, testId }: { lines: string[]; testId: string }) {
  if (!lines.length) return null;
  return (
    <ul data-testid={testId} className="mt-2 grid gap-0.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
      {lines.map((l, i) => (
        <li key={i} className="break-words">
          {l}
        </li>
      ))}
    </ul>
  );
}

const STATE_TONE: Record<string, string> = {
  new: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  "picked up": "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  drafted: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  posted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  parked: "bg-muted text-muted-foreground",
  epic: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400",
};

function StateChip({ state }: { state: string }) {
  return <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium", STATE_TONE[state] ?? "bg-muted")}>{state}</span>;
}

/** What became of it: each post it became (links to the live post), else the why or who acts next. */
function Became({ idea }: { idea: IdeaView }) {
  if (idea.became.length)
    return (
      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
        {idea.became.map((b) =>
          b.link ? (
            <a key={b.id} href={b.link} target="_blank" rel="noreferrer" className="underline" data-testid={`became-${b.id}`}>
              {b.id} → {b.status || "?"} ↗
            </a>
          ) : (
            <span key={b.id} data-testid={`became-${b.id}`}>
              {b.id} → {b.status || "?"}
            </span>
          ),
        )}
      </span>
    );
  if (idea.why) return <span className="text-muted-foreground">why: {idea.why}</span>;
  if (idea.shown === "new") return <span className="text-muted-foreground">the Writer picks it up on a next wake</span>;
  return <span className="text-muted-foreground">—</span>;
}

interface IdeaFields {
  idea: string;
  format: string;
  platform: string;
  link: string;
}
const EMPTY_IDEA: IdeaFields = { idea: "", format: "", platform: "", link: "" };
const nullable = (s: string) => (s.trim() ? s.trim() : null);

function IdeaInputs({ v, set, prefix }: { v: IdeaFields; set: (v: IdeaFields) => void; prefix: string }) {
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-[2fr_1fr_1fr_1.5fr]">
      <Input aria-label={`${prefix} idea`} value={v.idea} onChange={(e) => set({ ...v, idea: e.target.value })} placeholder="A line, a link or an asset id" />
      <Input aria-label={`${prefix} format`} value={v.format} onChange={(e) => set({ ...v, format: e.target.value })} placeholder="Format (text, thread…)" />
      <Input aria-label={`${prefix} platform`} value={v.platform} onChange={(e) => set({ ...v, platform: e.target.value })} placeholder="Platform" />
      <Input aria-label={`${prefix} link`} value={v.link} onChange={(e) => set({ ...v, link: e.target.value })} placeholder="Link or asset" />
    </div>
  );
}

function IdeaRow({ idea, write }: { idea: IdeaView; write: (w: SocialWriteAction) => Promise<string[]> }) {
  const [edit, setEdit] = useState<IdeaFields | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();
  const run = async (w: SocialWriteAction, after?: () => void) => {
    setBusy(w.action);
    const lines = await write(w);
    setBusy(undefined);
    setIssues(lines);
    if (!lines.length) after?.();
  };
  return (
    <li className="min-w-0 border-b py-2 last:border-b-0" data-testid={`idea-${idea.id}`}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
        <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{idea.id}</span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm">{idea.idea || <span className="text-muted-foreground">(no text)</span>}</div>
          <div className="text-xs text-muted-foreground">
            {[idea.from === ownerName() ? "you" : idea.from, idea.date, idea.format, idea.platform].filter(Boolean).join(" · ")}
            {idea.link &&
              (isUrl(idea.link) ? (
                <>
                  {" · "}
                  <a href={idea.link} target="_blank" rel="noreferrer" className="underline">
                    link ↗
                  </a>
                </>
              ) : (
                ` · ${idea.link}`
              ))}
          </div>
        </div>
        <span data-testid={`idea-state-${idea.id}`} title={idea.shown !== (idea.state || "new") ? `State cell: ${idea.state || "empty"}` : undefined}>
          <StateChip state={idea.shown} />
        </span>
        <div className="min-w-0 basis-full text-xs sm:basis-56">
          <Became idea={idea} />
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setEdit(edit ? null : { idea: idea.idea, format: idea.format, platform: idea.platform, link: idea.link })}>
            {edit ? "Cancel" : "Edit"}
          </Button>
          {idea.droppable && (
            <Button size="sm" variant="ghost" disabled={!!busy} pending={busy === `ideas/${idea.id}/drop`} pendingLabel="Dropping…" onClick={() => run({ action: `ideas/${idea.id}/drop` })} title="Park it: the Writer will not pick it up">
              Drop
            </Button>
          )}
        </div>
      </div>
      {edit && (
        <form
          className="mt-2 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!edit.idea.trim()) return setIssues(["An idea needs a line of text."]);
            void run(
              { action: `ideas/${idea.id}`, body: { idea: edit.idea.trim(), format: nullable(edit.format), platform: nullable(edit.platform), link: nullable(edit.link) } },
              () => setEdit(null),
            );
          }}
        >
          <IdeaInputs v={edit} set={setEdit} prefix={`Edit ${idea.id}`} />
          <div>
            <Button size="sm" type="submit" disabled={!!busy} pending={busy === `ideas/${idea.id}`} pendingLabel="Saving…">
              Save {idea.id}
            </Button>
          </div>
        </form>
      )}
      <Issues lines={issues} testId={`idea-issues-${idea.id}`} />
    </li>
  );
}

const cell = (r: WeekRow | MonthRow, key: string) => (r as unknown as Record<string, string>)[key] ?? "";

function PriorityList<R extends WeekRow | MonthRow>({
  title,
  rows,
  set,
  text,
  when,
  blank,
  testId,
}: {
  title: string;
  rows: R[];
  set: (rows: R[]) => void;
  text: { key: "highlight" | "priority"; label: string };
  when: { key: "until" | "month"; label: string };
  blank: R;
  testId: string;
}) {
  const put = (i: number, patch: Partial<R>) => set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid min-w-0 gap-2" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid min-w-0 items-center gap-2 sm:grid-cols-[2.5rem_2fr_1.5fr_8rem_auto_auto]">
          <span className="font-mono text-xs text-muted-foreground">{r.id || "new"}</span>
          <Input aria-label={`${title} ${i + 1} ${text.label}`} value={cell(r, text.key)} onChange={(e) => put(i, { [text.key]: e.target.value } as Partial<R>)} placeholder={text.label} />
          <Input aria-label={`${title} ${i + 1} why`} value={r.why} onChange={(e) => put(i, { why: e.target.value } as Partial<R>)} placeholder="Why" />
          <Input aria-label={`${title} ${i + 1} ${when.label}`} value={cell(r, when.key)} onChange={(e) => put(i, { [when.key]: e.target.value } as Partial<R>)} placeholder={when.label} />
          <span className="whitespace-nowrap text-xs text-muted-foreground" title={r.servedBy.join(", ")}>
            {r.servedBy.length} post{r.servedBy.length === 1 ? "" : "s"}
          </span>
          <Button size="sm" variant="ghost" aria-label={`Remove ${title} ${i + 1}`} onClick={() => set(rows.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" variant="outline" onClick={() => set([...rows, { ...blank }])}>
          + Add
        </Button>
      </div>
    </div>
  );
}

/**
 * the owner's drain. Add, edit and drop ideas (each with its state and the post
 * it became), and the week + month priorities with one Save. Every write goes through POST /api/tenants/:id/social/<action>
 *, commits as the owner in the campaign repo, and answers with the fresh export this screen then shows; a 422's
 * pack issue lines show inline where the click was. Social skin only.
 */
export function IdeasPage() {
  const { data: loaded, error, loading } = useSocial();
  const [fresh, setFresh] = useState<SocialData | undefined>();
  const social = fresh ?? loaded;
  const ideas = useMemo(() => ideaViews(social?.data), [social]);
  const counts = useMemo(() => countIdeas(ideas), [ideas]);
  const [filter, setFilter] = useState<IdeaFilter>("all");
  const [add, setAdd] = useState<IdeaFields>(EMPTY_IDEA);
  const [addIssues, setAddIssues] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  // Priorities: an editable copy; a newer export replaces it only while there are no unsaved edits.
  const [week, setWeek] = useState<WeekRow[]>([]);
  const [month, setMonth] = useState<MonthRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [prioIssues, setPrioIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (dirty || !social) return;
    setWeek(weekRows(social.data.directions.week));
    setMonth(monthRows(social.data.directions.month));
  }, [social, dirty]);

  /** One write; on success the screen shows the answer's export. Returns the issue lines ([] = ok). */
  const write = async (w: SocialWriteAction): Promise<string[]> => {
    if (!social) return ["No social data loaded yet."];
    try {
      const r = await api.socialWrite(social.tenantId, w, social.repo ?? undefined);
      setFresh(r);
      return [];
    } catch (e) {
      return writeIssues(e);
    }
  };

  const sample = social?.sample;
  const noRepo = social && !social.sample && !social.repo;

  return (
    <>
      <PageHeader title={IDEAS_LABEL} description="Your drain: anything you drop here lands in a file the Writer and Scout read on their next wake. Set the week and the month." />
      {error && !social && <ErrorBox error={error} />}
      {loading && !social && <Loading />}
      {sample && <p className="mb-3 text-xs text-amber-700 dark:text-amber-400" data-testid="ideas-sample">Sample data: no console server here, nothing is saved.</p>}
      {noRepo && <Empty>No social repo in this workspace yet.</Empty>}
      {social && !noRepo && (
        <div className="grid min-w-0 grid-cols-1 gap-4">
          <Card className="min-w-0 p-4" data-testid="my-ideas">
            <h2 className="mb-3 text-base font-semibold">My ideas</h2>
            <form
              className="grid gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!add.idea.trim()) return setAddIssues(["An idea needs a line of text."]);
                setAdding(true);
                const lines = await write({ action: "ideas", body: { idea: add.idea.trim(), format: nullable(add.format), platform: nullable(add.platform), link: nullable(add.link) } });
                setAdding(false);
                setAddIssues(lines);
                if (!lines.length) setAdd(EMPTY_IDEA);
              }}
            >
              <IdeaInputs v={add} set={setAdd} prefix="New" />
              <div>
                <Button size="sm" type="submit" disabled={adding}>
                  Add idea
                </Button>
              </div>
            </form>
            <Issues lines={addIssues} testId="add-issues" />

            <div className="mt-4 flex flex-wrap gap-1" role="tablist" aria-label="Idea states">
              {IDEA_FILTERS.map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={filter === f}
                  data-testid={`filter-${f}`}
                  onClick={() => setFilter(f)}
                  className={cn("rounded-full border px-2.5 py-0.5 text-xs capitalize", filter === f ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                >
                  {f} {counts[f]}
                </button>
              ))}
            </div>
            {ideas.length === 0 ? (
              <Empty>No ideas yet. Drop one above.</Empty>
            ) : (
              <ul className="mt-2 grid min-w-0">
                {filterIdeas(ideas, filter).map((i) => (
                  <IdeaRow key={i.id} idea={i} write={write} />
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              States: new → picked up → drafted / posted (linked), or parked (with why) or epic (too big for one post). The Writer moves an idea; you may drop a new or
              picked-up one (it is parked, never deleted).
            </p>
          </Card>

          <Card className="min-w-0 p-4" data-testid="my-priorities">
            <h2 className="mb-3 text-base font-semibold">My priorities</h2>
            <div className="grid gap-4">
              <PriorityList
                title="This week"
                testId="prio-week"
                rows={week}
                set={(r) => (setWeek(r), setDirty(true), setSaved(false))}
                text={{ key: "highlight", label: "Highlight" }}
                when={{ key: "until", label: "Until" }}
                blank={{ id: "", highlight: "", why: "", until: "", servedBy: [] }}
              />
              <PriorityList
                title="This month"
                testId="prio-month"
                rows={month}
                set={(r) => (setMonth(r), setDirty(true), setSaved(false))}
                text={{ key: "priority", label: "Priority" }}
                when={{ key: "month", label: "Month" }}
                blank={{ id: "", priority: "", why: "", month: "", servedBy: [] }}
              />
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button
                size="sm"
                disabled={saving || !dirty}
                pending={saving}
                pendingLabel="Saving…"
                onClick={async () => {
                  setSaving(true);
                  const lines = await write({ action: "directions", body: prioritiesBody(week, month) });
                  setSaving(false);
                  setPrioIssues(lines);
                  if (!lines.length) (setDirty(false), setSaved(true));
                }}
              >
                Save priorities
              </Button>
              {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              {saved && !dirty && <span className="text-xs text-muted-foreground" data-testid="prio-saved">Saved</span>}
            </div>
            <Issues lines={prioIssues} testId="prio-issues" />
            <p className="mt-3 text-xs text-muted-foreground">Saved to data/brief.md (This week); the next Scout and Writer wakes read it. "Posts" is computed from each post's highlight.</p>
          </Card>
        </div>
      )}
    </>
  );
}
