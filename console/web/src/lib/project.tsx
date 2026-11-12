import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { HOSTED_BRANDS } from "@/lib/hostedBrands";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import { useQuery } from "@/lib/data";
import { useSkin } from "@/lib/skin";
import { worldId } from "@/lib/useSocial";

/**
 * A project is a repo of the world with the social pack on. The social skin shows one project at a time:
 * its campaigns, Pipeline, Brief, Performance, personas, and the asks and review cards of its milestones. The choice lives
 * in the URL (`?project=<repo>`) only, so a link opens the same project (no link, all projects).
 */
export const PROJECT_PARAM = "project";

export interface Project {
  /** The checkout name the social routes take as `?repo=`. */
  repo: string;
  /** The brand it carries in the switcher (the memory service, Epic Social, Epic Team). */
  name: string;
  /** Every milestone of the repo (campaigns, the repo's own level, retired ones): what belongs to it. */
  milestoneIds: string[];
  /** GitHub `owner/name` of its origin, when known (a milestone with no campaign card names its repo this way). */
  remote?: string;
}

/** The brand each known campaign repo carries (the hosted layer adds its own); any other repo is named after itself. */
const BRANDS: Record<string, string> = { "epic-team": "Epic Team", "epic-team-campaign": "Epic Team", ...HOSTED_BRANDS };
export const brandOfRepo = (repo: string) => BRANDS[repo] ?? (repo.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) || repo);

/** The world's projects: repos that have a live (not retired) campaign card, in the server's order. */
export function projectsOf(cards: CampaignCard[] | undefined): Project[] {
  const all = cards ?? [];
  const live = [...new Set(all.filter((c) => !c.retired).map((c) => c.repo))];
  return live.map((repo) => ({
    repo,
    name: brandOfRepo(repo),
    milestoneIds: all.filter((c) => c.repo === repo && c.milestoneId).map((c) => c.milestoneId!),
    ...opt(all.find((c) => c.repo === repo && c.remote)?.remote),
  }));
}
const opt = (remote?: string) => (remote ? { remote } : {});

/** Each project also owns the milestones no campaign card carries (a one-off job) that name its repo. */
export function withJobs(projects: Project[], milestones: { id: string; repo: string }[] = []): Project[] {
  const owned = new Set(projects.flatMap((p) => p.milestoneIds));
  return projects.map((p) => ({ ...p, milestoneIds: [...p.milestoneIds, ...milestones.filter((m) => !owned.has(m.id) && projectOfRepo(projects, m.repo) === p).map((m) => m.id)] }));
}

/** The project a milestone's `repo` (a checkout path or `owner/name`) names, for a milestone no campaign card carries (a one-off job). */
export function projectOfRepo(projects: Project[], repo?: string): Project | undefined {
  if (!repo) return undefined;
  const base = repo.replace(/\/+$/, "").split("/").pop();
  return projects.find((p) => p.remote === repo || p.repo === repo || p.repo === base);
}

/** `?project=all` (and the browser's kept "all"): every project at once, as the console showed the world before projects. */
export const ALL_PROJECTS = "all";

/**
 * only a link that names a project narrows; with none every page opens on all
 * projects, never on the first one or one this browser kept. undefined = all projects.
 */
export function chooseProject(projects: Project[], fromUrl?: string | null): Project | undefined {
  return fromUrl && fromUrl !== ALL_PROJECTS ? projects.find((p) => p.repo === fromUrl) : undefined;
}

export interface ProjectView {
  /** The world's projects; empty outside the social skin or while the cards load. */
  projects: Project[];
  /** The selected project; undefined when the world has fewer than two or "All projects" is chosen (nothing is narrowed). */
  current?: Project;
  /** A project's repo, or ALL_PROJECTS. */
  select: (repo: string) => void;
  /** Is a milestone of the selected project? True for every milestone when no project narrows (and for one no project owns). */
  keep: (milestoneId?: string | null) => boolean;
  /** The project a milestone belongs to, if any. */
  projectOf: (milestoneId?: string | null) => Project | undefined;
  /** `keep` as it would be with project `p` selected (the switcher's counts are the lists that project shows). */
  keepIn: (p: Project) => (milestoneId?: string | null) => boolean;
}

const NONE: ProjectView = { projects: [], select: () => undefined, keep: () => true, projectOf: () => undefined, keepIn: () => () => true };
const ProjectContext = createContext<ProjectView>(NONE);

/** The project the social skin shows. Outside a provider (the console skin, tests of one page) nothing is narrowed. */
export const useProject = () => useContext(ProjectContext);

/** Only a world with two projects or more is narrowed: one project is the whole world, as before. */
export const MIN_PROJECTS = 2;

export function ProjectProvider({ children }: { children: ReactNode }) {
  const social = !!useSkin().campaigns;
  const { data } = useQuery(async () => {
    if (!social) return undefined;
    const world = await worldId();
    const [campaigns, milestones] = await Promise.all([api.listCampaigns(world), api.listMilestones().catch(() => [])]);
    return { cards: campaigns.campaigns, milestones };
  }, [social]);
  const [params, setParams] = useSearchParams();
  const projects = useMemo(() => withJobs(projectsOf(data?.cards), data?.milestones), [data]);
  const narrow = projects.length >= MIN_PROJECTS;
  const fromUrl = params.get(PROJECT_PARAM);
  const current = narrow ? chooseProject(projects, fromUrl) : undefined;

  const select = useCallback(
    (repo: string) => {
      const next = new URLSearchParams(params);
      if (repo === ALL_PROJECTS) next.delete(PROJECT_PARAM);
      else next.set(PROJECT_PARAM, repo);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const view = useMemo<ProjectView>(() => {
    const owner = new Map<string, Project>();
    for (const p of projects) for (const id of p.milestoneIds) owner.set(id, p);
    const projectOf = (id?: string | null) => (id ? owner.get(id) : undefined);
    return {
      projects: narrow ? projects : [],
      current,
      select,
      projectOf,
      keep: (id) => {
        if (!current) return true;
        const p = projectOf(id);
        return !p || p.repo === current.repo;
      },
      keepIn: (sel) => (id) => {
        const p = projectOf(id);
        return !p || p.repo === sel.repo;
      },
    };
  }, [projects, narrow, current, select]);

  return <ProjectContext.Provider value={view}>{children}</ProjectContext.Provider>;
}
