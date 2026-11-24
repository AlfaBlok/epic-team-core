import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { askGateProblem } from "../src/inbox/askGate.js";
import { parseAsks } from "../src/inbox/asks.js";
import { phantomBoxSteps, phantomRefProblem } from "../src/inbox/phantomRefs.js";
import { createSteps, mountSteps } from "../src/steps/steps.js";
import type { EditInput, SpineWriter } from "../src/inbox/spineWrite.js";

/**
 * E996-S29 (the owner, on T9-A10: "HOW CAN I HAVE SOME TEXT REFERRING TO A PASTE IN A BOX THAT DOESN'T EXIST?"): an ask or
 * a step names only the box and buttons its card or page really has.
 */
const ask = (kind: string, rest: string, since = "2026-11-10") => {
  const a = parseAsks(`## Waiting on\n\n- [ask T9-A10: ${kind} @Sam since ${since}] ${rest}`)[0];
  expect(a).toBeDefined();
  return a;
};
const WHY = " — why Sam: only you can create keys on the account, the Team Browser has no sign-in there";

describe("E996-S29 the ask gate holds an ask naming a box or button its card does not have", () => {
  it("holds a key ask that says paste it in the secret box but names no secret target, whatever its date", () => {
    const a = ask("provide", `Create one Cloudflare key, then paste it in its secret box on team.example.com${WHY}`);
    expect(a.secret).toBeUndefined();
    expect(askGateProblem(a)).toMatch(/paste a value into a private box, but it names no `secret: <app> <NAME>`/);
    // the same ask with its target: the card shows the box, it passes
    const ok = ask("provide", `Create one Cloudflare key, then paste it in its secret box on team.example.com${WHY} — secret: acme CLOUDFLARE_WORKERS_TOKEN`);
    expect(ok.secret).toEqual({ app: "acme", name: "CLOUDFLARE_WORKERS_TOKEN" });
    expect(askGateProblem(ok)).toBeUndefined();
  });

  it("holds a key ask with no box: a provide ask for a key or token with no secret target", () => {
    expect(phantomRefProblem({ ask: "provide", question: "Create one Cloudflare API token for the team" })).toMatch(/asks Sam for a key but names no `secret: <app> <NAME>`/);
    expect(phantomRefProblem({ ask: "provide", question: "Create one Cloudflare API token for the team", secret: { app: "acme", name: "CF_TOKEN" } })).toBeUndefined();
    // a provide ask for words, not a key, needs no box
    expect(phantomRefProblem({ ask: "provide", question: "Read the dossier and answer its open questions: budget, timing, photos" })).toBeUndefined();
    // an objective's key results are words to talk about, never a key to paste
    expect(phantomRefProblem({ ask: "provide", question: "You answer: tell me how the key results of a campaign sit next to your key result" })).toBeUndefined();
    expect(phantomRefProblem({ ask: "provide", question: "You answer: send us the new API key results page token" })).toMatch(/asks Sam for a key/);
  });

  it("holds an ask that sends him to press Approve on a card with no Approve button", () => {
    expect(phantomRefProblem({ ask: "do", question: "Sign in to Stripe, then press Approve on this card" })).toMatch(/has no Approve button/);
    expect(phantomRefProblem({ ask: "approve", question: "Press Approve to turn on the paid plan" })).toBeUndefined();
  });

  it("leaves an ask that names only what is there", () => {
    expect(phantomRefProblem({ ask: "do", question: "Mac page: http://h/t/X/ (Copy button, Done or Stuck)" })).toBeUndefined();
    expect(phantomRefProblem({ ask: "decide", question: "Which of the two keys should the team rotate first?" })).toBeUndefined();
  });

  it("an approve ask whose last option carried the secret target gets it back, so its card shows the box", () => {
    const a = parseAsks("## Waiting on\n\n- [ask T9-A9: approve @Sam since 2026-11-10] Turn on Workers Paid? — options: A yes | B stay on our server for now — secret: acme CLOUDFLARE_WORKERS_TOKEN")[0];
    expect(a.secret).toEqual({ app: "acme", name: "CLOUDFLARE_WORKERS_TOKEN" });
  });
});

// ---------- steps pages ----------

const SPINE = "docs/spines/epic-9.md";
let db: DB;
let repo: string;
let pages: Record<string, string>;
const writer = (): SpineWriter =>
  ({
    edit: async (o: EditInput) => {
      const file = path.join(o.repoDir, o.path);
      const e = o.edit(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "2026-11-12");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.writeFileSync(file, e.text);
      return { status: "written", sha: "sha1", path: o.path };
    },
  }) as unknown as SpineWriter;
beforeEach(() => {
  db = openDb(":memory:");
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "e96s29-"));
  fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(repo, SPINE), "# PLAN-9: test\n\n## Current State\nStatus: active\n");
  pages = {};
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const KEY_STEP = `<section data-step="cf-key" data-row="T9-S1"><h2>Make the Cloudflare key</h2><p>Create it, then paste it into the private box below.</p></section>`;
const PLAIN_STEP = `<section data-step="look" data-row="T9-S1"><p>Open the dashboard and look at the numbers.</p></section>`;

describe("E996-S29 the steps-page check", () => {
  it("names the steps that send him to a private box the page does not draw", () => {
    expect(phantomBoxSteps(KEY_STEP + PLAIN_STEP, new Set())).toEqual(["cf-key"]);
    expect(phantomBoxSteps(KEY_STEP + PLAIN_STEP, new Set(["cf-key"]))).toEqual([]);
    // a box on another step of the same page ("the box below") is there
    expect(phantomBoxSteps(KEY_STEP + PLAIN_STEP, new Set(["look"]))).toEqual([]);
  });

  it("lets a step send him to another page's box, the T3 private card, or a site's own password field", () => {
    const other = `<section data-step="go"><p>Copy the key and paste it in the private box on http://v/key/ step 3.</p></section>`;
    expect(phantomBoxSteps(other, new Set())).toEqual(["go"]);
    expect(phantomBoxSteps(other, new Set(), new Set(["http://v/key/"]))).toEqual([]);
    expect(phantomBoxSteps(`<section data-step="t3"><p>Paste it into the private card agents send you (request_secret).</p></section>`, new Set())).toEqual([]);
    expect(phantomBoxSteps(`<section data-step="bw"><p>The password field: only you type it.</p></section>`, new Set())).toEqual([]);
  });

  it("refuses to register such a page (422 phantom_box), registers it with the step's secret, and the check lists the rest", async () => {
    const s = createSteps({ db, pump: false, fileDelayMs: 0, writer: writer(), repoDir: () => repo, milestoneFor: async () => undefined, fetchPage: async (u) => pages[u] });
    const app = new Hono();
    const api = new Hono();
    mountSteps(api, s);
    app.route("/api", api);
    const post = (url: string, extra: Record<string, unknown> = {}) =>
      app.request("/api/steps/pages", { method: "POST", body: JSON.stringify({ title: "Cloudflare key", url, repo: "home_repo", spine: SPINE, ...extra }) });
    pages["http://v/key/"] = `<html><body>${KEY_STEP}${PLAIN_STEP}</body></html>`;
    const bad = await post("http://v/key/");
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("phantom_box");
    const good = await post("http://v/key/", { secrets: [{ step: "cf-key", app: "acme", name: "CLOUDFLARE_WORKERS_TOKEN", ask: "T9-A10" }] });
    expect(good.status).toBe(201);
    expect((await post("http://v/later/")).status).toBe(201);
    pages["http://v/later/"] = KEY_STEP; // written after it registered: the check names it
    const c = (await (await app.request("/api/steps/pages/check")).json()) as { failing: number; pages: { url: string; phantom: string[] }[] };
    expect(c.pages.find((p) => p.url === "http://v/key/")?.phantom).toEqual([]);
    expect(c.pages.find((p) => p.url === "http://v/later/")?.phantom).toEqual(["cf-key"]);
    expect(c.failing).toBe(1);
  });
});

// ---------- a dated note never shows blank ----------
import { stepsIn } from "../src/steps/steps.js";

describe("E996-S29 step notes in a spine with another Decisions shape", () => {
  it("reads his words from the cell that holds them, and drops a note with none", () => {
    const text = [
      "| 2026-11-10 | 2026-11-10 | accepted | Step note: Mac run: ask T9-A10 [step-note sp_1/laptop-run]; his words: \"give me prompt for claude agent not cli\" | the desk was told | none | http://h/t/T9-A10/ | the step changes |",
      "| 2026-11-12 | accepted | Step note: Mac run [step-note sp_1/laptop-run]; his words: \"Repo not found on this Mac\" | told | x | y |",
      "| 2026-11-12 | accepted | Step note: Mac run [step-note sp_1/laptop-run] | told | x | y |",
    ].join("\n");
    expect(stepsIn(text, "sp_1").notes["laptop-run"]).toEqual([
      { at: "2026-11-10", words: "give me prompt for claude agent not cli" },
      { at: "2026-11-12", words: "Repo not found on this Mac" },
    ]);
  });
});
