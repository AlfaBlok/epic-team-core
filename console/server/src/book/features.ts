import fs from "node:fs";
import { inside } from "../adapters/doc.js";

/**
 * the service's feature list, one data file in the repo. The console shows it on Every epic
 * (/deck/all#features); epicspine.dev/team/ draws the same file (epicspine-skill tools/feature_list.py).
 */
export const FEATURES_FILE = "docs/features/epicteam.json";
/** worker (the social product's list, 2026-11-08): one file per service in this folder; EpicTeam's first. */
export const FEATURES_DIR = "docs/features";

export interface Feature {
  id: string;
  title: string;
  text: string;
  /** The rows (or epics) that built it. */
  rows: string[];
  learning?: string;
  /** Day it went live. */
  since?: string;
  /** The public page's own section for it, when it has one. */
  section?: string;
}

export interface FeatureGroup {
  id: string;
  title: string;
  intro?: string;
  features: Feature[];
}

export interface FeatureList {
  service: string;
  title: string;
  updated?: string;
  groups: FeatureGroup[];
  /** Repo-relative path of the data file, and its GitHub link when the repo has one. */
  source: string;
  href?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The repo's feature list, or undefined when it has none (or it does not parse). Lines without a title or text drop. */
export function readFeatures(repoDir: string, remote?: string, file = FEATURES_FILE): FeatureList | undefined {
  const abs = inside(repoDir, file);
  let raw: any;
  try {
    raw = abs ? JSON.parse(fs.readFileSync(abs, "utf8")) : undefined;
  } catch {
    return undefined;
  }
  if (!raw || !Array.isArray(raw.groups)) return undefined;
  const groups: FeatureGroup[] = raw.groups
    .filter((g: any) => str(g?.id) && str(g?.title) && Array.isArray(g.features))
    .map((g: any) => ({
      id: str(g.id)!,
      title: str(g.title)!,
      ...(str(g.intro) ? { intro: str(g.intro) } : {}),
      features: g.features
        .filter((f: any) => str(f?.id) && str(f?.title) && str(f?.text))
        .map((f: any) => ({
          id: str(f.id)!,
          title: str(f.title)!,
          text: str(f.text)!,
          rows: Array.isArray(f.rows) ? f.rows.map(String) : [],
          ...(str(f.learning) ? { learning: str(f.learning) } : {}),
          ...(str(f.since) ? { since: str(f.since) } : {}),
          ...(str(f.section) ? { section: str(f.section) } : {}),
        })),
    }));
  return {
    service: str(raw.service) ?? "",
    title: str(raw.title) ?? "Features",
    ...(str(raw.updated) ? { updated: str(raw.updated) } : {}),
    groups,
    source: file,
    ...(remote ? { href: `https://github.com/${remote}/blob/main/${file}` } : {}),
  };
}

/** Every service's list the repo keeps (docs/features/*.json), EpicTeam's first, then by file name. */
export function readFeatureLists(repoDir: string, remote?: string): FeatureList[] {
  const dir = inside(repoDir, FEATURES_DIR);
  let names: string[] = [];
  try {
    names = dir ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
  } catch {
    return [];
  }
  const files = names.map((n) => `${FEATURES_DIR}/${n}`).sort((a, b) => (a === FEATURES_FILE ? -1 : b === FEATURES_FILE ? 1 : a.localeCompare(b)));
  return files.map((f) => readFeatures(repoDir, remote, f)).filter((x): x is FeatureList => !!x);
}
