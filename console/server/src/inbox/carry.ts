import type { DB } from "../db.js";
import type { Store } from "../store.js";
import { noticeRef } from "../plug/marks.js";
import { resolveRepo } from "../adapters/repos.js";
import fs from "node:fs";
import { inside } from "../adapters/doc.js";
import type { Tree, TreeNode } from "../adapters/tree.js";
import { raiseAsk, type RaiseDeps } from "./raise.js";
import { leadingCode, legacyDuplicateOf, waitingOnJordi, type WaitingDeps } from "./waiting.js";
import { ownerName } from "../identity.js";

const TAGGED = /^\s*[-*]\s+\[(?:ask|answered|superseded)\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+)\b/i;
const pathsOf = (n: TreeNode): string[] => [...(n.path ? [n.path] : []), ...n.children.flatMap(pathsOf)];
/** Every ask code tagged in the tree's spine files, any state (`[superseded …]` too, which the markdown parse skips) → `<repo>/<code>`. */
function taggedCodes(dir: string, rels: string[], repo: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of new Set(rels.filter(Boolean))) {
    const abs = inside(dir, rel);
    let text = "";
    try {
      text = abs ? fs.readFileSync(abs, "utf8") : "";
    } catch {
      continue;
    }
    for (const l of text.split("\n")) {
      const m = TAGGED.exec(l);
      if (m) out.set(m[1].toUpperCase(), `${repo}/${m[1]}`);
    }
  }
  return out;
}
/** D19 at the carry: a row whose question starts with a code the spines carry (any state) is that ask. */
const codeInSpines = (question: string, codes: Map<string, string>): string | undefined => {
  const lead = leadingCode(question);
  return lead ? codes.get(lead.code.toUpperCase()) : undefined;
};

/**
 * carry-over, once per console (staging first, then production): every Needs the owner row still open in console.db
 * (the old DB store of asks) goes into its milestone's spine as a coded ask through the spine writer, and the row is
 * marked superseded by that code (the table is a log from here on). A row the old inbox already hid as a restatement
 * of a spine ask (or a park note) is superseded by that ask (or `moot`) without a new line. A row whose spine write is
 * refused stays open and is listed with the reason (run again once fixed). `dry` writes nothing and says what it would do.
 */
export interface CarryLine {
  id: string;
  milestoneId: string;
  question: string;
  action: "carried" | "superseded" | "refused" | "would_carry" | "would_supersede";
  /** carried: `<repo>/<code>` written; superseded: the ask (or `moot`) it restates. */
  by?: string;
  path?: string;
  sha?: string;
  reason?: string;
}

export async function carryNeedsJordi(d: { db: DB; store: Store; deps: WaitingDeps; raise: RaiseDeps }, o: { dry?: boolean } = {}): Promise<CarryLine[]> {
  const rows = d.db
    .prepare("SELECT id, run_id, milestone_id, question, proposed_action, created_at FROM needs_jordi WHERE status = 'open' ORDER BY created_at, rowid")
    .all() as { id: string; run_id: string | null; milestone_id: string; question: string; proposed_action: string; created_at: string }[];
  const out: CarryLine[] = [];
  const itemsOf = new Map<string, { items: Awaited<ReturnType<typeof waitingOnJordi>>; tree?: { asks?: Tree["asks"]; repo: string }; codes: Map<string, string> }>();
  const supersede = (id: string, by: string) =>
    d.db.prepare("UPDATE needs_jordi SET status = 'superseded', superseded_by = ?, superseded_at = ? WHERE id = ? AND status = 'open'").run(by, new Date().toISOString(), id);
  for (const r of rows) {
    const base = { id: r.id, milestoneId: r.milestone_id, question: r.question };
    const m = d.store.getMilestone(r.milestone_id);
    if (!m) {
      if (!o.dry) supersede(r.id, "moot");
      out.push({ ...base, action: o.dry ? "would_supersede" : "superseded", by: "moot", reason: "its milestone is gone" });
      continue;
    }
    if (!itemsOf.has(m.id)) {
      const tree = await d.deps.treeFor(m).catch(() => undefined);
      const repo = resolveRepo(d.deps.reposRoot, m.repo)?.name ?? m.repo;
      const dir = resolveRepo(d.deps.reposRoot, m.repo)?.path;
      itemsOf.set(m.id, {
        items: await waitingOnJordi(d.deps, { milestoneId: m.id, includeSettled: true }).catch(() => []),
        tree: tree ? { asks: tree.asks, repo } : undefined,
        codes: dir ? taggedCodes(dir, [m.path, ...(tree ? pathsOf(tree.root) : [])], repo) : new Map(),
      });
    }
    const run = r.run_id ? d.store.getRun(r.run_id) : undefined;
    const seen = itemsOf.get(m.id)!;
    const dup =
      legacyDuplicateOf({ question: r.question, proposedAction: r.proposed_action, createdAt: r.created_at }, seen.items, run, seen.tree) ??
      codeInSpines(r.question, seen.codes);
    if (dup) {
      if (!o.dry) supersede(r.id, dup);
      out.push({ ...base, action: o.dry ? "would_supersede" : "superseded", by: dup, reason: dup === "moot" ? "a park note: it asks nothing" : "the inbox already showed it as this spine ask" });
      continue;
    }
    const a = run ? d.store.getAssignment(run.assignmentId) : undefined;
    const persona = a ? d.store.getPersona(a.personaId)?.name : undefined;
    const notice = d.db.prepare("SELECT tenant_id FROM credit_accounts WHERE notice_id = ?").get(r.id) as { tenant_id: string } | undefined;
    const askedBy = notice ? "the credits gate" : (persona ?? (run ? `run ${run.id}` : "an API caller"));
    if (o.dry) {
      out.push({ ...base, action: "would_carry", path: m.path, reason: `as an ask raised by ${askedBy}` });
      continue;
    }
    const w = await raiseAsk(d.raise, m, {
      question: r.question,
      proposedAction: r.proposed_action,
      askedBy: `${askedBy} (carried from console.db Needs ${ownerName()} ${r.id}, raised ${r.created_at.slice(0, 10)})`,
      ...(run ? { runId: run.id } : {}),
    });
    if (w.status !== "written") {
      out.push({ ...base, action: "refused", reason: w.reason, ...(w.path ? { path: w.path } : {}) });
      continue;
    }
    supersede(r.id, `${w.repo}/${w.code}`);
    if (notice) d.db.prepare("UPDATE credit_accounts SET notice_id = ? WHERE tenant_id = ?").run(noticeRef(m.id, w.path, w.code), notice.tenant_id);
    out.push({ ...base, action: "carried", by: `${w.repo}/${w.code}`, path: w.path, ...(w.sha ? { sha: w.sha } : {}), ...(w.reason ? { reason: w.reason } : {}) });
  }
  return out;
}
