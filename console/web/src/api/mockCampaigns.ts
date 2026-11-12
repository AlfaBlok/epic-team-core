import type { CampaignCard, CampaignInput, CampaignPlan, CampaignRepo } from "./campaign-types";
import type { Cadence } from "./types";
import { socialWorld } from "@/lib/identity";

/** mock: the campaign the console has (a social world repo) and checkouts a new one could start in. */
export const MOCK_CAMPAIGN_REPOS: CampaignRepo[] = [
  { name: socialWorld(), remote: `memo-ai/${socialWorld()}`, hasPack: true, campaign: true },
  { name: "home_social", remote: "Acme/home_social", hasPack: false, campaign: false },
  { name: "epicspine_social", remote: "Acme/epicspine_social", hasPack: false, campaign: false },
];

export function mockCampaignCard(): CampaignCard {
  return {
    repo: socialWorld(),
    remote: `memo-ai/${socialWorld()}`,
    title: "Memo social presence",
    milestoneId: "m1",
    postsThisWeek: 3,
    live: 12,
    held: 1,
    nextPost: { id: "P-0040", slot: "2026-10-28 18:00", platform: "Reddit", title: "How git log saved me from a bad memory" },
    warnings: 0,
  };
}

const daily = (timeOfDay: string): Cadence => ({ type: "fixed_time", timeOfDay, weekdays: [0, 1, 2, 3, 4, 5, 6] });
const TEAM: [string, Cadence][] = [
  ["Scout", daily("08:00")],
  ["Writer", daily("11:00")],
  ["Publisher", { type: "interval", everyMinutes: 30 }],
  ["Responder", { type: "interval", everyMinutes: 60 }],
  ["Engager", daily("15:00")],
  ["Reporter", daily("18:00")],
];

export function mockCampaignPlan(tenantId: string, input: CampaignInput): CampaignPlan {
  const repo = MOCK_CAMPAIGN_REPOS.find((r) => r.name === input.repo);
  if (!repo) throw new Error(`repo ${input.repo} is not a checkout ${tenantId} can use`);
  const sections = [...(input.objective ? ["objective"] : []), ...((input.keyMessages ?? []).some(Boolean) ? ["key_messages"] : [])];
  return {
    tenantId,
    repo: repo.name,
    ...(repo.remote ? { remote: repo.remote } : {}),
    title: input.title || (repo.campaign ? "Memo social presence" : repo.name),
    milestone: repo.campaign ? { action: "exists", id: "m1", path: "docs/spines/root.md" } : { action: "create", path: "docs/spines/root.md" },
    spine: { action: repo.campaign ? "exists" : "create", path: "docs/spines/root.md" },
    init: repo.hasPack
      ? { action: "skip", reason: "the pack is on already (Pack: social in AGENTS.md)", files: [] }
      : { action: "run", reason: "pack.py init social: writes the missing pack files and sections, adds Pack: social to AGENTS.md", files: ["data/brief.md", "data/message-house.md", "data/posts-ledger.md"] },
    brief: { action: sections.length ? "write" : "skip", sections },
    team: TEAM.map(([role, cadence]) => ({
      role,
      template: role.toLowerCase(),
      action: repo.campaign && role !== "Reporter" ? "exists" : "assign",
      persona: { name: role, action: repo.campaign && role !== "Reporter" ? "reuse" : "create" },
      cadence,
      writeScope: "data/",
    })),
    push: "push",
  };
}
