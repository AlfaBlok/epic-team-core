import { Link } from "react-router-dom";
import { AtSign, Briefcase, CheckCircle2, Circle, CircleAlert, GitFork, MessageSquare } from "lucide-react";
import { api, type AuthReach, type ReachSite } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import { useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { expiryState } from "@/lib/auth";
import { formatRelative } from "@/lib/format";
import { useShows, useWords } from "@/lib/skin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorBox, Loading, PageHeader } from "@/components/common";

/**
 * first-run setup for a social world: the GitHub repo and the X, Reddit and LinkedIn
 * sign-ins. States are read from the world's campaigns and browser sign-ins; the Connect actions stay
 * disabled until brings per-world auth. Social skin only.
 * the owner's screenshot (2026-11-03): X and Reddit said "Not connected" while the team read them every day. The sign-ins sit in
 * the home world's Team Browser, which a social world repo's personas still borrow (browser/worlds.ts wakeBrowserUrls), and the page read
 * only the world's own (empty) instance. It now reads GET /api/auth/reach: every browser the team reads, own one first.
 */
export type ConnectionId = "github" | "x" | "reddit" | "linkedin";
export type ConnectionState = "connected" | "expired" | "missing";

export interface Connection {
  id: ConnectionId;
  name: string;
  state: ConnectionState;
  /** One line on what we see (repo name, sign-in age, why it is expired). */
  detail: string;
  steps: string[];
}

const SITES: { id: Exclude<ConnectionId, "github">; name: string; domains: string[]; steps: string[] }[] = [
  {
    id: "x",
    name: "X",
    domains: ["x.com", "twitter.com"],
    steps: ["Sign in to X in your own browser.", "Press Connect: your team's browser copies the sign-in once.", "Your team reads and drafts; nothing posts without your approval."],
  },
  {
    id: "reddit",
    name: "Reddit",
    domains: ["reddit.com"],
    steps: ["Sign in to Reddit in your own browser.", "Press Connect: your team's browser copies the sign-in once.", "Your team finds threads and drafts replies for your approval."],
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    domains: ["linkedin.com"],
    steps: ["Sign in to LinkedIn in your own browser.", "Press Connect: your team's browser copies the sign-in once.", "Your team drafts posts for your approval."],
  },
];

const GITHUB_STEPS = [
  "Pick the repository your team keeps its plan and posts ledger in.",
  "Grant your team access to that one repository.",
  "Your team reads and commits there; your other repositories stay private.",
];

const matches = (site: ReachSite, domains: string[]) =>
  [site.pattern, ...site.domains].some((d) => {
    const host = d.replace(/^\*\./, "").replace(/\.\*$/, ".com").toLowerCase();
    return domains.some((x) => host === x || host.endsWith(`.${x}`));
  });

/**
 * Pure: the four connections and their state from the world's own data (its campaign repos, browser sign-ins).
 * the repo comes from the world's campaigns (GET /api/tenants/:id/campaigns, its
 * repos with the social pack on), never from "the first unsettled milestone" of a global list: under auth shadow that
 * list held every world, and the social site showed the home world's owner/the infra repo. No campaign repo = "No repository yet".
 */
export function setupConnections(input: { campaigns: CampaignCard[]; sites: ReachSite[]; sitesUnavailable?: boolean; now?: Date }): Connection[] {
  const { campaigns, sites, sitesUnavailable, now = new Date() } = input;
  const remotes = [...new Set(campaigns.map((c) => c.remote).filter((r): r is string => !!r))];
  const github: Connection = remotes.length
    ? { id: "github", name: "GitHub repository", state: "connected", detail: remotes.join(" · "), steps: GITHUB_STEPS }
    : {
        id: "github",
        name: "GitHub repository",
        state: "missing",
        detail: campaigns.length ? `${campaigns[0].repo} has no GitHub remote yet` : "No repository yet",
        steps: GITHUB_STEPS,
      };
  return [
    github,
    ...SITES.map((s): Connection => {
      // The world's own sign-in wins over a borrowed one; then the newest.
      const site = sites
        .filter((x) => matches(x, s.domains))
        .sort((a, b) => Number(!!a.via) - Number(!!b.via) || b.syncedAt.localeCompare(a.syncedAt))[0];
      if (!site) return { id: s.id, name: s.name, state: "missing", detail: sitesUnavailable ? "Sign-ins could not be read right now" : "Not signed in", steps: s.steps };
      const via = site.via ? ` · shared from ${site.via}'s team browser` : "";
      if (site.session === "dead")
        return { id: s.id, name: s.name, state: "expired", detail: (site.sessionReason ? `Signed out: ${site.sessionReason}` : "Signed out by the site") + via, steps: s.steps };
      if (expiryState(site.loginExpiry, now) === "expired") return { id: s.id, name: s.name, state: "expired", detail: `Sign-in expired${via}`, steps: s.steps };
      return { id: s.id, name: s.name, state: "connected", detail: `Signed in ${formatRelative(site.syncedAt)}${via}`, steps: s.steps };
    }),
  ];
}

/** GET /api/auth/reach flattened for setupConnections: each site marked with the world that lends it (none = own). */
export function reachSites(reach: AuthReach | undefined): { sites: ReachSite[]; unavailable: boolean } {
  const sources = reach?.sources ?? [];
  return {
    sites: sources.flatMap((src) => src.sites.map((x) => (src.own ? x : { ...x, via: src.world }))),
    unavailable: !reach || (sources.length > 0 && sources.every((src) => src.error)),
  };
}

const ICONS: Record<ConnectionId, typeof GitFork> = { github: GitFork, x: AtSign, reddit: MessageSquare, linkedin: Briefcase };

function StateBadge({ state }: { state: ConnectionState }) {
  if (state === "connected")
    return (
      <Badge variant="green">
        <CheckCircle2 className="h-3 w-3" /> Connected
      </Badge>
    );
  if (state === "expired")
    return (
      <Badge variant="amber">
        <CircleAlert className="h-3 w-3" /> Sign in again
      </Badge>
    );
  return (
    <Badge variant="gray">
      <Circle className="h-3 w-3" /> Not connected
    </Badge>
  );
}

function ConnectionCard({ c }: { c: Connection }) {
  const Icon = ICONS[c.id];
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border p-4" data-testid={`setup-${c.id}`} data-state={c.state}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{c.name}</h2>
          <p className="break-words text-sm text-muted-foreground">{c.detail}</p>
        </div>
        <StateBadge state={c.state} />
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {c.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button size="sm" disabled title="Arrives with per-workspace sign-in">
          {c.state === "connected" ? "Reconnect" : "Connect"}
        </Button>
        <span className="text-xs text-muted-foreground">Preview: connecting arrives with per-world sign-in.</span>
      </div>
    </section>
  );
}

export function SetupPage() {
  const shows = useShows();
  const w = useWords();
  const campaigns = useQuery(async () => api.listCampaigns(await worldId()), []);
  const reach = useQuery(() => api.authReach(), []);
  const error = campaigns.error;
  const ready = campaigns.data && (reach.data || reach.error);
  const signIns = reachSites(reach.data);
  const list = ready ? setupConnections({ campaigns: campaigns.data!.campaigns, sites: signIns.sites, sitesUnavailable: signIns.unavailable }) : [];
  const done = list.filter((c) => c.state === "connected").length;
  return (
    <>
      <PageHeader
        title="Set up your team"
        description={ready ? `${done} of ${list.length} connected. Your team works from these accounts; nothing posts without your approval.` : undefined}
      />
      {error && <ErrorBox error={error} />}
      {!ready && !error && <Loading />}
      {ready && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {list.map((c) => (
              <ConnectionCard key={c.id} c={c} />
            ))}
          </div>
          {shows("browserAuth") && (
            <p className="mt-4 text-sm text-muted-foreground">
              Sign-ins your team already holds are listed under{" "}
              <Link to="/auth" className="underline">
                {w.browserAuth}
              </Link>
              .
            </p>
          )}
        </>
      )}
    </>
  );
}
