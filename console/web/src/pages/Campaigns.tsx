import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, ExternalLink, Plus } from "lucide-react";
import { api } from "@/api";
import { worldId } from "@/lib/useSocial";
import type { CampaignCard, CampaignInput, CampaignPlan, CampaignPlanFields, CampaignResult } from "@/api/campaign-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Empty, ErrorBox, Loading, PageHeader } from "@/components/common";
import { mutate, useQuery } from "@/lib/data";
import { formatCadence } from "@/lib/format";
import { useWords } from "@/lib/skin";
import { useProject } from "@/lib/project";
import { socialHref } from "@/pages/social/nav";
import { nextFocusPosition } from "@/lib/bigRoots";
import { ownerName } from "@/lib/identity";
import { CAMPAIGNS_PATH, NEW_CAMPAIGN_PATH } from "@/lib/routePaths";
export { CAMPAIGNS_PATH, NEW_CAMPAIGN_PATH };

/**
 * the Campaigns list (one card per world repo with `Pack: social`) and the New campaign wizard
 * (pick a checkout → short brief → preview → create). The server does the work (hosted/console/server/src/social/campaigns.ts):
 * milestone, `pack init social`, brief through the S6 brief action, commits as the owner, persona team from templates.
 */

/** "2026-10-28 18:00" → "Wed 28 Oct 18:00" (UTC as written). */
function slotLabel(slot: string) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(slot);
  if (!m) return slot;
  const d = new Date(`${m[1]}T00:00:00Z`);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${day} ${d.getUTCDate()} ${mon}${m[2] ? ` ${m[2]}` : ""}`;
}

function Stat({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="min-w-0">
      <div className="text-lg font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function CampaignCardView({ c, onRestore }: { c: CampaignCard; onRestore?: () => void }) {
  // a named campaign opens its own page; a repo card keeps its links into the repo's screens.
  const page = c.campaign && c.milestoneId ? `/milestones/${encodeURIComponent(c.milestoneId)}` : undefined;
  return (
    <Card data-testid="campaign-card" className={c.retired ? "opacity-80" : undefined}>
      <CardContent className="grid gap-3 p-4">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="break-words font-medium">{c.title}</div>
            <div className="text-xs text-muted-foreground">
              {c.remote ?? c.repo}
              {c.campaign && ` · ${[c.campaign.platform, c.campaign.period].filter(Boolean).join(" · ") || c.campaign.code}`}
            </div>
          </div>
          {c.held > 0 && <Badge variant="violet">{c.held} held</Badge>}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="posts this week" value={c.postsThisWeek} testId="posts-this-week" />
          <Stat label="live" value={c.live} testId="live" />
          <Stat label="held" value={c.held} testId="held" />
        </div>
        <div className="text-sm" data-testid="next-post">
          <span className="text-muted-foreground">Next post: </span>
          {c.nextPost ? `${slotLabel(c.nextPost.slot)}${c.nextPost.platform ? ` · ${c.nextPost.platform}` : ""}${c.nextPost.title ? ` · ${c.nextPost.title}` : ""}` : "none scheduled"}
        </div>
        {c.warnings > 0 && <div className="text-xs text-amber-700 dark:text-amber-400">{c.warnings} pack warning{c.warnings === 1 ? "" : "s"} (rows the export could not read)</div>}
        {c.retired ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Retired: paused and out of the menu; nothing deleted.</span>
            {onRestore && (
              <Button size="sm" variant="outline" onClick={onRestore} data-testid="campaign-restore">
                Restore
              </Button>
            )}
          </div>
        ) : page ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link to={page}>
                Open campaign <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`${page}?tab=brief`}>Brief</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`${page}?tab=history`}>History</Link>
            </Button>
          </div>
        ) : (
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to={socialHref("socialHome", c.repo)}>
              Open campaign <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to={socialHref("pipeline", c.repo)}>Pipeline</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to={socialHref("history", c.repo)}>History</Link>
          </Button>
          {c.milestoneId ? (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/milestones/${c.milestoneId}`}>Engine room</Link>
            </Button>
          ) : (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/${NEW_CAMPAIGN_PATH}?repo=${encodeURIComponent(c.repo)}`}>Finish setup</Link>
            </Button>
          )}
        </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CampaignsPage() {
  const w = useWords();
  const { data, error, loading } = useQuery(async () => api.listCampaigns(await worldId()), []);
  // the selected project's campaigns only (all of them when the world has one project).
  const project = useProject();
  const mine = (data?.campaigns ?? []).filter((c) => !project.current || c.repo === project.current.repo);
  const live = mine.filter((c) => !c.retired);
  const retired = mine.filter((c) => c.retired);
  const restore = (c: CampaignCard) => async () => {
    await mutate(async () => api.restoreCampaign(await worldId(), c.milestoneId!));
  };
  return (
    <div>
      <PageHeader
        title={w.milestones}
        description="Each campaign is a named plan inside a repo with the social pack on; the repo's own card shows every post."
        actions={
          <Button asChild>
            <Link to={`/${NEW_CAMPAIGN_PATH}`}>
              <Plus className="h-4 w-4" /> New campaign
            </Link>
          </Button>
        }
      />
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : !mine.length ? (
        <Empty>
          No campaigns yet. <Link to={`/${NEW_CAMPAIGN_PATH}`} className="underline">Start one from a repo</Link>.
        </Empty>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {live.map((c) => (
              <CampaignCardView key={c.milestoneId ?? c.repo} c={c} />
            ))}
          </div>
          {retired.length > 0 && (
            <div className="grid gap-2" data-testid="retired-campaigns">
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Retired ({retired.length})</div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {retired.map((c) => (
                  <CampaignCardView key={c.milestoneId ?? c.repo} c={c} onRestore={c.milestoneId ? restore(c) : undefined} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Step = "repo" | "brief" | "preview" | "done" | "named";

/** the pack roles a named campaign can take over from its repo (same persona, same cadence). */
const CAMPAIGN_ROLES = ["Scout", "Writer", "Responder", "Engager", "Reporter", "Publisher"];

function PlanView({ p }: { p: CampaignPlan }) {
  const line = (testId: string, text: string, skip?: boolean) => (
    <li data-testid={testId} className={skip ? "text-muted-foreground" : undefined}>
      {text}
    </li>
  );
  return (
    <div className="grid gap-4 text-sm">
      <ul className="grid list-disc gap-1 pl-5">
        {line("plan-milestone", p.milestone.action === "create" ? `Create the campaign "${p.title}" (its spine is ${p.milestone.path})` : `Campaign "${p.title}" exists already: kept`, p.milestone.action === "exists")}
        {line("plan-spine", p.spine.action === "create" ? `Write the root spine ${p.spine.path}` : `Root spine ${p.spine.path} exists: kept`, p.spine.action === "exists")}
        {line("plan-init", p.init.action === "run" ? `Turn the social pack on: ${p.init.files.length} file${p.init.files.length === 1 ? "" : "s"} (${p.init.files.join(", ")})` : `Pack init skipped: ${p.init.reason}`, p.init.action === "skip")}
        {line("plan-brief", p.brief.action === "write" ? `Seed the brief: ${p.brief.sections.join(" and ").replace("key_messages", "key messages")}` : "Brief left as it is (no objective or key messages given)", p.brief.action === "skip")}
        {line("plan-push", p.push === "push" ? `Commit as ${ownerName()} and push to origin` : p.push === "policy" ? `Commit as ${ownerName()} (the repo's Integration policy keeps it from being pushed)` : `Commit as ${ownerName()} (no origin to push to)`)}
      </ul>
      <div>
        <div className="mb-1 font-medium">Team</div>
        <table className="w-full text-left text-sm" data-testid="plan-team">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 font-normal">Role</th>
              <th className="py-1 pr-2 font-normal">Persona</th>
              <th className="py-1 pr-2 font-normal">Cadence</th>
              <th className="py-1 font-normal">Assignment</th>
            </tr>
          </thead>
          <tbody>
            {p.team.map((t) => (
              <tr key={t.role} className="border-t" data-testid={`plan-role-${t.role}`}>
                <td className="py-1 pr-2">{t.role}</td>
                <td className="py-1 pr-2">
                  {t.persona.name} <span className="text-xs text-muted-foreground">({t.persona.action === "create" ? `new, from template ${t.template}` : "existing"})</span>
                </td>
                <td className="py-1 pr-2">{formatCadence(t.cadence)}</td>
                <td className="py-1">{t.action === "assign" ? "new, enabled" : "exists: kept"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function NewCampaignPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialRepo = params.get("repo") ?? "";
  const repos = useQuery(async () => {
    const id = await worldId();
    return { id, repos: await api.listCampaignRepos(id) };
  }, []);
  const [step, setStep] = useState<Step>("repo");
  const [repo, setRepo] = useState(initialRepo);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [messages, setMessages] = useState("");
  // a repo's first campaign shows the campaign template too: its frame and messages as the hints.
  const tpl = useQuery(async () => (repos.data ? api.campaignTemplate(repos.data.id) : undefined), [repos.data?.id]);
  const tplHint = (k: string) => tpl.data?.parts.find((p) => p.key === k);
  const [plan, setPlan] = useState<CampaignPlan>();
  const [result, setResult] = useState<CampaignResult>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error>();

  const input = (): CampaignInput => {
    const keyMessages = messages.split("\n").map((s) => s.trim()).filter(Boolean);
    return { repo, ...(title.trim() ? { title: title.trim() } : {}), ...(objective.trim() ? { objective: objective.trim() } : {}), ...(keyMessages.length ? { keyMessages } : {}) };
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };
  const preview = () => run(async () => (setPlan(await api.previewCampaign(repos.data!.id, input())), setStep("preview")));
  const create = () =>
    run(async () => {
      const r = await api.createCampaign(repos.data!.id, input());
      // a new campaign is pinned at the end of the campaigns (focus milestones).
      if (r.milestone.action === "create") {
        const ms = await api.listMilestones().catch(() => []);
        await api.updateMilestone(r.milestoneId, { bigRoot: nextFocusPosition(ms.filter((m) => m.id !== r.milestoneId)) }).catch(() => undefined);
      }
      setResult(r);
      setStep("done");
    });

  const picked = repos.data?.repos.find((r) => r.name === repo);
  return (
    <div className="max-w-3xl">
      <PageHeader title="New campaign" description="From a repo the console already has: nothing is written until you confirm the preview." />
      {err && (
        <div className="mb-4">
          <ErrorBox error={err} />
        </div>
      )}
      {step === "repo" &&
        (repos.loading && !repos.data ? (
          <Loading />
        ) : repos.error ? (
          <ErrorBox error={repos.error} />
        ) : !repos.data?.repos.length ? (
          <Empty>No repos this world can use. Clone the campaign repo onto the host first.</Empty>
        ) : (
          <Card>
            <CardContent className="grid gap-3 p-4">
              <div className="text-sm font-medium">1. Pick the repo</div>
              <div className="grid gap-1" role="radiogroup" aria-label="Repo">
                {repos.data.repos.map((r) => (
                  <label key={r.name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60">
                    <input type="radio" name="repo" value={r.name} checked={repo === r.name} onChange={() => setRepo(r.name)} />
                    <span className="min-w-0 break-words">{r.remote ?? r.name}</span>
                    {r.campaign ? <Badge variant="blue">campaign</Badge> : r.hasPack ? <Badge variant="gray">pack on</Badge> : null}
                  </label>
                ))}
              </div>
              {picked?.campaign && picked.hasPack && (
                <div className="text-xs text-muted-foreground">This repo already runs campaigns: Next starts a new named campaign in it (its own plan, personas and results).</div>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {picked?.campaign && picked.hasPack && (
                  <Button variant="ghost" onClick={() => setStep("brief")} data-testid="rerun-setup">
                    Re-run the repo setup instead
                  </Button>
                )}
                <Button disabled={!picked} onClick={() => setStep(picked?.campaign && picked.hasPack ? "named" : "brief")}>
                  Next <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      {step === "named" && picked && <NamedCampaignForm tenantId={repos.data!.id} repo={picked.name} where={picked.remote ?? picked.name} onBack={() => setStep("repo")} />}
      {step === "brief" && (
        <Card>
          <CardContent className="grid gap-3 p-4">
            <div className="text-sm font-medium">2. The brief ({picked?.remote ?? repo})</div>
            {tpl.data && (
              <div className="rounded-md border p-3 text-sm" data-testid="campaign-template">
                Starts from the campaign template:{" "}
                <a className="underline" href={tpl.data.source.url} target="_blank" rel="noreferrer">
                  {tpl.data.source.name.toLowerCase()}
                </a>
                . After this first step, each named campaign in the repo opens with all its parts filled in.
              </div>
            )}
            <div className="grid gap-1">
              <Label htmlFor="campaign-title">Name</Label>
              <Input id="campaign-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="the root spine's title, else the repo's name" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="campaign-objective">Objective</Label>
              <Textarea id="campaign-objective" rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder={tplHint("frame") ? `${tplHint("frame")!.help}. Example: ${tplHint("frame")!.example}` : "What the campaign is for, in a sentence or two"} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="campaign-messages">Key messages (one per line)</Label>
              <Textarea id="campaign-messages" rows={4} value={messages} onChange={(e) => setMessages(e.target.value)} placeholder={tplHint("keyMessages") ? `${tplHint("keyMessages")!.help}. Example: ${tplHint("keyMessages")!.example}` : undefined} />
            </div>
            <div className="text-xs text-muted-foreground">Both are optional; the rest of the brief (voice, formats, hold rules) is on the Campaign brief screen.</div>
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("repo")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button disabled={busy} pending={busy} pendingLabel="Previewing…" onClick={preview}>
                Preview <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {step === "preview" && plan && (
        <Card>
          <CardContent className="grid gap-4 p-4">
            <div className="text-sm font-medium">3. Preview: what Create does</div>
            <PlanView p={plan} />
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep("brief")}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button disabled={busy} onClick={create}>
                {busy ? "Creating…" : plan.milestone.action === "create" ? "Create campaign" : "Update campaign"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {step === "done" && result && (
        <Card>
          <CardContent className="grid gap-3 p-4" data-testid="campaign-done">
            <div className="text-sm font-medium">Done: {result.title}</div>
            <ul className="grid list-disc gap-1 pl-5 text-sm">
              {result.commits.length ? (
                result.commits.map((c) => (
                  <li key={c.commit}>
                    {c.step === "init" ? "Pack on" : c.step === "approval" ? "Approve every post on" : "Brief seeded"}: commit {c.commit.slice(0, 7)} ({c.push.state})
                  </li>
                ))
              ) : (
                <li>No commit needed: the repo already had everything.</li>
              )}
              <li>{result.team.filter((t) => t.action === "assign").length} assignment(s) created, enabled; {result.team.filter((t) => t.action === "exists").length} kept</li>
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate(`/milestones/${encodeURIComponent(result.milestoneId)}`)}>
                Open campaign <ExternalLink className="h-4 w-4" />
              </Button>
              <Button variant="outline" asChild>
                <Link to="/">Team</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * a new named campaign inside a repo that already runs campaigns: its name (kept as written), a first
 * plan (the owner edits it after, on the campaign's Brief tab) and the pack roles that work it. Create writes the campaign's
 * spine as the owner, adds it pinned and moves the picked roles onto it on their cadence.
 */
function NamedCampaignForm({ tenantId, repo, where, onBack }: { tenantId: string; repo: string; where: string; onBack: () => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState({ name: "", platform: "", period: "", keyMessages: "", voice: "", format: "", postingStyle: "", replyStyle: "", cadence: "", readerAction: "", targets: "", personas: "", frame: "", who: "", offer: "", goals: "", eveningCount: "" });
  // every new campaign opens prefilled from the campaign template (the plan the owner approved as the model).
  const tpl = useQuery(() => api.campaignTemplate(tenantId), [tenantId]);
  useEffect(() => {
    const p = tpl.data?.plan;
    if (!p) return;
    setF((cur) => {
      const next = { ...cur };
      for (const [k, v] of Object.entries(p) as [keyof CampaignPlanFields, string | string[] | undefined][]) {
        const text = Array.isArray(v) ? v.join("\n") : (v ?? "");
        if (k in next && !next[k as keyof typeof next].trim()) next[k as keyof typeof next] = text;
      }
      return next;
    });
  }, [tpl.data]);
  const hint = (k: string) => tpl.data?.parts.find((p) => p.key === k);
  const [roles, setRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const keyMessages = f.keyMessages.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
      const plan = Object.fromEntries(Object.entries({ ...f, keyMessages: undefined, name: undefined }).filter(([, v]) => typeof v === "string" && v.trim()));
      const r = await mutate(() => api.createNamedCampaign(tenantId, { repo, name: f.name.trim(), plan: { ...plan, ...(keyMessages.length ? { keyMessages } : {}) }, ...(roles.length ? { roles } : {}), ...(tpl.data ? { template: true } : {}) }));
      navigate(`/milestones/${encodeURIComponent(r.milestoneId)}?tab=brief`);
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f, label: string, rows = 0, placeholder = "") => (
    <div className="grid gap-1">
      <Label htmlFor={`named-${k}`}>{label}</Label>
      {rows ? <Textarea id={`named-${k}`} rows={rows} value={f[k]} onChange={set(k)} placeholder={placeholder} /> : <Input id={`named-${k}`} value={f[k]} onChange={set(k)} placeholder={placeholder} />}
      {hint(k) && (
        <div className="text-xs text-muted-foreground" data-testid={`named-${k}-example`}>
          {hint(k)!.help}. Example: {hint(k)!.example}
        </div>
      )}
    </div>
  );
  return (
    <Card>
      <CardContent className="grid gap-3 p-4" data-testid="named-campaign-form">
        <div className="text-sm font-medium">2. The campaign in {where}</div>
        {err && <ErrorBox error={err} />}
        {field("name", "Name", 0, "e.g. Reddit awareness week 37")}
        {tpl.data && (
          <div className="rounded-md border p-3 text-sm" data-testid="named-campaign-template">
            Starts from the campaign template:{" "}
            <a className="underline" href={tpl.data.source.url} target="_blank" rel="noreferrer">
              {tpl.data.source.name.toLowerCase()}
            </a>
            . Equal posts per message for 3 days, then lean into what works. Replace each line that says to fill in.
          </div>
        )}
        {field("frame", "Frame", 2)}
        {field("who", "Who it is for", 3)}
        {field("keyMessages", "Key messages (one per line)", 4)}
        {field("cadence", "Cadence: the equal test", 3, "Reddit: 1 thread a day · X: 1 to 2 posts a day")}
        <div className="grid gap-3 sm:grid-cols-2">
          {field("platform", "Channels", 0, "Reddit and X")}
          {field("period", "Period", 0, "2026-11-02 to 2026-11-08")}
        </div>
        {field("offer", "Offer", 0)}
        {field("goals", "Two goals", 2)}
        {field("eveningCount", "Evening count", 2)}
        {field("voice", "Voice", 2)}
        {field("format", "Format", 0, "text only, text + images, video, or a mix")}
        {field("readerAction", "Reader action", 0, "the one thing we want a reader to do")}
        {field("postingStyle", "Posting style", 2)}
        {field("replyStyle", "Reply style", 2)}
        {field("targets", "Targets", 2, "communities, numbers to reach")}
        {field("personas", "Personas and cadence (notes)", 2)}
        <div className="grid gap-1">
          <div className="text-sm font-medium">Personas that work it</div>
          <div className="flex flex-wrap gap-3 text-sm">
            {CAMPAIGN_ROLES.map((r) => (
              <label key={r} className="flex items-center gap-1.5">
                <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
                {r}
              </label>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">Each moves from the repo to this campaign on the cadence it has now. Leave the plan parts you do not know yet empty: you can edit the plan after.</div>
        </div>
        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button disabled={busy || !f.name.trim()} pending={busy} pendingLabel="Creating…" onClick={create} data-testid="named-campaign-create">
            Create campaign
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
