import type { SpinesJson } from "../adapters/spines.js";

/**
 * standing approvals in force for a milestone, from its `spines.py --json` node `grants` (epicspine-skill
 * 2026.10.24.1, docs/doctrine/standing-approvals.md): own grants first, then inherited ones; only `active` ones count.
 */
export interface Grant {
  code: string;
  scope: string;
  source: string;
  limits?: string | null;
  expires?: string | null;
  inherited?: boolean;
}

/** Active grants of the node at `rel` (repo-relative spine path); [] when none or not emitted. */
export function activeGrantsFor(spines: SpinesJson, rel: string): Grant[] {
  const node = spines.nodes.find((n) => n.path === rel);
  const raw = (node as { grants?: unknown } | undefined)?.grants;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .filter((g) => g.state === "active" && typeof g.code === "string" && typeof g.scope === "string")
    .map((g) => ({
      code: g.code as string,
      scope: g.scope as string,
      source: typeof g.source === "string" ? g.source : rel,
      limits: typeof g.limits === "string" ? g.limits : null,
      expires: typeof g.expires === "string" ? g.expires : null,
      inherited: g.inherited === true,
    }));
}

/** The rule every wake with grants carries. */
export const GRANT_USE_RULE =
  "An action inside an active grant is not an ask: do it and cite `under <code>` in a Decisions row. " +
  "Doubt about whether an action is inside a scope means it is outside: the ask tier applies.";

/** Worker brief rule (B.3) when the milestone has grants. */
export const GRANT_BRIEF_RULE =
  "Copy into the brief the grant codes and scopes (section F) relevant to its task, so the worker acts inside them without asking.";

/** Wake-prompt section H; empty when there are no active grants (no section). */
export function grantsSection(grants: Grant[]): string[] {
  if (!grants.length) return [];
  return [
    "F. Standing approvals in force (active grants of this milestone, own and inherited):",
    ...grants.map(
      (g) =>
        `   - ${g.code}: ${g.scope}` +
        (g.limits ? ` — limits: ${g.limits}` : "") +
        (g.expires && g.expires !== "never" ? ` — expires: ${g.expires}` : "") +
        ` — source: ${g.source}`,
    ),
    `   ${GRANT_USE_RULE}`,
  ];
}
