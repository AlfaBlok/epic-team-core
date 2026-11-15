import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * a repo checkout for review tests: `<root>/<name>` on main, pushed to a bare origin, with spines whose ledger rows
 * the review list reads. `setRow` edits a row's status cell (and commits + pushes it, as a worker would).
 */
export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

export interface Row {
  id: string;
  title?: string;
  status: string;
  evidence?: string;
  verified?: string;
  /** The Next Action cell (default `followups: none; confirm: yes — a test card`). */
  next?: string;
  /** The PR/Branch cell (default `none`). */
  branch?: string;
}

/** the lines a card's top line needs, once per epic (the project may sit in the root spine instead). */
export const CARD_SPINE_LINES = ["Project name: [The team console](https://team.example/)", "Goal sentence: We want the test pages to work for you.", ""];

/** a card file for row `ref` whose fields pass the gate (plain words, live evidence, a screenshot). */
export const cardText = (ref: string, o: { evidence?: string; title?: string; next?: string[]; completes?: string; extra?: string[] } = {}) =>
  [
    "---",
    `row: ${ref}`,
    `title: ${o.title ?? "The test page was built so you can check it."}`,
    "goal: You can open the page and see that it works.",
    "delivered:",
    "  - ✓ The page opens on a laptop.",
    "  - ✓ The page opens on a phone.",
    `evidence: ${o.evidence ?? "https://team.example/audit"}`,
    "screenshot: shot.png",
    "source: You asked for it in your voice note of 12 Nov.",
    "decision: Is the test page good enough to keep? The team recommends keeping it.",
    ...(o.next?.length ? ["next:", ...o.next.map((n) => `  - ${n}`)] : []),
    ...(o.completes ? [`completes: ${o.completes}`] : []),
    ...(o.extra ?? []),
    "confirm: yes",
    "---",
    "",
  ].join("\n");

/** A 1x1 PNG, the cards' screenshot in tests. */
export const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const URL_IN = /https?:\/\/[^\s)|\]]+/;

/**
 * every ledger row in `review` (or `done`) with an http link in its evidence cell gets a card file
 * (docs/cards/<id>.md) unless `files` already has one, so the review tests' rows pass the gate as before.
 */
export function withCards(files: Record<string, string>): Record<string, string> {
  const out = { ...files };
  let any = false;
  for (const [rel, text] of Object.entries(files)) {
    if (!rel.endsWith(".md") || rel.startsWith("docs/cards/")) continue;
    for (const line of text.split("\n")) {
      if (!line.startsWith("| ")) continue;
      const cells = line.split(" | ");
      const id = cells[0].replace(/^\|\s*/, "").trim();
      const status = (cells[4] ?? "").trim();
      const url = URL_IN.exec(cells[8] ?? "")?.[0];
      if (!/^(review|done)\b/i.test(status) || !url || !/\d/.test(id)) continue;
      const card = `docs/cards/${id}.md`;
      if (!(card in out)) out[card] = cardText(id, { evidence: url });
      any = true;
    }
  }
  if (any && !("docs/cards/shot.png" in out)) out["docs/cards/shot.png"] = "";
  return out;
}

export const spineText = (code: string, title: string, rows: Row[], extra: string[] = []) =>
  [
    `# ${code}: ${title}`,
    "",
    "Root spine: [root](root.md)",
    "Parent spine: [root](root.md)",
    "Integration policy: main-direct",
    "",
    "## Current State",
    "",
    "Status: active",
    "",
    ...extra,
    ...CARD_SPINE_LINES,
    "## Issue Ledger",
    "",
    "| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    // every row asks for the owner's confirm by default (a row without `confirm: yes` closes itself)
    ...rows.map((r) => `| ${r.id} | Ticket worker | seat2 | ${r.title ?? `${r.id} work`} | ${r.status} | none | ${r.branch ?? "none"} | main | ${r.evidence ?? "none"} | ${r.verified ?? "2026-11-02"} | ${r.next ?? "followups: none; confirm: yes — a test card"} |`),
    "",
  ].join("\n");

/** write row `id`'s card file (and the shared screenshot) into a checkout, as a worker would. */
export function addCard(dir: string, id: string, evidence: string, o: Parameters<typeof cardText>[1] = {}) {
  fs.mkdirSync(path.join(dir, "docs", "cards"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "cards", `${id}.md`), cardText(id, { evidence, ...o }));
  const shot = path.join(dir, "docs", "cards", "shot.png");
  if (!fs.existsSync(shot)) fs.writeFileSync(shot, PNG_1PX);
}

export function makeRepo(root: string, name: string, given: Record<string, string>, o: { cards?: boolean } = {}) {
  const files = o.cards === false ? given : withCards(given);
  const bare = path.join(root, "_origins", `${name}.git`);
  const dir = path.join(root, name);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  fs.mkdirSync(dir, { recursive: true });
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), rel.endsWith(".png") ? PNG_1PX : text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "origin", "main");
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
  /** The row's line in the file as it is now. */
  const rowLine = (rel: string, id: string) => read(rel).split("\n").find((l) => l.startsWith(`| ${id} |`));
  const setRow = (rel: string, id: string, status: string, evidence?: string) => {
    const lines = read(rel).split("\n");
    const i = lines.findIndex((l) => l.startsWith(`| ${id} |`));
    const cells = lines[i].split(" | ");
    cells[4] = status;
    if (evidence !== undefined) cells[8] = evidence;
    lines[i] = cells.join(" | ");
    fs.writeFileSync(path.join(dir, rel), lines.join("\n"));
    // a row a worker sets to review comes with its card file (the fixture's default fields)
    const url = URL_IN.exec(cells[8] ?? "")?.[0];
    const card = path.join(dir, "docs", "cards", `${id}.md`);
    if (o.cards !== false && /^(review|done)\b/i.test(status) && url && !fs.existsSync(card)) {
      fs.mkdirSync(path.dirname(card), { recursive: true });
      fs.writeFileSync(card, cardText(id, { evidence: url }));
      if (!fs.existsSync(path.join(dir, "docs", "cards", "shot.png"))) fs.writeFileSync(path.join(dir, "docs", "cards", "shot.png"), PNG_1PX);
      git(dir, "add", "docs/cards");
    }
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(dir, rel), t, t);
    git(dir, "commit", "-q", "-am", `${id} ${status}`);
    git(dir, "push", "-q", "origin", "main");
  };
  /** Subjects of the commits on origin/main, newest first. */
  const originLog = () => git(bare, "log", "--format=%s", "main").split("\n");
  return { dir, bare, read, rowLine, setRow, originLog };
}

/** A fake web: url → status (missing = no answer). */
export const web = (answers: Record<string, number>) => {
  const seen: string[] = [];
  const f = (async (u: string) => {
    seen.push(String(u));
    const s = answers[String(u)];
    if (s === undefined) throw new Error("ECONNREFUSED");
    return new Response("ok", { status: s });
  }) as unknown as typeof fetch;
  return { f, seen };
};
