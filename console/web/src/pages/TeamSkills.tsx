import { useState, type FormEvent } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { api, type TeamSkill, type TeamSkillPreview, type TeamSkillSync } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { useSkin } from "@/lib/skin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, ErrorBox, Field, Loading, PageHeader } from "@/components/common";
import { ownerName, homeRepo } from "@/lib/identity";
import { TEAM_SKILLS_PATH } from "@/lib/routePaths";
export { TEAM_SKILLS_PATH };

/**
 * the team skills library. One list (the code repo skills/team-skills.json) installed on every seat; each
 * persona attaches the ones it uses in its editor (a pick-list from this library only). the owner adds a skill by GitHub URL
 * (previewed and pinned to its current commit before he confirms) and removes one (warned when personas still use it).
 * in a world other than the home world (the social product's "Skills") the team library is the base every world has,
 * shown read-only with its use-when line and who uses it; below it the world's own skills, which its owner adds the same way
 * (into the world's repo) and removes. Personas tick either kind in their editor.
 */

const short = (sha?: string) => (sha ? sha.slice(0, 7) : "");

function SourceCell({ s }: { s: TeamSkill }) {
  const label = s.source.type === "github" ? `${s.source.repo}${s.source.path ? `/${s.source.path}` : ""}` : `${homeRepo()}/${s.source.path ?? ""}`;
  return (
    <div className="space-y-0.5 text-xs">
      {s.url ? (
        <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
          {label} <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <span>{label}</span>
      )}
      <div className="text-muted-foreground">{s.source.type === "github" ? <>pinned to <code data-testid={`commit-${s.name}`}>{short(s.source.commit)}</code></> : `ours (${homeRepo()} main)`}</div>
    </div>
  );
}

function SyncLines({ sync }: { sync?: TeamSkillSync[] }) {
  if (!sync?.length) return null;
  return (
    <ul className="space-y-0.5 text-xs" data-testid="sync-lines">
      {sync.map((x) => (
        <li key={x.host}>
          <Badge variant={x.ok ? "green" : "amber"}>{x.host}</Badge> {x.note}
        </li>
      ))}
    </ul>
  );
}

export function AddSkillDialog({ open, onOpenChange, syncNote, onDone, world }: { open: boolean; onOpenChange: (o: boolean) => void; syncNote: string; onDone: (msg: string, sync?: TeamSkillSync[]) => void; world?: boolean }) {
  const [url, setUrl] = useState("");
  const [useWhen, setUseWhen] = useState("");
  const [preview, setPreview] = useState<TeamSkillPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reset = () => {
    setUrl("");
    setUseWhen("");
    setPreview(undefined);
    setError(undefined);
  };
  const close = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };
  const step = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const doPreview = (e: FormEvent) => {
    e.preventDefault();
    void step(async () => setPreview(await api.previewTeamSkill({ url: url.trim() })));
  };
  const confirm = () =>
    void step(async () => {
      const r = await mutate(() => api.addTeamSkill({ url: url.trim(), commit: preview?.skill.source.commit, ...(useWhen.trim() ? { useWhen: useWhen.trim() } : {}) }));
      onDone(
        r.action === "unchanged"
          ? `${r.skill.name} is already ${world ? "one of this workspace's skills" : "in the library"} at this commit.`
          : `${r.skill.name} ${r.action === "repinned" ? "repinned" : "added"}${r.sha ? ` (commit ${r.sha})` : ""}.${world ? " Tick it on a persona to assign it." : ""}`,
        r.sync,
      );
      close(false);
    });
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <form onSubmit={doPreview} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{world ? "Add a skill to this workspace" : "Add a team skill"}</DialogTitle>
            <DialogDescription>Paste the skill's GitHub URL. You see what it is and the commit it pins before anything is added.</DialogDescription>
          </DialogHeader>
          <Field label="GitHub URL" hint="https://github.com/<owner>/<repo>, or …/tree/<branch>/<path to the skill folder>">
            <Input
              autoFocus
              required
              aria-label="GitHub URL"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setPreview(undefined);
              }}
              placeholder="https://github.com/cathrynlavery/diagram-design"
            />
          </Field>
          {preview && (
            <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="skill-preview">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{preview.skill.name}</span>
                {preview.action !== "added" && <Badge variant={preview.action === "repinned" ? "amber" : "gray"}>{preview.action === "repinned" ? "already in the library: repins it" : "already at this commit"}</Badge>}
              </div>
              <div className="text-muted-foreground">{preview.description || "(no description in its SKILL.md)"}</div>
              <div className="text-xs">
                {preview.skill.source.repo}
                {preview.skill.source.path ? `/${preview.skill.source.path}` : ""} pinned to <code data-testid="preview-commit">{short(preview.skill.source.commit)}</code>
                {preview.url && (
                  <>
                    {" · "}
                    <a href={preview.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      read it
                    </a>
                  </>
                )}
              </div>
              <Field label="Use when" hint="The line each persona's wake shows next to the skill; empty keeps the one below">
                <Input aria-label="Use when" value={useWhen} onChange={(e) => setUseWhen(e.target.value)} placeholder={preview.skill.use_when} />
              </Field>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">{syncNote}</p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            {preview ? (
              <Button type="button" disabled={busy || preview.action === "unchanged"} onClick={confirm} data-testid="skill-confirm">
                {busy ? "Adding…" : `Add ${preview.skill.name}`}
              </Button>
            ) : (
              <Button type="submit" disabled={busy || !url.trim()} data-testid="skill-preview-btn">
                {busy ? "Looking…" : "Preview"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveSkillDialog({ skill, onOpenChange, onDone, world }: { skill?: TeamSkill; onOpenChange: (o: boolean) => void; onDone: (msg: string, sync?: TeamSkillSync[]) => void; world?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const used = skill?.usedBy ?? [];
  const remove = async () => {
    if (!skill) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await mutate(() => api.removeTeamSkill(skill.name, used.length > 0));
      onDone(`${r.removed} removed${r.detachedFrom.length ? `, and taken off ${r.detachedFrom.map((p) => p.name).join(", ")}` : ""}${r.sha ? ` (commit ${r.sha})` : ""}.`, r.sync);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!skill} onOpenChange={(o) => (setError(undefined), onOpenChange(o))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {skill?.name}?</DialogTitle>
          <DialogDescription>{world ? "It leaves this workspace's skills. Its personas stop getting it at their next wake." : "It leaves the team library and every seat at the next sync."}</DialogDescription>
        </DialogHeader>
        {used.length > 0 && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="remove-warning">
            Still attached to <strong>{used.map((p) => p.name).join(", ")}</strong>. Removing it also takes it off {used.length > 1 ? "them" : "that persona"}; their wakes stop naming it.
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={remove} data-testid="skill-remove-confirm">
            {busy ? "Removing…" : used.length ? `Remove from ${world ? "this workspace" : "library"} and ${used.length} persona${used.length > 1 ? "s" : ""}` : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillTable({ skills, onRemove, testId }: { skills: TeamSkill[]; onRemove?: (s: TeamSkill) => void; testId: string }) {
  const removing = !!onRemove && skills.some((s) => s.removable !== false);
  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>Skill</TableHead>
          <TableHead>Use when</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Used by</TableHead>
          {removing && <TableHead className="w-10" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {skills.map((s) => (
          <TableRow key={s.name} data-testid={`skill-${s.name}`}>
            <TableCell className="font-medium">{s.name}</TableCell>
            <TableCell className="max-w-md text-sm text-muted-foreground">{s.useWhen}</TableCell>
            <TableCell>
              <SourceCell s={s} />
            </TableCell>
            <TableCell>
              {s.usedBy.length ? (
                <div className="flex flex-wrap gap-1">
                  {s.usedBy.map((p) => (
                    <Badge key={p.id} variant="secondary">
                      {p.name}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">no persona yet</span>
              )}
            </TableCell>
            {removing && (
              <TableCell>
                {s.removable !== false && (
                  <Button variant="ghost" size="icon" aria-label={`Remove ${s.name}`} onClick={() => onRemove!(s)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function TeamSkillsPage() {
  const { words } = useSkin();
  const { data, error, loading } = useQuery(() => api.listTeamSkills(), []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamSkill>();
  const [done, setDone] = useState<{ msg: string; sync?: TeamSkillSync[] }>();
  const onDone = (msg: string, sync?: TeamSkillSync[]) => setDone({ msg, sync });
  const world = !!data?.world;
  const base = data?.skills.filter((s) => s.scope !== "world") ?? [];
  const own = data?.skills.filter((s) => s.scope === "world") ?? [];
  const addButton = data?.canEdit && (
    <Button size="sm" onClick={() => setAdding(true)} data-testid="add-skill">
      <Plus className="h-4 w-4" /> Add skill
    </Button>
  );
  return (
    <div>
      <PageHeader
        title={words.teamSkills}
        description={
          world
            ? "Your team's skills. Every workspace gets the team's skills, and you can add your own from GitHub. Tick a skill on a persona (Personas, then Edit) to assign it. Its wake then names the skill and when to use it."
            : "One library, installed on every seat. Each persona attaches the skills it uses (Personas → Edit); its wake names them with their use-when line."
        }
        actions={addButton}
      />
      {done && (
        <div className="mb-4 space-y-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm" data-testid="skill-done">
          <div>{done.msg}</div>
          <SyncLines sync={done.sync} />
        </div>
      )}
      {error ? (
        <ErrorBox error={error} />
      ) : loading && !data ? (
        <Loading />
      ) : data?.error ? (
        <ErrorBox error={new Error(`The library cannot be read: ${data.error}`)} />
      ) : world ? (
        <div className="space-y-6">
          <section className="space-y-2" data-testid="world-skills-section">
            <div>
              <h2 className="text-sm font-semibold">This world's own skills</h2>
              <p className="text-xs text-muted-foreground">You added these. Only this world's personas get them.</p>
            </div>
            {own.length ? (
              <SkillTable skills={own} onRemove={setRemoving} testId="world-skills" />
            ) : (
              <Empty>No skills of your own yet.{data?.canEdit ? " Add one from GitHub with Add skill." : ""}</Empty>
            )}
          </section>
          <section className="space-y-2" data-testid="base-skills-section">
            <div>
              <h2 className="text-sm font-semibold">Skills every world has</h2>
              <p className="text-xs text-muted-foreground">These come with the team. You cannot remove them here, but you can untick them on a persona.</p>
            </div>
            {base.length ? <SkillTable skills={base} testId="team-skills" /> : <Empty>No team skills yet.</Empty>}
          </section>
        </div>
      ) : !data?.skills.length ? (
        <Empty>No team skills yet.</Empty>
      ) : (
        <SkillTable skills={data.skills} onRemove={data.canEdit ? setRemoving : undefined} testId="team-skills" />
      )}
      {data && data.unknown.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="unknown-skills">
          <div className="font-medium">Attached but not in the library</div>
          <div className="text-muted-foreground">These personas name a skill no seat installs; their wakes fail the skill check until you add it here or take it off the persona.</div>
          <ul className="mt-1 list-disc pl-5">
            {data.unknown.map((u) => (
              <li key={`${u.persona.id}:${u.skill}`}>
                {u.persona.name}: <code>{u.skill}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data && (
        <p className="mt-4 text-xs text-muted-foreground">
          {data.syncNote}
          {data.canEdit ? "" : world ? " Only the workspace's owner adds or removes its skills." : ` Only ${ownerName()} adds or removes skills.`}
        </p>
      )}
      {data && <AddSkillDialog open={adding} onOpenChange={setAdding} syncNote={data.syncNote} onDone={onDone} world={world} />}
      <RemoveSkillDialog skill={removing} onOpenChange={(o) => !o && setRemoving(undefined)} onDone={onDone} world={world} />
    </div>
  );
}
