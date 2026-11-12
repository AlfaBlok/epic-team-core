import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { resolveRepo } from "../adapters/repos.js";
import { anthropicJson } from "../textModel.js";
import { credentialWorld } from "../auth/identity.js";
import { DEFAULT_TENANT } from "../db.js";
import { PRIORITIES_FILE } from "./jordiPriority.js";
import type { EditInput, FileEdit, SpineWrite, SpineWriter } from "./spineWrite.js";
import { homeRepo } from "../identity.js";

/**
 * (the owner 2026-11-10 20:45Z, vn_ffa4783d, Log/2026-11-10.md#^e-4807be: "the two red lines take up a lot of space
 * vertically, so they should be like more like one row each, and I should have a button to edit, and when I press that
 * button, something unfolds where I can type or I can leave a voice note to edit the red line. I can also delete it"):
 * his edit and his delete of a red line, written into the repo (root L-45): `docs/priorities.json` (the line changed, or
 * moved to `removedRedLines` with who and when), the root spine's `Red line:` lines, and one Decisions row quoting
 * him, in ONE commit. The Prioritizer re-reads the file on its next run: a line he changed is his (`state: "changed"`,
 * never proposed again), a line he deleted is never put back unless he names it again.
 */
export const EPIC48 = "docs/spines/epic-48-review-inbox.md";
export const ROOT_SPINE = "docs/spines/root.md";
const WORDS_MAX = 2000;

/** What his words may change: the line's name, its sentence, its why and its day. */
export interface LineText {
  name?: string;
  sentence: string;
  why?: string;
  target?: string;
}
/** His words on one line → the line as he wants it now (a model call; tests pass their own). */
export type Reworder = (line: LineText, words: string, today: string) => Promise<LineText>;

const REWORD_SYSTEM =
  "You keep a product owner's 'red line': the one goal his team must move first, shown on top of his inbox. " +
  "He gives you the line as it stands and his words (typed or a voice note transcript) about how it should change. " +
  "Return the line rewritten to follow his words exactly: change only what he asks, keep the rest as it is. " +
  "name: the line's plain name, 5 words or fewer. sentence: one sentence, plain words, 25 words or fewer, no codes, no brackets, no semicolons. " +
  "why: one short line saying he changed it and what he asked for. " +
  "target: a deadline day as YYYY-MM-DD only when the line has one or his words give one (resolve 'end of the month' and similar from today's date), else an empty string; an empty string also when he asks to drop the deadline.";
const REWORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "sentence", "why", "target"],
  properties: { name: { type: "string" }, sentence: { type: "string" }, why: { type: "string" }, target: { type: "string" } },
};
const rewordUser = (l: LineText, words: string, today: string) =>
  [
    `Today: ${today}.`,
    `The line now:\nname: ${l.name ?? ""}\nsentence: ${l.sentence}\nwhy: ${l.why ?? ""}\ntarget: ${l.target ?? ""}`,
    `His words:\n${words}`,
  ].join("\n\n");

const clean = (v: LineText): LineText => {
  const one = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
  const target = one(v.target);
  return {
    ...(one(v.name) ? { name: one(v.name).slice(0, 60) } : {}),
    sentence: one(v.sentence).slice(0, 300),
    ...(one(v.why) ? { why: one(v.why).slice(0, 300) } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(target) ? { target } : {}),
  };
};

export function anthropicReworder(key: () => Promise<string | undefined>, f: typeof fetch = fetch): Reworder {
  return async (line, words, today) => {
    const { value } = await anthropicJson<LineText>(key, f, { system: REWORD_SYSTEM, user: rewordUser(line, words, today), schema: REWORD_SCHEMA, maxTokens: 2000, timeoutMs: 30_000 });
    return clean(value);
  };
}

export function openAiReworder(key: () => Promise<string | undefined>, f: typeof fetch = fetch, model = "gpt-4o-mini"): Reworder {
  return async (line, words, today) => {
    const k = await key();
    if (!k) throw new Error("the console has no OPENAI_API_KEY");
    const body = {
      model,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "red_line", strict: true, schema: REWORD_SCHEMA } },
      messages: [
        { role: "system", content: REWORD_SYSTEM },
        { role: "user", content: rewordUser(line, words, today) },
      ],
    };
    const r = await f("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || typeof text !== "string") throw new Error(`the model did not reword the line (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 160)}`);
    return clean(JSON.parse(text) as LineText);
  };
}

// ---------- the file ----------

type Raw = Record<string, unknown>;
type File = Raw & { redLines?: Raw[]; redLine?: Raw | Raw[]; removedRedLines?: Raw[] };

const keyOf = (r: Raw) => String((r.name as string | undefined) ?? (r.sentence as string | undefined) ?? "").trim().toLowerCase();

/** The file's lines as a list (the `redLine` is folded into `redLines`, so one shape is written back). */
function linesOf(f: File): Raw[] {
  if (Array.isArray(f.redLines)) return f.redLines;
  const one = f.redLine;
  delete f.redLine;
  f.redLines = Array.isArray(one) ? one : one ? [one] : [];
  return f.redLines;
}

export type Change =
  | { how: "edit"; name: string; to: LineText; words: string; note?: string; by: string; at: string }
  | { how: "delete"; name: string; by: string; at: string }
  | { how: "undo"; name: string; by: string; at: string };

export type Applied = { text: string; line: Raw; before?: Raw } | { skip: string };

/** One change to the file's text: pure, so the writer can apply it to the file as it is on origin under its lock. */
export function applyChange(text: string, c: Change): Applied {
  let f: File;
  try {
    f = JSON.parse(text) as File;
  } catch {
    return { skip: `${PRIORITIES_FILE} is not valid JSON` };
  }
  const lines = linesOf(f);
  const k = c.name.trim().toLowerCase();
  if (c.how === "undo") {
    const gone = Array.isArray(f.removedRedLines) ? f.removedRedLines : [];
    let i = -1;
    for (let n = gone.length - 1; n >= 0; n--) if (keyOf(gone[n]) === k) { i = n; break; }
    if (i < 0) return { skip: `no deleted red line “${c.name}” to bring back` };
    if (lines.some((l) => keyOf(l) === k)) return { skip: `the red line “${c.name}” is already there` };
    const { removedBy: _b, removedAt: _a, place, ...line } = gone[i] as Raw & { place?: number };
    gone.splice(i, 1);
    if (!gone.length) delete f.removedRedLines;
    const back = { ...line, restoredBy: c.by, restoredAt: c.at };
    lines.splice(Math.min(typeof place === "number" ? place : lines.length, lines.length), 0, back);
    return { text: JSON.stringify(f, null, 2) + "\n", line: back };
  }
  const i = lines.findIndex((l) => keyOf(l) === k);
  if (i < 0) return { skip: `no red line “${c.name}” in ${PRIORITIES_FILE}` };
  const before = lines[i];
  if (c.how === "delete") {
    lines.splice(i, 1);
    f.removedRedLines = [...(Array.isArray(f.removedRedLines) ? f.removedRedLines : []), { ...before, place: i, removedBy: c.by, removedAt: c.at }];
    return { text: JSON.stringify(f, null, 2) + "\n", line: before, before };
  }
  const { target: _t, ...keep } = before;
  const after: Raw = {
    ...keep,
    ...(c.to.name ? { name: c.to.name } : {}),
    sentence: c.to.sentence,
    ...(c.to.why ? { why: c.to.why } : {}),
    ...(c.to.target ? { target: c.to.target } : {}),
    words: c.words,
    said: c.at.slice(0, 10),
    source: c.note ?? "typed on Team home",
    state: "changed",
    changedBy: c.by,
    changedAt: c.at,
  };
  lines[i] = after;
  return { text: JSON.stringify(f, null, 2) + "\n", line: after, before };
}

/** The root spine's `Red line:` line of one line (as scripts/priorities.py `spine_line` writes it). */
export function spineLine(r: Raw): string {
  const bits = [String(r.state ?? "proposed")];
  if (r.ask) bits.push(String(r.ask));
  if (r.at) bits.push(`since ${String(r.at).slice(0, 10)}`);
  if (r.target) bits.push(`by ${String(r.target)}`);
  const refs = (Array.isArray(r.items) ? (r.items as Raw[]) : []).map((i) => String(i.ref)).join(", ");
  const name = r.name ? `${String(r.name).trim()}: ` : "";
  return `Red line: ${name}${String(r.sentence ?? "").trim()} (${bits.join(", ")}; on it: ${refs}; docs/priorities.json)`;
}

/** The root spine with its `Red line:` lines rewritten from the file (all of them taken out when no line is left). */
export function withSpineLines(spine: string, priorities: string): string {
  let lines: Raw[] = [];
  try {
    lines = linesOf(JSON.parse(priorities) as File).filter((r) => r && typeof r.sentence === "string");
  } catch {
    return spine;
  }
  const at = spine.indexOf("## Current State");
  if (at < 0) return spine;
  const nxt = spine.indexOf("\n## ", at + 1);
  const end = nxt < 0 ? spine.length : nxt + 1;
  const cs = spine.slice(at, end);
  const put = lines.map(spineLine).join("\n");
  let out: string;
  if (/^Red line:.*$/m.test(cs)) {
    const first = cs.search(/^Red line:.*$/m);
    const rest = cs.slice(first).replace(/^Red line:.*\n?/gm, "");
    out = cs.slice(0, first) + (put ? `${put}\n` : "") + rest;
  } else if (put && /^Status:.*$/m.test(cs)) out = cs.replace(/^(Status:.*)$/m, (m) => `${m}\n${put}`);
  else out = cs;
  return spine.slice(0, at) + out + spine.slice(end);
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** One Decisions row, appended after the table's last row. */
export function withDecision(spine: string, row: string): string {
  const lines = spine.split("\n");
  const h = lines.findIndex((l) => /^## Decisions\s*$/.test(l));
  if (h < 0) return spine;
  let last = -1;
  for (let i = h + 1; i < lines.length && !/^## /.test(lines[i]); i++) if (/^\|/.test(lines[i])) last = i;
  if (last < 0) return spine;
  lines.splice(last + 1, 0, row);
  return lines.join("\n");
}

export function decisionRow(c: Change, line: Raw, before?: Raw): string {
  const day = c.at.slice(0, 10);
  const name = String((before ?? line).name ?? (before ?? line).sentence ?? "");
  if (c.how === "edit")
    return `| ${day} | decided | ${cell(`${c.by} changed the red line “${name}” on Team home (${c.note ? `voice note ${c.note}` : "typed"}): “${c.words.slice(0, 600)}”`)} | ${cell(`now “${String(line.name ?? "")}”: ${String(line.sentence)}${line.target ? ` (by ${String(line.target)})` : ""}, state changed: his line, the Prioritizer keeps it and never proposes it again`)} | ${PRIORITIES_FILE} | when he edits it again |`;
  if (c.how === "delete")
    return `| ${day} | decided | ${cell(`${c.by} deleted the red line “${name}” on Team home at ${c.at}`)} | ${cell(`its items leave the top of the inbox; kept in removedRedLines with who and when, and the Prioritizer never puts it back unless he names it again`)} | ${PRIORITIES_FILE} | if he brings it back |`;
  return `| ${day} | decided | ${cell(`${c.by} brought back the red line “${name}” on Team home (Undo) at ${c.at}`)} | ${cell(`the line is on top of the inbox again, in its old place`)} | ${PRIORITIES_FILE} | — |`;
}

// ---------- the routes ----------

export interface RedLineEditDeps {
  writer?: SpineWriter;
  reposRoot: string;
  /** The repo that holds the lines (the world's home repo: the code repo for the home world). */
  repo?: string;
  reword: Reworder;
  who: () => string;
  wrote?: (dir: string) => void;
  now?: () => Date;
}

const fail = (w: SpineWrite) => ({ code: w.status === "skipped" ? "write_skipped" : "write_failed", message: `not saved: ${w.reason ?? "unknown"}` });

export function mountRedLineEdit(api: Hono, d: RedLineEditDeps): void {
  const write = async (c: Change): Promise<{ w: SpineWrite; line?: Raw; before?: Raw; dir?: string }> => {
    const repo = resolveRepo(d.reposRoot, d.repo ?? homeRepo());
    if (!repo || !d.writer) return { w: { status: "skipped", reason: "the console cannot write the repo here" } };
    let got: Applied | undefined;
    const label = `red line ${c.how}`;
    const verb = c.how === "edit" ? "changed" : c.how === "delete" ? "deleted" : "brought back";
    const msg = `${c.by} ${verb} the red line “${c.name}” (Team home)`;
    const body = `${c.by} ${verb} the red line “${c.name}” from its row on top of Team home. ${PRIORITIES_FILE} holds the line (or removedRedLines, with who and when), the root spine's Red line lines follow it and the red lines' epic's Decisions row quotes him. The Prioritizer reads the file on its next run.`;
    const edits: EditInput[] = [
      {
        repoDir: repo.path,
        path: PRIORITIES_FILE,
        label,
        edit: (text): FileEdit => {
          got = applyChange(text, c);
          return "skip" in got ? { skip: got.skip } : { text: got.text, msg, body };
        },
      },
      {
        repoDir: repo.path,
        path: ROOT_SPINE,
        label,
        edit: (text): FileEdit => {
          if (!got || "skip" in got) return { skip: "no red line change" };
          const out = withSpineLines(text, got.text);
          return out === text ? { skip: "same Red line lines" } : { text: out, msg, body };
        },
      },
      {
        repoDir: repo.path,
        path: EPIC48,
        label,
        edit: (text): FileEdit => {
          if (!got || "skip" in got) return { skip: "no red line change" };
          const out = withDecision(text, decisionRow(c, got.line, got.before));
          return out === text ? { skip: "no Decisions table" } : { text: out, msg, body };
        },
      },
    ];
    let ws: SpineWrite[];
    if (d.writer.edits) ws = await d.writer.edits(edits);
    else {
      ws = [];
      for (const e of edits) ws.push(await d.writer.edit(e));
    }
    const w = ws[0];
    if (w.status === "written") d.wrote?.(repo.path);
    return got && !("skip" in got) ? { w, line: got.line, before: got.before, dir: repo.path } : { w };
  };
  const guard = () => {
    const world = credentialWorld();
    return world && world !== DEFAULT_TENANT;
  };
  const nameOf = (b: Raw) => (typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim().slice(0, 300) : "");
  const nowIso = () => (d.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

  // Edit: his words (typed, or a voice note's transcript) change the line.
  api.post("/red-line/edit", async (c) => {
    if (guard()) return c.json({ error: { code: "not_found", message: "no red line here" } }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Raw;
    const name = nameOf(b);
    const words = typeof b.words === "string" ? b.words.trim().slice(0, WORDS_MAX) : "";
    const note = typeof b.note === "string" && /^vn_[\w-]{1,40}$/.test(b.note) ? b.note : undefined;
    if (!name) return c.json({ error: { code: "validation_error", message: "name: which red line" } }, 400);
    if (!words) return c.json({ error: { code: "validation_error", message: "words: say or type how the line should change" } }, 400);
    const repo = resolveRepo(d.reposRoot, d.repo ?? homeRepo());
    let cur: Raw | undefined;
    try {
      const f = JSON.parse(fs.readFileSync(path.join(repo?.path ?? "", PRIORITIES_FILE), "utf8")) as File;
      cur = linesOf(f).find((l) => keyOf(l) === name.toLowerCase());
    } catch {
      cur = undefined;
    }
    if (!cur) return c.json({ error: { code: "not_found", message: `no red line “${name}”` } }, 404);
    const at = nowIso();
    let to: LineText;
    try {
      to = await d.reword({ name: cur.name as string | undefined, sentence: String(cur.sentence), why: cur.why as string | undefined, target: cur.target as string | undefined }, words, at.slice(0, 10));
    } catch (e) {
      return c.json({ error: { code: "reword_failed", message: `the line was not changed: ${String((e as Error)?.message ?? e).slice(0, 200)}` } }, 502);
    }
    if (!to.sentence) return c.json({ error: { code: "reword_failed", message: "the line was not changed: no sentence came back" } }, 502);
    // `dry`: the line as his words would make it, nothing written (a check of the rewording on a live console)
    if (b.dry === true) return c.json({ ok: true, dry: true, line: to });
    const r = await write({ how: "edit", name, to, words, ...(note ? { note } : {}), by: d.who(), at });
    if (r.w.status !== "written") return c.json({ error: fail(r.w) }, r.w.status === "skipped" ? 409 : 502);
    return c.json({ ok: true, line: r.line, ...(r.w.sha ? { sha: r.w.sha } : {}) });
  });

  // Delete: after his one confirm tap; the line moves to removedRedLines with who and when.
  api.post("/red-line/delete", async (c) => {
    if (guard()) return c.json({ error: { code: "not_found", message: "no red line here" } }, 404);
    const name = nameOf((await c.req.json().catch(() => ({}))) as Raw);
    if (!name) return c.json({ error: { code: "validation_error", message: "name: which red line" } }, 400);
    const r = await write({ how: "delete", name, by: d.who(), at: nowIso() });
    if (r.w.status !== "written") return c.json({ error: fail(r.w) }, r.w.status === "skipped" ? 409 : 502);
    return c.json({ ok: true, line: r.line, ...(r.w.sha ? { sha: r.w.sha } : {}) });
  });

  // Undo a delete: the line goes back to its old place.
  api.post("/red-line/undo", async (c) => {
    if (guard()) return c.json({ error: { code: "not_found", message: "no red line here" } }, 404);
    const name = nameOf((await c.req.json().catch(() => ({}))) as Raw);
    if (!name) return c.json({ error: { code: "validation_error", message: "name: which red line" } }, 400);
    const r = await write({ how: "undo", name, by: d.who(), at: nowIso() });
    if (r.w.status !== "written") return c.json({ error: fail(r.w) }, r.w.status === "skipped" ? 409 : 502);
    return c.json({ ok: true, line: r.line, ...(r.w.sha ? { sha: r.w.sha } : {}) });
  });
}
