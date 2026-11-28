import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MessageCircle, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, type Persona, type WhatsAppHolderView } from "@/api";
import { mutate, useQuery } from "@/lib/data";
import { personaRunStats } from "@/lib/derive";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { ConfirmDialog, PersonaDialog } from "@/components/dialogs";
import { latelyOf } from "@/pages/YourTeam";
import { useProject } from "@/lib/project";
import { scheduleLabel } from "@/lib/format";
import { useWords } from "@/lib/skin";
import { ownerName } from "@/lib/identity";
import { workerHost } from "../lib/identity";

/** who a persona is, in one sentence: the remit's first sentence ("You are the Gap finder."), headings skipped. */
export function whoOf(remit: string): string {
  const text = remit
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join(" ")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = /^(.{1,200}?[.!?])(\s|$)/.exec(text)?.[1] ?? text.slice(0, 200);
  return first;
}

/** the level a milestone runs at: the repo's root spine, else the epic it is. */
export function levelOf(m: { path: string; repo: string }): string {
  const repo = m.repo.split("/").pop() ?? m.repo;
  return /(^|\/)root\.md$/.test(m.path) ? `${repo} root, every epic` : `one epic of ${repo}`;
}

export function PersonasPage() {
  const { data: personas, error, loading } = useQuery(() => api.listPersonas(), []);
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: allMilestones = [] } = useQuery(() => api.listMilestones(), []);
  const w = useWords();
  // the selected project's team: personas on its milestones, and only those milestones named.
  const project = useProject();
  const milestones = allMilestones.filter((m) => project.keep(m.id));
  const { data: runs = [] } = useQuery(() => api.listRuns(), []);
  const { data: me } = useQuery(() => (api.getMe ? api.getMe() : Promise.resolve(undefined)), []);
  const [dialog, setDialog] = useState<{ open: boolean; persona?: Persona }>({ open: false });
  // who sends the owner WhatsApp (absent in other worlds and older fakes)
  const { data: wa } = useQuery(() => (api.getWhatsAppHolder ? api.getWhatsAppHolder().catch(() => undefined) : Promise.resolve(undefined)), []);
  const [toDelete, setToDelete] = useState<Persona>();
  // `/personas?edit=<id>` opens that persona's settings (the decks and the big rocks board link here).
  const [params, setParams] = useSearchParams();
  const editId = params.get("edit");
  useEffect(() => {
    const p = editId ? personas?.find((x) => x.id === editId) : undefined;
    if (!p) return;
    setDialog({ open: true, persona: p });
    setParams((q) => {
      const n = new URLSearchParams(q);
      n.delete("edit");
      return n;
    }, { replace: true });
  }, [editId, personas, setParams]);

  return (
    <>
      <PageHeader
        title="Personas"
        description={`Reusable roles. Attach any persona to any ${w.milestone} from the ${w.milestone}'s Personas tab.`}
        actions={
          <Button onClick={() => setDialog({ open: true })}>
            <Plus /> New persona
          </Button>
        }
      />
      {me?.wakeHold && (
        // the world's personas are held off the shared hosts until its own box exists (the console still works)
        <div className="mb-3 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm" role="status" data-testid="wake-hold">
          These personas do not wake yet: {me.wakeHold}.
        </div>
      )}
      {me?.wakeLimits && (
        // this plan's limits, so the owner sees why a persona wakes less than it is set to
        <div className="mb-3 rounded border p-3 text-sm" role="status" data-testid="wake-limits">
          On this plan your team runs on {me.wakeLimits.model}. The campaign manager wakes at most twice a day, and the Publisher at most twice for each post.
        </div>
      )}
      {wa && personas && <WhatsAppSender view={wa} personas={personas} />}
      {error && <ErrorBox error={error} />}
      {loading && <Loading />}
      {personas?.length === 0 && <Empty>No personas yet.</Empty>}
      <div className="grid gap-3">
        {personas?.filter((p) => !project.current || assignments.every((a) => a.personaId !== p.id) || assignments.some((a) => a.personaId === p.id && project.keep(a.milestoneId) && project.projectOf(a.milestoneId))).map((p) => {
          const on = milestones.filter((m) => assignments.some((a) => a.personaId === p.id && a.milestoneId === m.id));
          const { count } = personaRunStats(p.id, assignments, runs);
          return (
            <Card key={p.id}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge variant="outline">{me?.wakeLimits ? me.wakeLimits.model : p.model}</Badge>
                    {me?.wakeLimits?.personas[p.id] && (
                      <Badge variant="secondary" data-testid="persona-wake-limit">
                        {me.wakeLimits.personas[p.id]}
                      </Badge>
                    )}
                    {p.host === workerHost() && <Badge variant="outline">{workerHost()}</Badge>}
                    {p.mayWrite ? <Badge variant="amber">writes by default</Badge> : <Badge variant="gray">diagnose by default</Badge>}
                    {wa?.holder?.id === p.id && (
                      <Badge variant="secondary" data-testid="persona-wa-holder">
                        <MessageCircle className="mr-1 h-3 w-3" /> sends WhatsApp to {ownerName()}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {count} run{count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-1 text-sm" data-testid="persona-who">
                    {whoOf(p.remit)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground" data-testid="persona-runs">
                    {on.length === 0 ? (
                      `Not attached to any ${w.milestone}`
                    ) : (
                      <>
                        {/* each card says the level it runs at and how often. */}
                        Runs on{" "}
                        {on.map((m, i) => {
                          const a = assignments.find((x) => x.personaId === p.id && x.milestoneId === m.id);
                          return (
                            <Fragment key={m.id}>
                              {i > 0 && "; "}
                              <Link className="text-foreground hover:underline" to={`/milestones/${m.id}?tab=personas`}>
                                {m.title}
                              </Link>{" "}
                              <span>
                                at {levelOf(m)}
                                {a ? `, ${scheduleLabel(a)}` : ""}
                              </span>
                            </Fragment>
                          );
                        })}
                      </>
                    )}
                  </div>
                  {/* what it did lately (was the social skin's Your team cards), both sites. */}
                  {(() => {
                    const lately = latelyOf(p.id, assignments, runs);
                    return lately.length ? (
                      <div className="mt-1 line-clamp-2 text-xs" title={lately.join(" · ")} data-testid="persona-lately">
                        <span className="text-muted-foreground">Lately: </span>
                        {lately.join(" · ")}
                      </div>
                    ) : null;
                  })()}
                  <p className="mt-2 line-clamp-3 whitespace-pre-line text-sm text-muted-foreground">{p.remit}</p>
                  {p.skills.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.skills.map((s) => (
                        <Badge key={s} variant="secondary">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-start gap-2">
                  {/* Run now wakes the persona once, now, when it works on one milestone (else from that milestone's Personas tab). */}
                  {(() => {
                    const own = assignments.filter((a) => a.personaId === p.id);
                    return own.length === 1 ? <RunNowButton assignmentId={own[0].id} name={p.name} /> : null;
                  })()}
                  <Button size="sm" variant="outline" onClick={() => setDialog({ open: true, persona: p })}>
                    <Pencil /> Edit
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${p.name}`} onClick={() => setToDelete(p)}>
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <PersonaDialog open={dialog.open} persona={dialog.persona} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(undefined)}
        title={`Delete ${toDelete?.name ?? "persona"}?`}
        description={`It is detached from every ${w.milestone} it is on.`}
        onConfirm={() => api.deletePersona(toDelete!.id)}
      />
    </>
  );
}

/** wakes the persona's one assignment now (POST run-now); spins, then says what happened next to the button (L-38). */
function RunNowButton({ assignmentId, name }: { assignmentId: string; name: string }) {
  const [state, setState] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({});
  return (
    <span className="grid justify-items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        pending={state.busy}
        pendingLabel="Waking…"
        disabled={state.busy}
        data-testid="persona-run-now"
        onClick={async () => {
          setState({ busy: true });
          try {
            await api.runAssignmentNow(assignmentId, `Run now from the Personas page (${name}).`);
            setState({ ok: true, text: `${name} is waking now` });
          } catch (e) {
            setState({ ok: false, text: (e as Error).message });
          }
        }}
      >
        <Play /> Run now
      </Button>
      {state.text && (
        <span className={state.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"} role="status">
          {state.text}
        </span>
      )}
    </span>
  );
}

/**
 * sending to the owner on WhatsApp is a skill one persona holds; the milestones it is placed on decide
 * what it sends about. Shows who holds it, for which milestones, which path sends now, and lets the owner pick another (L-38).
 */
export function WhatsAppSender({ view, personas }: { view: WhatsAppHolderView; personas: Persona[] }) {
  const w = useWords();
  const [pick, setPick] = useState(view.holder?.id ?? "");
  const [state, setState] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({});
  useEffect(() => setPick(view.holder?.id ?? ""), [view.holder?.id]);
  const name = view.holder?.name;
  const day = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <Card className="mb-3" data-testid="wa-sender">
      <CardContent className="grid gap-2 p-4 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <MessageCircle className="h-4 w-4" /> WhatsApp to {ownerName()}
        </div>
        <p data-testid="wa-holder">
          {name ? (
            <>
              <span className="font-medium">{name}</span> sends your WhatsApp messages{view.holder?.explicit ? "." : ". Nobody was picked, so the Delivery Manager does it."}
            </>
          ) : (
            "No persona sends your WhatsApp messages yet."
          )}
        </p>
        <p className="text-muted-foreground" data-testid="wa-milestones">
          {view.milestones.length ? (
            <>
              It sends about what waits on you in{" "}
              {view.milestones.map((m, i) => (
                <Fragment key={m.id}>
                  {i > 0 && ", "}
                  <Link className="text-foreground hover:underline" to={`/milestones/${m.id}?tab=personas`}>
                    {m.title}
                  </Link>
                </Fragment>
              ))}
              . Place it on more {w.milestonesWord} to widen that.
            </>
          ) : (
            `It is not placed on any ${w.milestone}, so it sends nothing yet.`
          )}
        </p>
        <p className="text-muted-foreground" data-testid="wa-path">
          {view.sender === "persona"
            ? `${name ?? "The persona"} has sent them since ${view.handoverAt ? day(view.handoverAt) : "its test"}. The console only steps in for an item left unsent for 12 hours.`
            : `The console still sends them until ${name ?? "the persona"} sends one test message through its skill.`}
          {view.lastSend ? ` Last message ${day(view.lastSend.at)}${view.lastSend.ok ? "" : ", it failed"}.` : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            aria-label={`Persona that sends WhatsApp to ${ownerName()}`}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            data-testid="wa-pick"
          >
            {!view.holder && <option value="">Pick a persona</option>}
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            pending={state.busy}
            pendingLabel="Saving…"
            disabled={state.busy || !pick || (pick === view.holder?.id && !!view.holder?.explicit) || !api.setWhatsAppHolder}
            data-testid="wa-set"
            onClick={async () => {
              setState({ busy: true });
              try {
                const r = await mutate(() => api.setWhatsAppHolder!(pick));
                setState({ ok: true, text: `${r.holder?.name ?? "It"} now sends your WhatsApp messages` });
              } catch (e) {
                setState({ ok: false, text: (e as Error).message });
              }
            }}
          >
            Make this the sender
          </Button>
          {state.text && (
            <span className={state.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"} role="status">
              {state.text}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
