import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { resolveRepo } from "./adapters/repos.js";
import { credentialWorld } from "./auth/identity.js";
import { DEFAULT_TENANT } from "./db.js";
import { homeRepo } from "./identity.js";
import { OBJECTIVES_FILE } from "./inbox/jordiPriority.js";
import { withDecision } from "./inbox/redLineEdit.js";
import type { EditInput, FileEdit, SpineWrite, SpineWriter } from "./inbox/spineWrite.js";

/**
 * His briefing (the owner, 16 Nov: "there
 * should be somebody, some persona, that helps me with that. It's like it gives me at some point a briefing where it's
 * telling me, these are your objectives and key results, one by one. And I can just talk about it"). The screen walks
 * him through his objectives (the social skin: his campaigns) one at a time; what he says about one is filed on it
 * here, in the repo (root L-45, L-72), in one commit where the files share a repo:
 *  - his words file (docs/his-words.json): the objective's newest words (`after`) and its `briefing` list (the last 10);
 *  - one Decisions line on the objective's epic (its first epic in the home repo, else its first epic), or on the
 *    campaign's own spine, quoting him whole.
 * The objective's owner reads both on its next wake (his words reach every wake prompt through the objectives block).
 */

export const HIS_WORDS_FILE = "docs/his-words.json";
const WORDS_MAX = 2000;
const KEEP = 10;

export interface BriefingAnswer {
  kind: "objective" | "campaign";
  id: string;
  name: string;
  words: string;
  note?: string;
  by: string;
  at: string;
}

export interface BriefingDeps {
  writer?: SpineWriter;
  reposRoot: string;
  /** the home repo (the objectives file and his words file); default the console's home repo. */
  repo?: string;
  /** a campaign's milestone, in the request's world (another world's id is not found). */
  milestone: (id: string) => { id: string; title: string; repo: string; path: string } | undefined;
  who: () => string;
  wrote?: (dir: string) => void;
  now?: () => Date;
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const nameCell = (s: string) => cell(s).slice(0, 120);

/** the Decisions line: his words whole (L-72), where he said them, and where they are filed. */
export function briefingDecision(a: BriefingAnswer, filed: string): string {
  const how = a.note ? `voice note ${a.note}` : "typed";
  return `| ${a.at.slice(0, 10)} | his words | ${cell(`${a.by} on “${nameCell(a.name)}” in his briefing (${how}, ${a.at}): “${a.words}”`)} | ${cell(`filed on the ${a.kind === "campaign" ? "campaign" : "objective"}: ${filed}; its owner reads it on the next wake and acts on what he asked`)} | ${cell(a.note ? `${a.note}, ${HIS_WORDS_FILE}` : HIS_WORDS_FILE)} | when he speaks on it again |`;
}

/** his words file with the answer on its objective: `after` (newest words) and the `briefing` list. */
export function withBriefingWords(text: string, a: BriefingAnswer): { text: string } | { skip: string } {
  let d: { objectives?: Array<Record<string, unknown>> };
  try {
    d = JSON.parse(text);
  } catch {
    return { skip: `${HIS_WORDS_FILE} is not JSON` };
  }
  const o = (d.objectives ?? []).find((x) => x.id === a.id);
  if (!o) return { skip: `no entry ${a.id} in ${HIS_WORDS_FILE}` };
  const source = a.note ? `Briefing, voice note ${a.note}` : "Briefing, typed";
  o.after = { words: a.words, said: a.at.slice(0, 16) + "Z", source, via: "Briefing" };
  const list = Array.isArray(o.briefing) ? (o.briefing as unknown[]) : [];
  o.briefing = [{ words: a.words, said: a.at, ...(a.note ? { note: a.note } : {}) }, ...list].slice(0, KEEP);
  return { text: JSON.stringify(d, null, 2) + "\n" };
}

/** the objective's epic: its first epic in the home repo, else its first epic. */
export function objectiveEpic(objectivesText: string, id: string, home: string): { name: string; repo: string; spine: string } | undefined {
  try {
    const f = JSON.parse(objectivesText) as { pursuits?: Array<{ id: string; name?: string; epics?: Array<{ repo: string; spine: string }> }> };
    const p = (f.pursuits ?? []).find((x) => x.id === id);
    if (!p) return undefined;
    const e = (p.epics ?? []).find((x) => x.repo === home) ?? p.epics?.[0];
    return e ? { name: p.name ?? id, repo: e.repo, spine: e.spine } : { name: p.name ?? id, repo: "", spine: "" };
  } catch {
    return undefined;
  }
}

const fail = (w: SpineWrite) => ({ code: w.status === "skipped" ? "write_skipped" : "write_failed", message: `not saved: ${w.reason ?? "unknown"}` });

export function mountBriefing(api: Hono, d: BriefingDeps): void {
  const runAll = async (edits: EditInput[]): Promise<SpineWrite[]> => {
    if (!edits.length) return [];
    if (d.writer?.edits) return d.writer.edits(edits);
    const out: SpineWrite[] = [];
    for (const e of edits) out.push(await d.writer!.edit(e));
    return out;
  };

  api.post("/briefing/answer", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = b.kind === "campaign" ? "campaign" : b.kind === "objective" ? "objective" : undefined;
    const id = typeof b.id === "string" ? b.id.trim().slice(0, 120) : "";
    const words = typeof b.words === "string" ? b.words.replace(/\s+/g, " ").trim().slice(0, WORDS_MAX) : "";
    const typedNote = typeof b.note === "string" && /^vn_[\w-]{1,40}$/.test(b.note) ? b.note : undefined;
    const note = typedNote ?? words.match(/\bvn_[\w-]{4,40}\b/)?.[0];
    if (!kind || !id) return c.json({ error: { code: "validation_error", message: "kind (objective or campaign) and id: which one he answered" } }, 400);
    if (!words) return c.json({ error: { code: "validation_error", message: "words: say or type what you think of it" } }, 400);
    if (!d.writer) return c.json({ error: { code: "write_skipped", message: "not saved: the console cannot write the repo here" } }, 409);
    const at = (d.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const by = d.who();
    const home = d.repo ?? homeRepo();
    const commit = (name: string) => ({ msg: `Briefing: ${by}'s words on “${nameCell(name)}”`, body: `${by} answered “${nameCell(name)}” in his briefing (${note ? `voice note ${note}` : "typed"}). Filed on it: ${HIS_WORDS_FILE} and a Decisions line on its epic (L-72), quoting him whole.` });

    if (kind === "campaign") {
      const m = d.milestone(id);
      if (!m) return c.json({ error: { code: "not_found", message: `no campaign ${id}` } }, 404);
      const repo = resolveRepo(d.reposRoot, m.repo);
      if (!repo) return c.json({ error: { code: "write_skipped", message: `not saved: no checkout of ${m.repo}` } }, 409);
      const a: BriefingAnswer = { kind, id, name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : m.title, words, ...(note ? { note } : {}), by, at };
      const { msg, body } = commit(a.name);
      const [w] = await runAll([
        {
          repoDir: repo.path,
          path: m.path,
          label: "briefing",
          edit: (text): FileEdit => {
            const out = withDecision(text, briefingDecision(a, "this line on its spine"));
            return out === text ? { skip: "no Decisions table" } : { text: out, msg, body };
          },
        },
      ]);
      if (w.status !== "written") return c.json({ error: fail(w) }, w.status === "skipped" ? 409 : 502);
      d.wrote?.(repo.path);
      return c.json({ ok: true, filed: [`${m.repo}:${m.path}`], ...(w.sha ? { sha: w.sha } : {}) });
    }

    // an objective is the owner's own (the home world only)
    const world = credentialWorld();
    if (world && world !== DEFAULT_TENANT) return c.json({ error: { code: "not_found", message: "no objectives here" } }, 404);
    const homeCo = resolveRepo(d.reposRoot, home);
    if (!homeCo) return c.json({ error: { code: "write_skipped", message: `not saved: no checkout of ${home}` } }, 409);
    let objectives = "";
    try {
      objectives = fs.readFileSync(path.join(homeCo.path, OBJECTIVES_FILE), "utf8");
    } catch {
      objectives = "";
    }
    const epic = objectiveEpic(objectives, id, path.basename(homeCo.path));
    if (!epic) return c.json({ error: { code: "not_found", message: `no objective ${id}` } }, 404);
    const a: BriefingAnswer = { kind, id, name: epic.name, words, ...(note ? { note } : {}), by, at };
    const { msg, body } = commit(a.name);
    const epicCo = epic.repo ? resolveRepo(d.reposRoot, epic.repo) : undefined;
    const filed = [HIS_WORDS_FILE, ...(epicCo ? [`${epic.repo}:${epic.spine}`] : [])];
    const decision = briefingDecision(a, filed.join(" and "));
    const wordsEdit: EditInput = {
      repoDir: homeCo.path,
      path: HIS_WORDS_FILE,
      label: "briefing",
      edit: (text): FileEdit => {
        const r = withBriefingWords(text, a);
        return "skip" in r ? r : { text: r.text, msg, body };
      },
    };
    const epicEdit: EditInput | undefined = epicCo
      ? {
          repoDir: epicCo.path,
          path: epic.spine,
          label: "briefing",
          edit: (text): FileEdit => {
            const out = withDecision(text, decision);
            return out === text ? { skip: "no Decisions table" } : { text: out, msg, body };
          },
        }
      : undefined;
    const sameRepo = epicCo && epicCo.path === homeCo.path;
    const ws = sameRepo ? await runAll([wordsEdit, epicEdit!]) : [...(await runAll([wordsEdit])), ...(epicEdit ? await runAll([epicEdit]) : [])];
    const written = ws.filter((w) => w.status === "written");
    if (!written.length) return c.json({ error: fail(ws[0]) }, ws[0].status === "skipped" ? 409 : 502);
    d.wrote?.(homeCo.path);
    if (epicCo && !sameRepo) d.wrote?.(epicCo.path);
    return c.json({ ok: true, filed: filed.filter((_, i) => ws[i]?.status === "written"), ...(written[0].sha ? { sha: written[0].sha } : {}) });
  });
}
