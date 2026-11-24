import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { api, type CampaignTotems, type Milestone, type TotemHistoryLine, type TotemObservation, type TotemTask } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { WaitingOnYou } from "@/components/waiting";
import { ErrorBox, Loading } from "@/components/common";
import { inline } from "@/lib/chatMarkdown";
import { mutate, useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { absoluteLinks, splitTaskCodes } from "@/lib/totems";
import { cn } from "@/lib/utils";
import { FoldChevron } from "@/components/foldChevron";
import { HistoryFilesFor } from "./History";
import { pillarStats, type PillarPost } from "../../../../server/src/social/pillars";

/**
 * the five fixed tabs of a campaign in the social
 * skin, each a part of the campaign's epic file (social/totems.ts on the server): Work, Observations, History; Chat is
 * the campaign chat itself (Milestone.tsx). The deck (Brief) tab is gone: the Plan tab (PlanTab.tsx) took its place.
 * Every write goes through the console's one spine writer: a proposal's Add to the brief / Not now are the owner's taps.
 */

/** The campaign's four parts; `tick` refetches (a slide note polls every 5 s until its rebuild lands). */
export function useTotems(milestoneId: string, tick = 0) {
  return useQuery(async () => api.getCampaignTotems(await worldId(), milestoneId), [milestoneId, tick]);
}

const fmtDay = (d: string, weekday = true) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { ...(weekday ? { weekday: "short" as const } : {}), day: "numeric", month: "short", timeZone: "UTC" });

/** Header + one-line description, as every tab of the mockup opens. */
function TabHead({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1 basis-72">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{children}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Two or three pills that switch a view (Tasks / Posts, This campaign / Whole team). */
function Pills<T extends string>({ value, options, onChange, testId }: { value: T; options: [T, string][]; onChange: (v: T) => void; testId: string }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn("rounded-full border px-3 py-1 text-xs", value === v ? "border-violet-400 bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "text-muted-foreground hover:text-foreground")}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** A line of text with Markdown links (relative ones to GitHub) and task codes linking to Work. */
function LineText({ text, base }: { text: string; base: { remote?: string; path?: string } }) {
  const md = absoluteLinks(text, base);
  return (
    <>
      {splitTaskCodes(md).map((p, i) =>
        "code" in p ? (
          <Link key={i} to={`?tab=work&row=${encodeURIComponent(p.code)}`} className="font-mono text-[0.92em] text-primary underline" data-testid="task-link">
            {p.code}
          </Link>
        ) : (
          <Fragment key={i}>{inline(p.text)}</Fragment>
        ),
      )}
    </>
  );
}

// ---------- the Product tab's slide frame (Motion.tsx) ----------

/** The slide's one height, so Previous / Next never move between slides (the owner): a long slide scrolls inside. */
export const SLIDE_HEIGHT = "h-[26rem] sm:h-[28rem]";

/** Previous / n of N / Next. */
export function DeckNav({ i, total, go, extra, dark }: { i: number; total: number; go: (k: number) => void; extra?: ReactNode; dark?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3" data-testid="deck-nav">
      <Button variant="outline" size="sm" disabled={i === 0} onClick={() => go(i - 1)} data-testid="deck-prev">
        <ChevronLeft /> Previous
      </Button>
      <span className={cn("text-sm tabular-nums", dark ? "text-zinc-300" : "text-muted-foreground")} data-testid="deck-pos">
        {i + 1} / {total}
      </span>
      <Button size="sm" disabled={i >= total - 1} onClick={() => go(i + 1)} data-testid="deck-next">
        Next <ChevronRight />
      </Button>
      {extra}
    </div>
  );
}

// ---------- Work ----------

const GROUPS: { id: TotemTask["group"]; title: string; meta: string }[] = [
  { id: "waiting", title: "Tasks waiting on you", meta: "in review, or blocked on your answer" },
  { id: "moving", title: "Moving", meta: "picked up at the owner's next wake" },
  { id: "planned", title: "Planned", meta: "not started" },
  { id: "done", title: "Done", meta: "with their outcome" },
];

const statusTone = (s: string): "amber" | "green" | "blue" | "gray" | "red" => (/^\W*(review|held)/i.test(s) ? "amber" : /^\W*done/i.test(s) ? "green" : /^\W*blocked/i.test(s) ? "red" : /^\W*(active|ready)/i.test(s) ? "blue" : "gray");

/** the campaign's tasks (its posts are the Pipeline tab, what waits for the owner the Waiting on me tab). */
export function WorkTab({ m }: { m: Milestone }) {
  const [params] = useSearchParams();
  const q = useTotems(m.id);
  const t = q.data;
  const row = params.get("row");
  return (
    <div data-testid="work-tab">
      <TabHead title="Board">
        This campaign's own work: the rows of its epic file. Each one has an owner, a status and an outcome. Research, a logo, a thread to answer and a post to write all land here.
      </TabHead>
      {q.error && !t ? (
        <ErrorBox error={q.error} />
      ) : !t ? (
        <Loading />
      ) : (
        <div className="grid min-w-0 gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-testid="goal-path">
            {[...t.chain].reverse().map((e, k, all) => (
              <Fragment key={e.path}>
                <span className={cn("min-w-0 [overflow-wrap:anywhere]", k === all.length - 1 && "font-semibold")}>{e.title}</span>
                <span className="text-muted-foreground">›</span>
              </Fragment>
            ))}
            <span className="text-muted-foreground">{t.work.rows.length} tasks</span>
          </div>
          <AddTask m={m} />
          <TaskGroups rows={t.work.rows} row={row} base={{ remote: t.remote ?? undefined, path: t.epic.path }} />
        </div>
      )}
    </div>
  );
}

/** what waits for the owner in this campaign, its own tab (was Work's first section). */
export function WaitingTab({ m }: { m: Milestone }) {
  return (
    <div data-testid="waiting-tab">
      <TabHead title="Inbox">The asks and reviews of this campaign that need your answer. Answer here or on the Team page, where the asks of every campaign wait together.</TabHead>
      <WaitingOnYou milestoneId={m.id} fold="campaign-work-waiting" />
    </div>
  );
}

/** Add task: a ready row in the campaign's Issue Ledger (the owner's ask is ready, root L-37); the Delivery manager gives it an owner. */
function AddTask({ m }: { m: Milestone }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setNote(undefined);
    try {
      const r = await mutate(() => api.addToTree(m.id, { kind: "row", title: title.trim() }));
      setTitle("");
      setNote({ ok: true, text: `Added ${r.id ?? "the task"}${r.ready === false ? " as a draft" : ""}. The Delivery manager gives it an owner at its next wake.` });
    } catch (e) {
      setNote({ ok: false, text: `Not added: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      data-testid="add-task"
    >
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1 basis-56" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task, for example: research which subreddits allow a demo video" aria-label="New task" data-testid="add-task-title" />
        <Button type="submit" disabled={busy || !title.trim()} pending={busy} pendingLabel="Adding…" data-testid="add-task-send">
          <Plus /> Add task
        </Button>
      </div>
      {note && (
        <div role="status" className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")} data-testid="add-task-result">
          {note.text}
        </div>
      )}
    </form>
  );
}

function TaskGroups({ rows, row, base }: { rows: TotemTask[]; row: string | null; base: { remote?: string; path?: string } }) {
  const target = row ? rows.find((r) => r.id === row) : undefined;
  return (
    <div data-testid="task-groups">
      {GROUPS.map((g) => (
        <TaskGroup key={g.id} g={g} rows={rows.filter((r) => r.group === g.id)} row={row} forceOpen={target?.group === g.id} base={base} />
      ))}
    </div>
  );
}

function TaskGroup({ g, rows, row, forceOpen, base }: { g: (typeof GROUPS)[number]; rows: TotemTask[]; row: string | null; forceOpen: boolean; base: { remote?: string; path?: string } }) {
  const [open, setOpen] = useSectionOpen(`campaign-work-${g.id}`, g.id !== "done");
  const shown = open || forceOpen;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (forceOpen) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [forceOpen, row]);
  if (!rows.length && g.id !== "moving") return null;
  return (
    <FoldSection title={g.title} count={rows.length} tone={g.id === "waiting" ? "needs-you" : "info"} testId={`tasks-${g.id}`} open={shown} onToggle={setOpen} meta={<span className="text-xs text-muted-foreground">{g.meta}</span>} bodyClassName="p-0">
      {rows.length ? (
        <ul className="divide-y">
          {rows.map((r) => (
            <li
              key={r.id}
              ref={r.id === row ? ref : undefined}
              id={`task-${r.id}`}
              className={cn("grid gap-1 px-3 py-2 text-sm sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3", r.id === row && "bg-sky-500/10 ring-2 ring-inset ring-sky-500")}
              data-testid="task-row"
              data-row={r.id}
            >
              <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium" title={r.title}>
                  {r.title}
                </span>
                {(r.evidence || r.next) && (
                  <span className="block truncate text-xs text-muted-foreground" title={[r.evidence, r.next].filter(Boolean).join(" · ")}>
                    <LineText text={r.group === "done" || !r.next ? r.evidence : r.next} base={base} />
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                {(r.owner || r.role) && <Badge variant="gray">{/^(unassigned|none|-)?$/i.test(r.owner.trim()) ? `${r.role || "no owner yet"}` : r.owner.replace(/^the /, "")}</Badge>}
                <Badge variant={statusTone(r.status)} title={r.status}>
                  {r.status.split(/[\s(—:]/)[0] || "?"}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground">Nothing moving. Add a task above.</p>
      )}
    </FoldSection>
  );
}

// ---------- Observations ----------

/** a benefit's status as a quiet pill: colour only when it is the claim (works today) or a warning (half built). */
const BENEFIT_TONE: Record<string, string> = {
  "works today": "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  "half built": "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
};

/**
 * The owner 24 Nov: "I need to understand the pillars of our communication and when we
 * communicate ... we need to be measuring what pillars are we touching on ... so many posts on this, so many posts on
 * that ... And how are these posts performing ... What's the feedback loop?". The Pillars tab (it was Benefits):
 * the benefits are the pillars, one source, the brief's Benefits table (only he edits it). Each post names the pillar
 * numbers it touches in its Benefit cell; this counts the posts per pillar, how the live ones did, and the posts that name
 * none. The loop under the head: a pillar, a post that names it, the Reporter's reading, these counts, the Writer's next post.
 */
export function PillarsTab({ m, repo, campaign }: { m: Milestone; repo?: string; campaign?: string }) {
  const q = useTotems(m.id);
  const [scope, setScope] = useState<"campaign" | "product">(campaign ? "campaign" : "product");
  const want = scope === "campaign" ? campaign : undefined;
  const posts = useQuery(async () => api.getSocial(await worldId(), repo, want), [repo, want]);
  const t = q.data;
  const stats = useMemo(() => pillarStats(t?.benefits?.lines ?? [], (posts.data?.data.posts ?? []) as PillarPost[]), [t, posts.data]);
  if (q.error && !t) return <ErrorBox error={q.error} />;
  if (!t) return <Loading />;
  const b = t.benefits ?? { source: null, lines: [], asked: [] };
  const byId = new Map(stats.pillars.map((p) => [p.id, p]));
  const most = Math.max(1, ...stats.pillars.map((p) => p.posts));
  const counted = posts.data && !posts.error;
  const where = scope === "campaign" ? "this campaign's" : "the product's";
  return (
    <div data-testid="pillars-tab" data-lines={b.lines.length}>
      <TabHead
        title="Pillars"
        actions={
          campaign ? (
            <Pills
              value={scope}
              onChange={setScope}
              testId="pillars-scope"
              options={[
                ["campaign", "This campaign"],
                ["product", "Whole product"],
              ]}
            />
          ) : undefined
        }
      >
        {counted ? (
          <span data-testid="pillars-answer">
            {stats.total} of {where} posts, {stats.total - stats.offPillar.count} on a pillar{stats.offPillar.count ? `, ${stats.offPillar.count} on none` : ""}. Every post is about one of these benefits.
          </span>
        ) : (
          "What every post is about: the benefits the product gives the people who use it."
        )}
      </TabHead>
      <ol className="mb-5 flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs text-muted-foreground" data-testid="pillars-loop" aria-label="How a pillar learns">
        {["A pillar", "A post names it", "Measured after 48 hours", "Counted here", "The next post leans on what works"].map((x, i, all) => (
          <li key={x} className="flex items-center gap-1.5">
            <span className="rounded-md border bg-card px-2 py-1 text-foreground">{x}</span>
            {i < all.length - 1 && <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {posts.error && <p className="mb-3 text-sm text-muted-foreground">The posts could not be read now, so the counts are missing.</p>}
      {b.lines.length ? (
        <ol className="grid gap-3" data-testid="pillar-lines">
          {b.lines.map((l) => {
            const s = byId.get(String(l.id));
            return (
              <li key={l.id} id={`pillar-${l.id}`} className="grid min-w-0 scroll-mt-4 gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[1fr_12rem]" data-testid="pillar-line" data-posts={s?.posts ?? 0}>
                <div className="flex min-w-0 gap-3">
                  <span className="mt-0.5 w-5 shrink-0 text-sm tabular-nums text-muted-foreground">{l.id}</span>
                  <div className="grid min-w-0 gap-1">
                    <p className="font-medium leading-snug [overflow-wrap:anywhere]">{l.benefit}</p>
                    {l.does && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{l.does}</p>}
                    {l.status && (
                      <span className={cn("mt-1 inline-flex h-6 w-fit items-center self-start rounded-full px-2 text-xs font-medium leading-none", BENEFIT_TONE[l.status] ?? "bg-muted text-muted-foreground")} data-testid="benefit-status">
                        {l.soon ? `${l.status}, coming soon` : l.status}
                      </span>
                    )}
                    {s && counted && (
                      <div className="mt-2 grid gap-1.5" data-testid="pillar-numbers">
                        <div className="flex items-center gap-2">
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <span className="block h-full rounded-full bg-violet-500" style={{ width: `${(s.posts / most) * 100}%` }} />
                          </span>
                          <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums" data-testid="pillar-posts">
                            {s.posts} {s.posts === 1 ? "post" : "posts"}
                          </span>
                        </div>
                        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground" data-testid="pillar-perf">
                          {[
                            ["live", s.live],
                            ["planned", s.planned],
                            ["views", s.views],
                            ["likes", s.likes],
                            ["replies", s.replies],
                            ...(s.viewsPerPost !== null ? [["views a post", s.viewsPerPost] as const] : []),
                          ].map(([k, v]) => (
                            <div key={k} className="flex gap-1">
                              <dd className="font-medium tabular-nums text-foreground">{v}</dd>
                              <dt>{k}</dt>
                            </div>
                          ))}
                        </dl>
                        {s.best && (
                          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="pillar-best">
                            Best so far:{" "}
                            {s.best.link ? (
                              <a href={s.best.link} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
                                {s.best.title || s.best.id}
                              </a>
                            ) : (
                              s.best.title || s.best.id
                            )}
                            , {s.best.views} views
                          </p>
                        )}
                        {s.live > 0 && !s.measured && <p className="text-xs text-muted-foreground">Live, not measured yet.</p>}
                      </div>
                    )}
                  </div>
                </div>
                {l.screen?.url && (
                  <a href={l.screen.url} target="_blank" rel="noreferrer" className="block min-w-0 self-start overflow-hidden rounded-md border" title={l.screen.label}>
                    <img src={l.screen.url} alt={l.screen.label} loading="lazy" className="aspect-[16/10] w-full object-cover object-top" />
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="benefits-none">
          No pillars written for this product yet. They go in the brief's Benefits table, one line each: what it does, what you get, and whether it works today.
        </p>
      )}
      {counted && stats.offPillar.count > 0 && (
        <section id="pillar-none" className="mt-3 rounded-xl border border-amber-300 p-4 dark:border-amber-800" data-testid="pillar-none">
          <p className="text-sm font-medium">
            {stats.offPillar.count} {stats.offPillar.count === 1 ? "post names" : "posts name"} no pillar
          </p>
          <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{stats.offPillar.ids.join(", ")}. The Writer names one the next time it touches each.</p>
        </section>
      )}
      {b.asked.length > 0 && (
        <section className="mt-5 grid gap-2" data-testid="benefits-asked">
          <h3 className="text-sm font-semibold">People asked for</h3>
          <ul className="grid gap-1 text-sm text-muted-foreground">
            {b.asked.map((a) => (
              <li key={a.id}>{a.text} <span className="text-xs">waits for your Add on Lessons</span></li>
            ))}
          </ul>
        </section>
      )}
      {b.source && <p className="mt-4 text-xs text-muted-foreground">Pillars read from {b.source}, posts from data/posts-ledger.md</p>}
    </div>
  );
}

export function ObservationsTab({ m }: { m: Milestone }) {
  const [tick, setTick] = useState(0);
  const q = useTotems(m.id, tick);
  const t = q.data;
  const [scope, setScope] = useState<"campaign" | "team">("campaign");
  if (q.error && !t) return <ErrorBox error={q.error} />;
  if (!t) return <Loading />;
  const list = (scope === "team" ? t.team?.observations : t.observations) ?? [];
  const file = scope === "team" ? t.team?.root.path : t.epic.path;
  const base = { remote: t.remote ?? undefined, path: file };
  const proposals = list.filter((o) => o.proposal?.state === "open");
  const force = list.filter((o) => !o.retired);
  const retired = list.filter((o) => o.retired);
  return (
    <div data-testid="observations-tab">
      <TabHead
        title="Lessons"
        actions={
          <Pills
            value={scope}
            onChange={setScope}
            testId="observations-scope"
            options={[
              ["campaign", "This campaign"],
              ["team", "Whole team"],
            ]}
          />
        }
      >
        <span data-testid="lessons-what">What this campaign learned from its own posts and your notes. Every writer follows these before its next post.</span>
      </TabHead>
      <ObsSection id="force" title="In force" meta="read at every wake" list={force} base={base} />
      <FoldSectionProposals list={proposals} m={m} file={file} onDone={() => setTick((k) => k + 1)} />
      <ObsSection id="retired" title="Retired" meta="kept, no longer read" list={retired} base={base} byDefault={false} />
    </div>
  );
}

function ObsSection({ id, title, meta, list, base, byDefault = true }: { id: string; title: string; meta: string; list: TotemObservation[]; base: { remote?: string; path?: string }; byDefault?: boolean }) {
  const [open, setOpen] = useSectionOpen(`campaign-obs-${id}`, byDefault);
  return (
    <FoldSection title={title} count={list.length} testId={`obs-${id}`} open={open} onToggle={setOpen} meta={<span className="text-xs text-muted-foreground">{meta}</span>} bodyClassName="p-0">
      {list.length ? (
        <ul className="divide-y">
          {list.map((o) => (
            <ObsRow key={o.id} o={o} base={base} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground">None yet.</p>
      )}
    </FoldSection>
  );
}

function ObsRow({ o, base }: { o: TotemObservation; base: { remote?: string; path?: string } }) {
  const [full, setFull] = useState(false);
  const date = /(\d{4}-\d{2}-\d{2})/.exec(`${o.confirmed} ${o.why}`)?.[1];
  return (
    <li className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-center sm:gap-3" data-testid="obs-row" data-id={o.id}>
      <span className="font-mono text-xs text-muted-foreground">
        {o.id}
        {date ? ` · ${fmtDay(date, false)}` : ""}
      </span>
      <button type="button" className={cn("min-w-0 text-left", !full && "truncate")} onClick={() => setFull(!full)} title={o.rule}>
        {o.when && <span className="text-muted-foreground">{o.when}: </span>}
        <LineText text={o.rule} base={base} />
      </button>
      <span className={cn("min-w-0 text-xs text-muted-foreground", !full && "truncate")} title={o.why}>
        <LineText text={o.why} base={base} />
      </span>
      <Badge variant={o.retired ? "gray" : "green"}>{o.retired ? "retired" : o.proposal?.state === "added" ? "in the brief" : "in force"}</Badge>
    </li>
  );
}

function FoldSectionProposals({ list, m, file, onDone }: { list: TotemObservation[]; m: Milestone; file?: string; onDone: () => void }) {
  const [open, setOpen] = useSectionOpen("campaign-obs-proposals");
  return (
    <FoldSection title="Proposed changes to the brief" count={list.length} tone="needs-you" testId="obs-proposals" open={open} onToggle={setOpen} meta={<span className="text-xs text-muted-foreground">when your note and the numbers agree</span>} bodyClassName="p-0">
      {list.length ? (
        <ul className="divide-y">
          {list.map((o) => (
            <ProposalRow key={o.id} o={o} m={m} file={file} onDone={onDone} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground">No proposal waits for you.</p>
      )}
    </FoldSection>
  );
}

function ProposalRow({ o, m, file, onDone }: { o: TotemObservation; m: Milestone; file?: string; onDone: () => void }) {
  const [busy, setBusy] = useState<"add" | "notnow">();
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const act = async (action: "add" | "notnow") => {
    setBusy(action);
    setNote(undefined);
    try {
      await mutate(async () => api.decideProposal(await worldId(), m.id, { file, id: o.id, action }));
      setNote({ ok: true, text: action === "add" ? `Added to the brief (${o.proposal!.part}).` : "Kept here, not in the brief." });
      onDone();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <li className="grid gap-2 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" data-testid="proposal-row" data-id={o.id}>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        Add to <b>{o.proposal!.part}</b>: “{o.proposal!.text}” <span className="text-xs text-muted-foreground">({o.id}, {o.why})</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!!busy} pending={busy === "add"} pendingLabel="Adding…" onClick={() => act("add")} data-testid="proposal-add">
          Add to the brief
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} pending={busy === "notnow"} pendingLabel="Saving…" onClick={() => act("notnow")} data-testid="proposal-notnow">
          Leave it out of the brief
        </Button>
        {note && (
          <span role="status" className={cn("text-xs", note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
            {note.text}
          </span>
        )}
      </span>
    </li>
  );
}

// ---------- History ----------

type HistoryFilter = "all" | "decisions" | "owner" | "wakes" | "posts" | "runs" | "files";
const FILTERS: [HistoryFilter, string][] = [
  ["all", "All"],
  ["decisions", "Decisions"],
  ["owner", "Your notes"],
  ["wakes", "Wakes"],
  ["posts", "Posts and replies"],
  ["runs", "Runs"],
  // every file the History tab homes (the weekly logs and notes kept in the repo), each opening read-only.
  ["files", "Logs and notes"],
];
const keepLine = (f: HistoryFilter) => (l: TotemHistoryLine) => f === "all" || (f === "decisions" ? l.kind === "decision" : f === "owner" ? l.kind === "owner" : l.kind === "wake");

export function HistoryTab({ m, posts, runs }: { m: Milestone; posts: ReactNode; runs: ReactNode }) {
  const q = useTotems(m.id);
  const t = q.data;
  // ?history=files opens the logs and notes kept in the repo (a link can point straight at them).
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<HistoryFilter>(params.get("history") === "files" ? "files" : "all");
  const [every, setEvery] = useState(false);
  return (
    <div data-testid="history-tab">
      <TabHead
        title="History"
        actions={
          filter !== "posts" && filter !== "runs" && filter !== "files" ? (
            <Button variant="outline" size="sm" onClick={() => setEvery(!every)} data-testid="history-every">
              {every ? "Fold the days" : "Open every day"}
            </Button>
          ) : undefined
        }
      >
        What happened, newest first. A campaign runs in weeks: each week closes with its result against its targets. Every persona reads the weeks when it wakes and opens a day only when it needs to.
      </TabHead>
      <div className="mb-3">
        <Pills value={filter} onChange={setFilter} testId="history-filter" options={FILTERS} />
      </div>
      {filter === "files" ? (
        <HistoryFilesFor repo={m.repo} path={m.path} campaign />
      ) : filter === "posts" ? (
        posts
      ) : filter === "runs" ? (
        runs
      ) : q.error && !t ? (
        <ErrorBox error={q.error} />
      ) : !t ? (
        <Loading />
      ) : (
        <div data-testid="history-weeks">
          {t.history.weeks.map((w, k) => (
            <HistoryWeekBox key={`${w.week}:${every}`} w={w} first={k === 0} every={every} keep={keepLine(filter)} base={{ remote: t.remote ?? undefined, path: w.page ?? t.epic.path }} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryWeekBox({ w, first, every, keep, base }: { w: CampaignTotems["history"]["weeks"][number]; first: boolean; every: boolean; keep: (l: TotemHistoryLine) => boolean; base: { remote?: string; path?: string } }) {
  const [open, setOpen] = useState(first || every);
  const days = w.days.map((d) => ({ ...d, lines: d.lines.filter(keep) })).filter((d) => d.lines.length || d.day);
  const count = days.reduce((n, d) => n + d.lines.length, 0);
  const span = /^(\d{4})-W(\d{2})$/.exec(w.week);
  return (
    <FoldSection
      title={<span className="font-semibold">{span ? `Week ${Number(span[2])}` : w.week}</span>}
      count={count}
      testId="history-week"
      open={open}
      onToggle={setOpen}
      meta={<span className="min-w-0 flex-1 basis-60 text-sm text-muted-foreground [overflow-wrap:anywhere]">{w.line || "no result written yet"}</span>}
      bodyClassName="p-0"
    >
      {days.length ? days.map((d, k) => <HistoryDayBox key={d.date} d={d} open={every || (first && k === 0)} base={base} />) : <p className="px-3 py-3 text-sm text-muted-foreground">Nothing logged this week yet.</p>}
    </FoldSection>
  );
}

function HistoryDayBox({ d, open: byDefault, base }: { d: CampaignTotems["history"]["weeks"][number]["days"][number]; open: boolean; base: { remote?: string; path?: string } }) {
  const [open, setOpen] = useState(byDefault);
  return (
    <div className="border-b last:border-b-0" data-testid="history-day" data-date={d.date}>
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-muted/40" onClick={() => setOpen(!open)} aria-expanded={open}>
        <FoldChevron open={open} className="text-muted-foreground" />
        <span className="font-semibold">{fmtDay(d.date)}</span>
        {d.day && <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.day}</span>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{d.lines.length}</span>
      </button>
      {open && (
        <ul className="pb-1">
          {d.lines.map((l, k) => (
            <li
              key={k}
              className={cn("grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 px-3 py-1 text-sm sm:grid-cols-[3rem_9rem_minmax(0,1fr)]", l.kind === "owner" && "bg-violet-500/5", l.kind === "decision" && "bg-violet-500/10")}
              data-testid="history-line"
              data-kind={l.kind}
            >
              <span className="tabular-nums text-muted-foreground">{l.time || "·"}</span>
              <span className={cn("truncate font-medium", l.kind !== "wake" && "text-violet-700 dark:text-violet-300")} title={l.who}>
                {l.kind === "owner" ? "You" : l.who}
              </span>
              <span className="col-span-2 min-w-0 [overflow-wrap:anywhere] sm:col-span-1">
                <LineText text={l.text} base={base} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


// ---------- Chat ----------

/** The Chat tab's words above the campaign chat. */
export function ChatIntro() {
  return (
    <TabHead title="Chat">
      {/* on a phone the chat itself gets the room. */}
      <span className="max-sm:hidden">
        Feedback on the whole campaign. The campaign chat reads the epic file like every persona. Each reply says where your words landed: a task, an observation, the brief or a decision.
      </span>
    </TabHead>
  );
}
