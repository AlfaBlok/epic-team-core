import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Briefcase, FilePlus2, FileSearch, Megaphone } from "lucide-react";
import { api, type AddKind, type Assignment, type Cadence, type Milestone, type Persona, type PersonaHost, type PersonaTemplate, type Repo, type Run } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/common";
import { useChatAttach, wordsWithFiles } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { DocPicker, RepoPicker, type PathChoice } from "@/components/pickers";
import { mutate, useQuery } from "@/lib/data";
import { WEEKDAY_SHORT, formatCadence } from "@/lib/format";
import { cap, DEFAULT_SKIN, useSkin, useWords } from "@/lib/skin";
import { knownWorld, worldId } from "@/lib/useSocial";
import { repoCards } from "@/lib/campaign";
import { cn } from "@/lib/utils";
import { homeWorld, opsRepo, ownerName } from "@/lib/identity";
import { mainHost, workerHost } from "../lib/identity";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await mutate(fn);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function FormError({ error }: { error?: string }) {
  return error ? <p className="text-sm text-destructive">{error}</p> : null;
}

// ---------- Milestone ----------

export type MilestoneMode = "track" | "create";

const MODES: { value: MilestoneMode; label: string; hint: string; icon: typeof FileSearch }[] = [
  { value: "track", label: "Track an existing spine / epic ticket", hint: "Point at a file already in the repo", icon: FileSearch },
  { value: "create", label: "Create a new epic", hint: "An agent in the repo writes the spine or ticket", icon: FilePlus2 },
];

/**
 * Add milestone. With `focusAt` it is "New focus milestone": the new
 * milestone is made focus at that position in the same step (create: `bigRoot` on POST /milestones; a new epic: PATCH
 * after the bootstrap), and the console writes it to the team repo's state/big-roots.json.
 */
type MilestoneDialogProps = DialogProps & {
  onCreated?: (m: Milestone) => void;
  focusAt?: number;
  /** the social skin's "Add campaign or job": Campaign runs the New campaign wizard (`onCampaign`), Job is this dialog. */
  offerCampaign?: boolean;
  onCampaign?: () => void;
  /** the social skin's "Add job" (a one-off piece of work with an end): the same dialog, named for a job. */
  job?: boolean;
  /** a customer workspace (console skin): Add project is this form in the workspace's own repo (no agent launch). */
  project?: boolean;
};

/**
 * in a skin with campaigns (social), Add job / Add campaign or job is the job form (a new epic in one of the world's
 * repos through POST /api/tenants/:id/jobs: the console's Create a new epic launches an agent on any checkout, the home world's
 * only); everything else is the console's Add milestone dialog.
 */
export function MilestoneDialog(props: MilestoneDialogProps) {
  const campaigns = !!useSkin().campaigns;
  // in a customer workspace the console's Create a new epic (an agent on a checkout) is the home world's
  // only, so Add project writes the project's spine in the workspace's own repo through the same jobs route.
  const { data: world } = useQuery(() => (props.open && !campaigns ? worldId() : Promise.resolve(undefined)), [props.open, campaigns]);
  const w = world ?? knownWorld();
  const customer = !campaigns && !!w && w !== homeWorld();
  if (customer && props.focusAt == null) return <JobDialog {...props} project />;
  return campaigns && (props.job || props.offerCampaign) && props.focusAt == null ? <JobDialog {...props} /> : <MilestoneFormDialog {...props} />;
}

/** what should be done, Done means, which repo and persona; Add and start or Add as draft. */
function JobDialog({ open, onOpenChange, onCreated, offerCampaign, onCampaign, project }: MilestoneDialogProps) {
  const { data: camps } = useQuery(async () => (open ? (project ? { tenantId: await worldId(), campaigns: [] } : api.listCampaigns(await worldId())) : undefined), [open, project]);
  const { data: personas = [] } = useQuery(() => (open ? api.listPersonas() : Promise.resolve([] as Persona[])), [open]);
  // a workspace's project goes in one of its own repos (GET /api/repos lists only the caller's)
  const { data: ownRepos = [] } = useQuery(() => (open && project ? api.listRepos() : Promise.resolve([] as Repo[])), [open, project]);
  const repos = project ? ownRepos.map((r) => ({ value: r.name, label: r.remote ?? r.name })) : repoCards(camps?.campaigns).map((c) => ({ value: c.repo, label: c.remote ?? c.repo }));
  const [title, setTitle] = useState("");
  const [done, setDone] = useState("");
  const [repo, setRepo] = useState("");
  const [persona, setPersona] = useState("");
  const [busy, setBusy] = useState<"start" | "draft">();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDone("");
    setPersona("");
    setError(undefined);
  }, [open]);
  const repoValue = repo || repos[0]?.value || "";
  const submit = async (draft: boolean) => {
    const doneMeans = done.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
    if (!title.trim() || !doneMeans.length || !repoValue) return setError("Say what should be done and at least one Done means line.");
    setBusy(draft ? "draft" : "start");
    setError(undefined);
    try {
      const r = await mutate(async () => {
        const out = await api.addJob(camps!.tenantId, { repo: repoValue, title: title.trim(), doneMeans, ...(persona ? { personaId: persona } : {}), ...(draft ? { draft } : {}) });
        // Add and start: the persona wakes now (L-37: his ask is his ready stamp), not at its next 09:00.
        // a workspace's personas wait for its own sealed box: its project is added, nobody is woken
        if (!draft && !project && out.assignmentId) await api.runAssignmentNow(out.assignmentId, `New job: ${title.trim()} (${ownerName()} pressed Add and start).`);
        return out;
      });
      onOpenChange(false);
      onCreated?.({ id: r.milestoneId } as Milestone);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <div className="grid gap-4" data-testid="job-dialog">
          <DialogHeader>
            <DialogTitle>{project ? "Add project" : offerCampaign ? "Add campaign or job" : "Add job"}</DialogTitle>
            <DialogDescription>
              {project
                ? "A project is one goal for your team, with what done means. It is saved in your workspace and shows on Home."
                : "A job is one piece of work with a beginning and an end (research, a launch post, a one-time video). It shows on Home under its project until it is done."}
            </DialogDescription>
          </DialogHeader>
          {offerCampaign && (
            <div role="radiogroup" aria-label="Campaign or job" className="grid gap-2 sm:grid-cols-2" data-testid="campaign-or-job">
              <button type="button" role="radio" aria-checked={false} onClick={onCampaign} className="flex items-start gap-2.5 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent/60" data-testid="choose-campaign">
                <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="grid gap-0.5">
                  <span className="font-medium">Campaign</span>
                  <span className="text-xs text-muted-foreground">Posts on a schedule, steered by a brief (pinned). Opens the New campaign wizard.</span>
                </span>
              </button>
              <button type="button" role="radio" aria-checked className="flex items-start gap-2.5 rounded-lg border border-primary bg-accent p-3 text-left text-sm ring-1 ring-primary" data-testid="choose-job">
                <Briefcase className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="grid gap-0.5">
                  <span className="font-medium">Job</span>
                  <span className="text-xs text-muted-foreground">One piece of work with an end.</span>
                </span>
              </button>
            </div>
          )}
          {/* a retired campaign (paused, out of the menu) comes back from here, pinned again with its personas. */}
          {offerCampaign && (camps?.campaigns ?? []).some((c) => c.retired && c.milestoneId) && (
            <div className="grid gap-1 rounded-lg border border-dashed p-3 text-sm" data-testid="retired-campaigns">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Retired campaigns</span>
              {(camps?.campaigns ?? [])
                .filter((c) => c.retired && c.milestoneId)
                .map((c) => (
                  <span key={c.milestoneId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-words">{c.title}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="campaign-restore"
                      onClick={async () => {
                        await mutate(() => api.restoreCampaign(camps!.tenantId, c.milestoneId!));
                        onOpenChange(false);
                        onCreated?.({ id: c.milestoneId } as Milestone);
                      }}
                    >
                      Restore
                    </Button>
                  </span>
                ))}
            </div>
          )}
          <Field label="What should be done?">
            <Input aria-label="What should be done?" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={project ? "e.g. launch the new pricing page" : "e.g. find 10 subreddits that allow tool posts"} />
          </Field>
          <Field label="Done means…" hint="One line each">
            <Textarea aria-label="Done means" rows={3} value={done} onChange={(e) => setDone(e.target.value)} placeholder="e.g. the list is in the brief with each sub's rules" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="In" hint={project ? "Your workspace's repo" : "This world's repo"}>
              <NativeSelect aria-label="Repo" value={repoValue} onChange={(e) => setRepo(e.target.value)}>
                {repos.length === 0 && <option value="">{project ? "No repo yet: it is made when your plan is paid" : "No repo yet: start a campaign first"}</option>}
                {repos.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Persona" hint={project ? "Who works it once your team starts" : "Who works it (wakes daily until done)"}>
              <NativeSelect aria-label="Persona" value={persona} onChange={(e) => setPersona(e.target.value)}>
                <option value="">Nobody yet</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <FormError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {project ? (
              <Button type="button" disabled={!!busy || !repoValue} pending={busy === "start"} pendingLabel="Adding…" onClick={() => submit(false)} data-testid="project-add">
                Add project
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={!!busy || !repoValue} pending={busy === "draft"} pendingLabel="Adding…" onClick={() => submit(true)}>
                  Add as draft
                </Button>
                <Button type="button" disabled={!!busy || !repoValue} pending={busy === "start"} pendingLabel="Adding and starting…" onClick={() => submit(false)} data-testid="job-start">
                  Add and start
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MilestoneFormDialog({
  open,
  onOpenChange,
  onCreated,
  focusAt,
}: MilestoneDialogProps) {
  const blank = { title: "", path: "", owner: ownerName(), goal: "", kind: "spine" as "spine" | "ticket" };
  const [form, setForm] = useState(blank);
  const [repo, setRepo] = useState<Repo>();
  // Explicit first choice after the repo: track an existing file, or bootstrap a new epic.
  const [mode, setMode] = useState<MilestoneMode>();
  const [choice, setChoice] = useState<PathChoice>();
  const [titleTouched, setTitleTouched] = useState(false);
  const w = useWords();
  const { busy, error, run } = useSubmit(() => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    setForm(blank);
    setRepo(undefined);
    setMode(undefined);
    setChoice(undefined);
    setTitleTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickRepo = (r: Repo) => {
    setRepo(r);
    setChoice(undefined);
    setForm((f) => ({ ...f, path: "", title: titleTouched ? f.title : "" }));
  };
  const pickMode = (next: MilestoneMode) => {
    setMode(next);
    setChoice(undefined);
    setForm((f) => ({ ...f, path: "", title: titleTouched ? f.title : "" }));
  };
  const choose = (c: PathChoice) => {
    setChoice(c);
    if (c.kind === "doc")
      setForm((f) => ({ ...f, path: c.doc.path, title: titleTouched ? f.title : `${repo!.name} · ${c.doc.title}` }));
    else setForm((f) => ({ ...f, path: "" }));
  };

  const creating = mode === "create";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!repo || !mode) return;
    run(async () => {
      // Stored as owner/name when on GitHub, else the checkout path (the server resolves both).
      const repoRef = repo.remote ?? repo.path;
      const focus = focusAt != null ? { bigRoot: focusAt } : {};
      let m = creating
        ? (await api.bootstrapMilestone({ repo: repoRef, title: form.title, goal: form.goal, kind: form.kind, owner: form.owner })).milestone
        : await api.createMilestone({ title: form.title, repo: repoRef, path: form.path, owner: form.owner, ...focus });
      if (creating && focusAt != null) m = await api.updateMilestone(m.id, focus);
      onCreated?.(m);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{focusAt != null ? `New focus ${w.milestone}` : w.addMilestone}</DialogTitle>
            <DialogDescription>
              {focusAt != null && (
                <span className="mb-1 block" data-testid="focus-hint">
                  It is pinned to your focus {w.milestonesWord} at number {focusAt} (reorder or unpin it on the Team home) and saved in your team repo.{" "}
                </span>
              )}
              {creating
                ? "An agent in the repo creates the spine or epic ticket per that repo's EpicSpine conventions, commits it, and sets the path."
                : `A ${w.milestone} points at a spine or epic ticket in a repo; its status is read from there.`}
            </DialogDescription>
          </DialogHeader>
          <Field label="Repo" hint={`Git checkouts on ${mainHost()}`}>
            <RepoPicker value={repo} onChange={pickRepo} />
          </Field>
          {repo && (
            <div role="radiogroup" aria-label={`${cap(w.milestone)} source`} className="grid gap-2 sm:grid-cols-2">
              {MODES.map(({ value, label, hint, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  onClick={() => pickMode(value)}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent/60",
                    mode === value && "border-primary bg-accent ring-1 ring-primary",
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {repo && mode === "track" && (
            <Field label="Path" hint={`Spine or epic ticket in ${repo.name}`}>
              <DocPicker repo={repo} choice={choice} onChoose={choose} />
              {choice?.kind === "custom" && (
                <Input
                  aria-label="Custom path"
                  required
                  autoFocus
                  value={form.path}
                  onChange={(e) => setForm({ ...form, path: e.target.value })}
                  placeholder="docs/spines/my-epic.md"
                />
              )}
            </Field>
          )}
          {repo && mode && (
            <>
              <Field label="Title" hint={mode === "track" ? "Prefilled from the file; edit freely" : undefined}>
                <Input
                  aria-label="Title"
                  required
                  value={form.title}
                  onChange={(e) => {
                    setTitleTouched(true);
                    setForm({ ...form, title: e.target.value });
                  }}
                  placeholder={`${opsRepo()} · E5 Fleet Observatory`}
                />
              </Field>
              {creating && (
                <>
                  <Field label="Goal" hint="The agent drafts the DoD / Acceptance checklist from this">
                    <Textarea aria-label="Goal" required value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} rows={4} />
                  </Field>
                  <Field label="Kind">
                    <NativeSelect
                      aria-label="Kind"
                      value={form.kind}
                      onChange={(e) => setForm({ ...form, kind: e.target.value as "spine" | "ticket" })}
                    >
                      <option value="spine">Spine (epic)</option>
                      <option value="ticket">Epic ticket</option>
                    </NativeSelect>
                  </Field>
                </>
              )}
              <Field label="Owner">
                <Input aria-label="Owner" required value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
              </Field>
            </>
          )}
          <FormError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !repo || !mode || (creating ? !form.goal.trim() : !form.path.trim())} pending={busy} pendingLabel={creating ? "Creating…" : "Adding…"}>
              {creating ? (focusAt != null ? "Create epic as focus" : "Create epic") : focusAt != null ? `Add focus ${w.milestone}` : w.addMilestone}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Persona ----------

// Personas are reusable across milestones: the wake prompt (server wakePrompt.ts) adds the milestone title,
// repo and spine path, so the remit should describe the job only. In the skin's word (project on EpicTeam).
export const remitHint = (unit: string = DEFAULT_SKIN.words.milestone) =>
  `Write the job, not the ${unit}. At each wake the persona is told which ${unit}, repo and spine it is working on.`;
export const remitPlaceholder = (unit: string = DEFAULT_SKIN.words.milestone) =>
  `Read the ${unit}'s spine and backlog. If something is unblocked and unowned, launch an agent to do it; if blocked, say who it waits on.`;

export const MODEL_OPTIONS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

/**
 * the persona's team skills, picked from the team library only (Team skills screen; never free text). A skill the
 * persona already holds that the library lacks stays, flagged, until the owner takes it off (its wakes fail the skill check).
 * in a world other than the home world the list is the team's base skills plus the world's own (its Skills page); ticked
 * assigns, unticked unassigns.
 */
export function SkillPicker({ value, onChange }: { value: string[]; onChange: (skills: string[]) => void }) {
  const { data, error } = useQuery(() => api.listTeamSkills(), []);
  // the world's own skills first (it added them for its personas), then the base every world has
  const library = [...(data?.skills ?? [])].sort((a, b) => (a.scope === "world" ? 0 : 1) - (b.scope === "world" ? 0 : 1));
  const known = new Set(library.map((s) => s.name));
  const world = !!data?.world;
  const unknown = data ? value.filter((s) => !known.has(s)) : [];
  const toggle = (name: string, on: boolean) => onChange(on ? [...value.filter((x) => x !== name), name] : value.filter((x) => x !== name));
  return (
    <Field
      label="Skills"
      hint={world ? "Tick a skill to assign it, untick it to take it off. Its wake names each one with its use-when line." : "From the team library (Team skills); the wake names each one with its use-when line"}
    >
      <div className="grid gap-1.5 rounded-md border border-input p-2" role="group" aria-label="Skills" data-testid="skill-picker">
        {error && <p className="text-xs text-destructive">Team skills could not be loaded: {error.message}</p>}
        {!data && !error && <p className="text-xs text-muted-foreground">Loading the team library…</p>}
        {data && !library.length && <p className="text-xs text-muted-foreground">The team library is empty: add skills on the Team skills screen.</p>}
        {library.map((s) => (
          <label key={s.name} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-muted/50">
            <input type="checkbox" className="mt-1" aria-label={s.name} checked={value.includes(s.name)} onChange={(e) => toggle(s.name, e.target.checked)} />
            <span className="grid">
              <span className="text-sm font-medium">
                {s.name}
                {s.scope === "world" && (
                  <Badge variant="secondary" className="ml-1.5 align-middle text-[10px]">
                    this world's
                  </Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{s.useWhen}</span>
            </span>
          </label>
        ))}
        {unknown.map((s) => (
          <div key={s} className="flex items-center justify-between gap-2 rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs" data-testid={`unknown-skill-${s}`}>
            <span>
              <Badge variant="amber">not in the library</Badge> <code>{s}</code>: no seat installs it, so this persona's wakes fail the skill check
            </span>
            <button type="button" aria-label={`Remove ${s}`} className="underline opacity-80 hover:opacity-100" onClick={() => toggle(s, false)}>
              take off
            </button>
          </div>
        ))}
      </div>
    </Field>
  );
}

export function PersonaDialog({ open, onOpenChange, persona }: DialogProps & { persona?: Persona }) {
  const w = useWords();
  const blank = { name: "", remit: "", skills: [] as string[], model: "claude-sonnet-5-5", mayWrite: false, host: mainHost() as PersonaHost, freshThreadEachWake: false, skipUnchanged: true };
  const [form, setForm] = useState(blank);
  const { busy, error, run } = useSubmit(() => onOpenChange(false));
  // a new persona can start from a generic template (the code repo/personas/templates).
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [from, setFrom] = useState("");

  useEffect(() => {
    if (!open || persona) return;
    let alive = true;
    api.listPersonaTemplates().then((t) => alive && setTemplates(t), () => alive && setTemplates([]));
    return () => {
      alive = false;
    };
  }, [open, persona]);

  const startFrom = (name: string) => {
    setFrom(name);
    const t = templates.find((x) => x.name === name);
    if (!t) return;
    const prev = templates.find((x) => x.name === from);
    setForm((f) => ({
      ...f,
      name: !f.name || f.name === prev?.name ? t.name : f.name,
      remit: t.prompt,
      model: t.model,
      host: t.host === workerHost() ? workerHost() : mainHost(),
      skills: t.skills ?? f.skills, // the template's team skills
    }));
  };

  useEffect(() => {
    if (!open) return;
    setFrom("");
    setForm(
      persona
        ? { name: persona.name, remit: persona.remit, skills: [...persona.skills], model: persona.model, mayWrite: persona.mayWrite, host: persona.host ?? mainHost(), freshThreadEachWake: !!persona.freshThreadEachWake, skipUnchanged: persona.skipUnchanged !== false }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, persona]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => (persona ? api.updatePersona(persona.id, form) : api.createPersona(form)));
  };

  const models = MODEL_OPTIONS.includes(form.model) ? MODEL_OPTIONS : [form.model, ...MODEL_OPTIONS];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{persona ? `Edit ${persona.name}` : "New persona"}</DialogTitle>
            <DialogDescription>A reusable role. Attach it to any {w.milestone} with a cadence.</DialogDescription>
          </DialogHeader>
          {!persona && templates.length > 0 && (
            <Field label="Start from" hint="A generic template fills the name, remit, model and host; edit them before creating">
              <NativeSelect aria-label="Start from" value={from} onChange={(e) => startFrom(e.target.value)}>
                <option value="">Blank</option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Name">
            <Input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="infra-steward" />
          </Field>
          <Field label="Remit" hint={remitHint(w.milestone)}>
            <Textarea
              aria-label="Remit"
              required
              rows={7}
              value={form.remit}
              onChange={(e) => setForm({ ...form, remit: e.target.value })}
              placeholder={remitPlaceholder(w.milestone)}
            />
          </Field>
          <SkillPicker value={form.skills} onChange={(skills) => setForm({ ...form, skills })} />
          <Field label="Model">
            <NativeSelect value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Host">
            <NativeSelect aria-label="Host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value as PersonaHost })}>
              <option value={mainHost()}>{mainHost().toUpperCase()} (always on)</option>
              <option value={workerHost()}>{workerHost().toUpperCase()} (ephemeral box: starts on wake, 1-5 min; fails the run if it cannot start)</option>
            </NativeSelect>
          </Field>
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="grid gap-1">
              <span className="text-sm font-medium">Write by default</span>
              <span className="text-xs text-muted-foreground">default for NEW assignments only; each assignment's write switch and scope decide. Off = diagnose only</span>
            </span>
            <Switch checked={form.mayWrite} onCheckedChange={(v) => setForm({ ...form, mayWrite: v })} />
          </label>
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="grid gap-1">
              <span className="text-sm font-medium">Fresh thread each wake</span>
              <span className="text-xs text-muted-foreground">each wake starts a new thread with the full prompt, no memory of earlier wakes. Off = one home thread</span>
            </span>
            <Switch aria-label="Fresh thread each wake" checked={form.freshThreadEachWake} onCheckedChange={(v) => setForm({ ...form, freshThreadEachWake: v })} />
          </label>
          <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <span className="grid gap-1">
              <span className="text-sm font-medium">Skip wakes when nothing changed</span>
              <span className="text-xs text-muted-foreground">a cadence wake with no spine or data/ change, no worker finished or started, no new answer and no free seat for ready work is recorded as "nothing new" and costs no run. At most 6 in a row. Run now always runs</span>
            </span>
            <Switch aria-label="Skip wakes when nothing changed" checked={form.skipUnchanged} onCheckedChange={(v) => setForm({ ...form, skipUnchanged: v })} />
          </label>
          <FormError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} pending={busy} pendingLabel={persona ? "Saving…" : "Creating…"}>
              {persona ? "Save" : "Create persona"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Assignment (attach / edit) ----------

const INTERVAL_PRESETS = [30, 60, 120, 240, 360, 720, 1440];
/** a new ask wakes the Unblocker within minutes, so its cadence is a slow backstop (6 h by default; tunable here). */
export const defaultEveryMinutes = (personaName?: string) => (/unblocker/i.test(personaName ?? "") ? 360 : 120);

export function AssignmentDialog({
  open,
  onOpenChange,
  milestoneId,
  assignment,
  objective,
}: DialogProps & { milestoneId: string; assignment?: Assignment; /** attached from an objective's Personas tab: it works that objective. */ objective?: string }) {
  const w = useWords();
  const { data: personas } = useQuery(() => api.listPersonas(), []);
  const [personaId, setPersonaId] = useState("");
  const [type, setType] = useState<Cadence["type"]>("interval");
  const [everyMinutes, setEveryMinutes] = useState(120);
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const { busy, error, run } = useSubmit(() => onOpenChange(false));

  useEffect(() => {
    if (!open) return;
    const c = assignment?.cadence;
    setPersonaId(assignment?.personaId ?? "");
    setType(c?.type ?? "interval");
    setEveryMinutes(c?.type === "interval" ? c.everyMinutes : 120);
    setTimeOfDay(c?.type === "fixed_time" ? c.timeOfDay : "09:00");
    setWeekdays(c?.type === "fixed_time" ? c.weekdays : [1, 2, 3, 4, 5]);
  }, [open, assignment]);

  useEffect(() => {
    if (open && !personaId && personas?.length) setPersonaId(personas[0].id);
  }, [open, personaId, personas]);

  // Attaching (not editing): the cadence starts at the chosen persona's default.
  useEffect(() => {
    if (open && !assignment && personaId) setEveryMinutes(defaultEveryMinutes(personas?.find((p) => p.id === personaId)?.name));
  }, [open, assignment, personaId, personas]);

  const cadence: Cadence =
    type === "interval" ? { type, everyMinutes: Math.max(1, everyMinutes || 1) } : { type, timeOfDay, weekdays: [...weekdays].sort((a, b) => a - b) };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (type === "fixed_time" && weekdays.length === 0) return;
    run(() =>
      assignment
        ? api.updateAssignment(assignment.id, { personaId, cadence })
        : // Attached disabled (safety): it starts waking only when toggled on.
          api.createAssignment({ milestoneId, personaId, cadence, enabled: false, ...(objective ? { objective } : {}) }),
    );
  };

  const toggleDay = (d: number) => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{assignment ? "Edit assignment" : "Attach persona"}</DialogTitle>
            <DialogDescription>The persona wakes on this cadence to push the {w.milestone} forward.</DialogDescription>
          </DialogHeader>
          <Field label="Persona">
            <NativeSelect required value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              {!personas?.length && <option value="">No personas yet: create one on the Personas page</option>}
              {personas?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Cadence</span>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-sm">
              {(["interval", "fixed_time"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={cn("rounded-md px-3 py-1.5 font-medium", type === t ? "bg-background shadow" : "text-muted-foreground")}
                >
                  {t === "interval" ? "Every N minutes" : "Fixed time"}
                </button>
              ))}
            </div>
            {type === "interval" ? (
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    className="w-28"
                    value={everyMinutes}
                    onChange={(e) => setEveryMinutes(parseInt(e.target.value, 10) || 0)}
                  />
                  <span className="text-sm text-muted-foreground">minutes</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {INTERVAL_PRESETS.map((m) => (
                    <Button key={m} type="button" size="sm" variant={everyMinutes === m ? "default" : "outline"} onClick={() => setEveryMinutes(m)}>
                      {formatCadence({ type: "interval", everyMinutes: m }).replace("every ", "")}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="grid gap-2">
                <Input type="time" required className="w-32" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <Button key={d} type="button" size="sm" variant={weekdays.includes(d) ? "default" : "outline"} onClick={() => toggleDay(d)}>
                      {WEEKDAY_SHORT[d]}
                    </Button>
                  ))}
                </div>
                {weekdays.length === 0 && <p className="text-xs text-destructive">Pick at least one day.</p>}
              </div>
            )}
            <p className="text-xs text-muted-foreground">Wakes {formatCadence(cadence)}.</p>
          </div>
          <FormError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !personaId} pending={busy} pendingLabel={assignment ? "Saving…" : "Attaching…"}>
              {assignment ? "Save" : "Attach"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Steer ----------

/**
 * Steer a running persona (by its assignment) or, one running run by its id (a child worker: `run`), into that
 * run's own thread.
 */
export function SteerDialog({
  open,
  onOpenChange,
  assignment,
  run: target,
  personaName,
}: DialogProps & { assignment?: Assignment; run?: Run; personaName?: string }) {
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState("");
  const [sent, setSent] = useState<string>();
  const { busy, error, run } = useSubmit(() => onOpenChange(false));
  const worker = !!target?.parentRunId;
  // the one box: a screenshot he pastes goes to the run as a link after his words.
  const files = useChatAttach({ enabled: true, disabled: busy });
  useEffect(() => {
    if (!open) return;
    setMessage("");
    files.clear();
    setSent(undefined);
    setRequestId(`console-steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`); // one id per open dialog (not crypto.randomUUID: the console is served over plain http): a retry after an error is idempotent
  }, [open]);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if ((!assignment && !target) || (!message.trim() && !files.ids.length) || !files.ready) return;
    void run(async () => {
      const words = (await wordsWithFiles(message, files.ids)).trim();
      const r = target ? await api.steerRun(target.id, words, requestId) : await api.steerAssignment(assignment!.id, words, requestId);
      setSent(r.mode === "auto" ? "Queued: the turn is not steerable yet." : "Sent.");
      return r;
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={send} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Steer {worker ? "worker" : (personaName ?? "persona")}</DialogTitle>
            <DialogDescription>
              {worker ? "Adds your message to this worker's thread; it reads it on its current turn." : "Adds your message to the running thread; the persona reads it on its current turn."}
            </DialogDescription>
          </DialogHeader>
          <WordsBox label="Message" rows={5} boxClassName="min-h-28" value={message} onChange={setMessage} files={files} placeholder="e.g. Skip E4 for now and unblock S5 first." testid="steer-box" />
          <FormError error={error} />
          {sent && !error && <p className="text-sm text-muted-foreground">{sent}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !files.ready || (!message.trim() && !files.ids.length)}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Stop ----------

/**
 * Stop a running run now (T3 interrupt): the run ends `stopped` with this reason and nothing resumes on its own. When the
 * run has running child workers, "and its workers" stops them too; unticked they run on.
 */
export function StopDialog({ open, onOpenChange, run: target, workers = 0, who }: DialogProps & { run?: Run; workers?: number; who?: string }) {
  const [reason, setReason] = useState("");
  const [withWorkers, setWithWorkers] = useState(false);
  const [note, setNote] = useState<string>();
  const { busy, error, run } = useSubmit(() => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    setReason("");
    setWithWorkers(false);
    setNote(undefined);
  }, [open]);
  const stop = (e: FormEvent) => {
    e.preventDefault();
    if (!target || !reason.trim() || busy) return;
    void run(async () => {
      const r = await api.stopRun(target.id, { reason: reason.trim(), ...(workers > 0 ? { withWorkers } : {}) });
      if (r.workerErrors.length) setNote(`Stopped, but ${r.workerErrors.length} worker${r.workerErrors.length === 1 ? "" : "s"} would not stop: ${r.workerErrors.map((w) => w.error).join("; ")}`);
      return r;
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={stop} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Stop {who ?? (target?.parentRunId ? "worker" : "this run")}?</DialogTitle>
            <DialogDescription>Interrupts the running turn now. The run ends as Stopped with your reason; nothing wakes it again on its own.</DialogDescription>
          </DialogHeader>
          <Field label="Why stop it?">
            <Textarea aria-label="Reason" required rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong repo, I will restart it with a note." />
          </Field>
          {workers > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={withWorkers} onChange={(e) => setWithWorkers(e.target.checked)} />
              <span>
                and its workers <span className="text-muted-foreground">({workers} running; left running if unticked)</span>
              </span>
            </label>
          )}
          <FormError error={error} />
          {note && !error && <p className="text-sm text-amber-700 dark:text-amber-400">{note}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
              {busy ? "Stopping…" : "Stop"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Add on a tree node ----------

const ADD_KINDS: { value: AddKind; label: string; hint: string }[] = [
  { value: "row", label: "Ledger row", hint: "A ticket in this epic's Issue Ledger" },
  { value: "done_means", label: "Done-means line", hint: "A new unticked criterion under Done means (ready: with a row that builds it)" },
  { value: "epic", label: "Child epic", hint: "A child epic scaffolded under this one" },
];

/**
 * Add under a tree node. Written to the spine (commit + push). the owner's ask is ready by default and wakes
 * the Delivery manager; "Just register it (draft)" keeps it a draft that nobody works until he stamps it ready.
 */
export function AddDialog({ open, onOpenChange, milestoneId, path, nodeTitle }: DialogProps & { milestoneId: string; path?: string; nodeTitle?: string }) {
  const [kind, setKind] = useState<AddKind>("row");
  const [title, setTitle] = useState("");
  const [line, setLine] = useState("");
  const [draft, setDraft] = useState(false);
  const [done, setDone] = useState<string>();
  const { busy, error, run } = useSubmit(() => onOpenChange(false));
  useEffect(() => {
    if (!open) return;
    setKind("row");
    setTitle("");
    setLine("");
    setDraft(false);
    setDone(undefined);
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    void run(async () => {
      const r = await api.addToTree(milestoneId, { kind, title: title.trim(), ...(line.trim() ? { line: line.trim() } : {}), ...(path ? { path } : {}), ...(draft ? { draft: true } : {}) });
      setDone(`Added ${r.id ?? r.newPath ?? ""}${r.rowId ? ` (row ${r.rowId})` : ""} ${r.ready ? "ready" : "as a draft"}.`.replace("  ", " "));
      return r;
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add under {nodeTitle ?? "this epic"}</DialogTitle>
            <DialogDescription>
              {draft
                ? "Written to the spine as a draft (committed and pushed); nobody works it until you stamp it ready."
                : "Your ask is ready (root L-37): written to the spine with a Decisions row citing it (committed and pushed), and the Delivery manager wakes to plan and dispatch it."}
            </DialogDescription>
          </DialogHeader>
          <Field label="What">
            <NativeSelect aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as AddKind)}>
              {ADD_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </NativeSelect>
            <span className="text-xs text-muted-foreground">{ADD_KINDS.find((k) => k.value === kind)?.hint}</span>
          </Field>
          <Field label="Title">
            <Input aria-label="Title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="One line" hint="Optional: what it is, in a sentence">
            <Input aria-label="One line" maxLength={300} value={line} onChange={(e) => setLine(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} data-testid="add-draft" />
            <span>
              Just register it (draft) <span className="text-muted-foreground">no row, no wake: nobody works it yet</span>
            </span>
          </label>
          <FormError error={error} />
          {done && !error && <p className="text-sm text-muted-foreground">{done}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? "Adding…" : draft ? "Add draft" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Run now ----------

/** Run now with optional one-off instructions for that wake only; empty = a plain Run now. Ctrl/Cmd+Enter submits. */
/** a non-runnable milestone's run_state as the owner reads it. */
const RUN_STATE_LABEL: Record<string, string> = { planning: "Planning", parked: "Parked", finished: "Finished", ready: "Ready", running: "Running" };

export function RunNowDialog({
  open,
  onOpenChange,
  assignment,
  personaName,
  milestone,
}: DialogProps & { assignment?: Assignment; personaName?: string; milestone?: Pick<Milestone, "runState" | "runnable"> }) {
  const [note, setNote] = useState("");
  // waking a spine a wake would not work (draft, deferred, finished) is the owner's explicit one-off act.
  const notRunnable = milestone?.runnable === false;
  const [confirmed, setConfirmed] = useState(false);
  const { busy, error, run } = useSubmit(() => onOpenChange(false));
  // one request at a time (a ref, so a second click before the re-render is dropped), each with its own id the
  // server dedupes on: a replayed POST returns the same run instead of "still running".
  const inFlight = useRef(false);
  // the one box: a screenshot he pastes goes with the instructions as a link after his words.
  const files = useChatAttach({ enabled: true, disabled: busy });
  useEffect(() => {
    if (open) {
      setNote("");
      files.clear();
      setConfirmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!assignment || busy || inFlight.current || !files.ready || (notRunnable && !confirmed)) return;
    inFlight.current = true;
    const clientRequestId = `console-run-now-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // not crypto.randomUUID: plain http
    void run(async () => api.runAssignmentNow(assignment.id, (await wordsWithFiles(note, files.ids)).trim() || undefined, clientRequestId)).finally(() => (inFlight.current = false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Run {personaName ?? "persona"} now</DialogTitle>
            <DialogDescription>Wakes the persona now. Instructions apply to this wake only; leave empty for a normal wake.</DialogDescription>
            {assignment && !assignment.enabled && (
              <p className="text-sm text-orange-700 dark:text-orange-400" data-testid="one-off-wake">
                {personaName ?? "This persona"} is off: this is a one-off wake. It books no next wake and no follow-up; switch it on to keep it working.
              </p>
            )}
          </DialogHeader>
          <Field label="Instructions for this run" hint="Optional. Overrides its usual next-item choice, not its write rule or ask tier.">
            <WordsBox
              label="Instructions for this run"
              rows={5}
              boxClassName="min-h-28"
              value={note}
              onChange={setNote}
              files={files}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
              }}
              placeholder="e.g. Finish S5 before anything else; skip the deploy today."
              testid="run-now-box"
            />
          </Field>
          {notRunnable && (
            <label className="flex items-start justify-between gap-4 rounded-lg border border-amber-300 p-3 dark:border-amber-700">
              <span className="grid gap-1">
                <span className="text-sm font-medium text-amber-700 dark:text-amber-400">
                  This epic is {RUN_STATE_LABEL[milestone?.runState ?? ""] ?? milestone?.runState ?? "not runnable"}: a wake would not work it
                </span>
                <span className="text-xs text-muted-foreground">Cadence wakes skip it. Confirm to wake the persona once anyway.</span>
              </span>
              <Switch aria-label="Wake it anyway" checked={confirmed} onCheckedChange={setConfirmed} />
            </label>
          )}
          <FormError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !files.ready || (notRunnable && !confirmed)}>
              {busy ? "Starting…" : notRunnable ? "Run anyway" : "Run"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Confirm ----------

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
}: DialogProps & { title: string; description?: ReactNode; confirmLabel?: string; onConfirm: () => Promise<unknown> }) {
  const { busy, error, run } = useSubmit(() => onOpenChange(false));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <FormError error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} pending={busy} pendingLabel="Working…" onClick={() => run(onConfirm)}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
