import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { EditInput, SpineWriter } from "../src/inbox/spineWrite.js";
import { advisories, COPY_PASTE_ADVISORY, NO_COPY_PASTE_RULE, STEPS_PAGE_RULE, type HumanAsk } from "../src/inbox/asks.js";
import { gateProblems } from "../src/review/card.js";
import { copyPasteInHtml, copyPasteInText, copyPasteProblem } from "../src/steps/copyPaste.js";
import { createSteps, mountSteps, NOTE_MAX, stepsIn, WORDS_MAX } from "../src/steps/steps.js";
import { stepVoicePage } from "../src/steps/stepVoice.js";
import { mountVoiceNotesRec, type VoiceNotes } from "../src/voice/notes.js";
import { buildWakePrompt } from "../src/wakePrompt.js";
import { wakeProtocol } from "../src/cycle/prompts.js";

// no copy-paste terminal steps for the owner.
// Mac work is bootstrap text for the Claude app; a command left says where it runs; the console refuses copy-paste blocks;
// every steps page's note box has a voice button and no length limit.

const OLD_MAC_PAGE = `<h1>Make the Memory LinkedIn page</h1>
<p class="lede">Paste this command in Terminal on your Mac.</p>
<div class="cmd" id="cmd">claude --chrome &#x27;You are the Mac agent for home_repo row T96-S3.&#x27;</div>
<details data-for="agent"><summary>For the agent</summary><pre>curl -sS -X POST http://k/ticks --data-binary @laptop-report.json</pre></details>`;
const NEW_MAC_PAGE = `<h1>Make the Memory LinkedIn page</h1>
<p class="lede"><b>Open the Claude app on your Mac, start a new session in Code, paste this text and send it.</b></p>
<div class="cmd" id="cmd">You are the Mac agent for the home_repo repo, row T96-S3.
1. Locate the repo. Look for a local copy of home_repo on this Mac.
2. Bind yourself as this persona: fetch http://x/ticket.txt (or run curl -sS http://x/ticket.txt in your terminal tool).</div>
<p class="small">Needs Claude Code signed in with <code>/login</code>.</p>
<details data-for="agent"><summary>For the agent</summary><pre>curl -sS -X POST http://k/ticks --data-binary @laptop-report.json</pre></details>`;
const CHECKLIST = `<section data-step="s1"><h2>1. Get Bitwarden ready</h2><pre>brew install bitwarden-cli
bw login</pre><p>Then run <code>bw unlock --raw</code>.</p></section>`;

describe("T96-S8 the copy-paste detector", () => {
  it("finds a CLI command, a pre block and an inline command for Sam; the agent's part passes", () => {
    expect(copyPasteInHtml(OLD_MAC_PAGE).map((f) => f.line)).toEqual(["claude --chrome 'You are the Mac agent for home_repo row T96-S3.'"]);
    expect(copyPasteInHtml(NEW_MAC_PAGE)).toEqual([]);
    expect(copyPasteInHtml(CHECKLIST).map((f) => [f.kind, f.line])).toEqual([
      ["pre", "brew install bitwarden-cli"],
      ["code", "bw unlock --raw"],
    ]);
  });

  it("a command that says where it runs and was tested in zsh and bash may stay; one shell is not enough", () => {
    const ok = `<pre data-runs-on="On your Mac, in the Terminal app" data-tested-in="zsh and bash">brew install uv</pre>`;
    expect(copyPasteInHtml(ok)).toEqual([]);
    expect(copyPasteInHtml(ok.replace("zsh and bash", "zsh"))).toHaveLength(1);
    expect(copyPasteInHtml(`<pre data-runs-on="On your Mac">brew install uv</pre>`)).toHaveLength(1);
  });

  it("prose that starts with a command word is not a command", () => {
    expect(copyPasteInHtml("<p><code>open the page</code> then <code>set it up</code>, <code>/login</code>, <code>git</code></p>")).toEqual([]);
    expect(copyPasteInText("Open the ticket and set up the page; `secret: app NAME`")).toEqual([]);
  });

  it("an ask's text: a backticked command or a fence is found; `runs on:` with both shells keeps it", () => {
    expect(copyPasteInText("Paste `brew install bitwarden-cli` in Terminal").map((f) => f.line)).toEqual(["brew install bitwarden-cli"]);
    expect(copyPasteInText("Run:\n```\n$ op read op://x/y\n```").map((f) => f.line)).toEqual(["op read op://x/y"]);
    expect(copyPasteInText("Paste `brew install uv` — runs on: your Mac, Terminal app, tested in zsh and bash")).toEqual([]);
    expect(copyPasteProblem(copyPasteInText("Paste `brew install uv`"))).toContain("root L-54");
  });
});

describe("T96-S8 the rule everywhere agents read it", () => {
  it("names the Mac-agent ticket, the Claude app text, the large where-it-runs words, both shells and the gate", () => {
    for (const w of ["Never hand Sam terminal lines to copy", "root L-54", "scripts/laptop_ticket.py", "Claude app", "never a `claude` CLI command", "On your Mac, in the Terminal app", "zsh and bash", "422 copy_paste_steps"])
      expect(NO_COPY_PASTE_RULE).toContain(w);
    expect(STEPS_PAGE_RULE).toContain(NO_COPY_PASTE_RULE);
    expect(STEPS_PAGE_RULE).toContain("voice button");
  });

  it("every persona wake and every worker brief carries it", () => {
    const p = buildWakePrompt({ name: "Delivery Manager", remit: "Run E4.", skills: [] }, { title: "E4", repo: "Acme/home_repo", path: "docs/E4.md", owner: "" });
    expect(p).toContain(NO_COPY_PASTE_RULE);
    const text = wakeProtocol({
      base: "http://c",
      run: { id: "run_1" },
      assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
      milestone: { id: "ms_1" },
      persona: { id: "p_1", name: "archivist" },
    } as never);
    const brief = text.slice(text.indexOf("Its brief must say"), text.indexOf("   4. When its completion arrives"));
    expect(brief).toContain(NO_COPY_PASTE_RULE);
  });
});

describe("T96-S8 the gates: asks and cards", () => {
  const ask = (question: string): HumanAsk => ({ code: "T9-A1", state: "open", question, steps: null, contextText: null } as unknown as HumanAsk);
  it("an open ask with a terminal line for Sam gets the advisory; a Mac-agent ask does not", () => {
    expect(advisories(ask("Paste `brew install bitwarden-cli && bw login` in Terminal"), [])).toContain(COPY_PASTE_ADVISORY);
    expect(advisories(ask("Paste the text from the Mac page into a new Claude app session"), [])).not.toContain(COPY_PASTE_ADVISORY);
  });
  it("a card that hands Sam a terminal line needs rewriting", () => {
    const card = { title: "Bitwarden was set up for the team.", goal: "Sam runs `brew install bitwarden-cli` once.", delivered: [{ ok: true, text: "One" }, { ok: true, text: "Two" }], next: [], screenshot: "x.webp" };
    expect(gateProblems({ card: card as never, project: "Epic Team", goalSentence: "Sam does nothing by hand.", screenshotFound: true }).join(" ")).toContain("terminal line to copy");
  });
});

// ---------- steps pages: registration gate, long notes ----------

const SPINE = "docs/spines/epic-9.md";
const TEXT = `# PLAN-9: test

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-11-01 | accepted | first | one | x | never |
`;
let db: DB;
let repo: string;
let commits: string[];
let pages: Record<string, string>;

const writer = (): SpineWriter =>
  ({
    edit: async (o: EditInput) => {
      const file = path.join(o.repoDir, o.path);
      const e = o.edit(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "2026-11-10");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, e.text);
      commits.push(o.path);
      return { status: "written", sha: `sha${commits.length}`, path: o.path };
    },
  }) as unknown as SpineWriter;
const make = () =>
  createSteps({ db, pump: false, fileDelayMs: 0, writer: writer(), repoDir: () => repo, milestoneFor: async () => undefined, fetchPage: async (u) => pages[u] });

beforeEach(() => {
  db = openDb(":memory:");
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "e96s8-"));
  fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(repo, SPINE), TEXT);
  commits = [];
  pages = {};
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("T96-S8 the steps page gate", () => {
  const post = (app: Hono, url: string) =>
    app.request("/api/steps/pages", { method: "POST", body: JSON.stringify({ title: "Your security checklist", url, repo: "home_repo", spine: SPINE }) });
  it("refuses a page with copy-paste terminal lines (422), registers a clean or not yet written one, and the check names the rest", async () => {
    const s = make();
    const app = new Hono();
    const api = new Hono();
    mountSteps(api, s);
    app.route("/api", api);
    pages["http://v/bad/"] = CHECKLIST;
    pages["http://v/good/"] = NEW_MAC_PAGE;
    const bad = await post(app, "http://v/bad/");
    expect(bad.status).toBe(422);
    const j = (await bad.json()) as { error: { code: string; message: string } };
    expect(j.error.code).toBe("copy_paste_steps");
    expect(j.error.message).toContain("brew install bitwarden-cli");
    expect((await post(app, "http://v/good/")).status).toBe(201);
    expect((await post(app, "http://v/not-yet/")).status).toBe(201);
    pages["http://v/not-yet/"] = OLD_MAC_PAGE; // written after it registered: the check names it
    const c = (await (await app.request("/api/steps/pages/check")).json()) as { failing: number; pages: { url: string; found: unknown[] }[] };
    expect(c.failing).toBe(1);
    expect(c.pages.find((p) => p.url === "http://v/not-yet/")?.found).toHaveLength(1);
  });
});

describe("T96-S8 a step's note has no length limit on the page", () => {
  it("a long note (pasted terminal output) is filed whole as text, the spine line quotes its start and names the file", async () => {
    const s = make();
    const p = s.register({ title: "Your security checklist", url: "http://v/x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    const out = Array.from({ length: 300 }, (_, i) => `==> Pouring simdjson line ${i} "quoted"`).join("\n");
    await s.tick(p, { step: "s1", state: "stuck", title: "Step 1", comment: out });
    await s.drain();
    const file = `docs/step-notes/${p.id}/s1-1.txt`;
    expect(commits).toEqual([file, SPINE]);
    expect(fs.readFileSync(path.join(repo, file), "utf8")).toContain(out);
    const st = stepsIn(fs.readFileSync(path.join(repo, SPINE), "utf8"), p.id).steps.s1;
    expect(st.state).toBe("stuck");
    expect(st.words!.length).toBeLessThan(WORDS_MAX + 200);
    expect(st.words).toContain(`[full note, ${out.length} characters: home_repo ${file}]`);
    // the page shows the start, never 20 KB per load
    expect(JSON.stringify(s.view(p)).length).toBeLessThan(5_000);
  });
  it("a short note stays one spine line, as before; past the server cap it is refused with words", async () => {
    const s = make();
    const p = s.register({ title: "Steps", url: "http://v/y/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "s1", title: "Step 1", comment: "it said \"done\"\nall good" });
    await s.drain();
    expect(commits).toEqual([SPINE]);
    expect(stepsIn(fs.readFileSync(path.join(repo, SPINE), "utf8"), p.id).notes.s1[0].words).toBe("it said 'done' all good");
    await expect(s.tick(p, { step: "s1", title: "Step 1", comment: "x".repeat(NOTE_MAX + 1) })).rejects.toThrow(/at most 200 KB/);
  });
});

describe("T96-S8 the voice button of a step's note box", () => {
  it("the open recorder routes: no list, no audio, every finish is fill; the page files the words as the step's note", async () => {
    const calls: unknown[] = [];
    const fake = {
      start: (page?: string) => (calls.push(["start", page]), { note: { id: "vn_00000001" }, segmentS: 120, maxMin: 30 }),
      finish: async (id: string, o: unknown) => (calls.push(["finish", id, o]), { note: { id, transcript: "words" } }),
      discard: () => ({}),
    } as unknown as VoiceNotes;
    const api = new Hono();
    mountVoiceNotesRec(api, "/public/steps/:token/voice", (c) => (c.req.param("token") === "t".repeat(24) ? fake : c.json({ error: { code: "not_found" } }, 404)), { audioBase: "/api/voice/notes" });
    const base = `/public/steps/${"t".repeat(24)}/voice/notes`;
    expect((await api.request(base, { method: "POST", body: JSON.stringify({ page: "p" }), headers: { "content-type": "application/json" } })).status).toBe(201);
    const f = await api.request(`${base}/vn_00000001/finish`, { method: "POST", body: JSON.stringify({ segments: 1 }), headers: { "content-type": "application/json", host: "team.example.com" } });
    expect(f.status).toBe(200);
    expect(calls[1]).toEqual(["finish", "vn_00000001", { segments: 1, fill: true, audioBase: "https://team.example.com/api/voice/notes" }]);
    expect((await api.request(base)).status).toBe(404); // no list of notes on the open route
    expect((await api.request(`${base}/vn_00000001/audio`)).status).toBe(404);
    expect((await api.request(`/public/steps/${"x".repeat(24)}/voice/notes`, { method: "POST" })).status).toBe(404);
  });
  it("the recorder page names the step and files through the page's ticks; a bad link says so", () => {
    const html = stepVoicePage({ page: { title: "Your security checklist" }, step: "s7", stepTitle: "Back up the keys" });
    expect(html).toContain("A voice note on Back up the keys");
    expect(html).toContain('"id":"s7"');
    expect(html).toContain('/ticks")');
    expect(html).toContain("in your Memory");
    expect(stepVoicePage({ step: "s7", stepTitle: "" })).toContain("not valid");
  });
  it("the kit has a voice button, no maxlength, and the where-it-runs label", () => {
    const kit = fs.readFileSync(path.join(__dirname, "../../web/public/steps-kit.js"), "utf8");
    expect(kit).toContain('class="sk-voice"');
    expect(kit).not.toMatch(/maxlength="600"/);
    expect(kit).toContain("/voice?step=");
    expect(kit).toContain("data-runs-on");
    expect(fs.readFileSync(path.join(__dirname, "../../web/public/steps-kit.css"), "utf8")).toContain(".sk-where");
  });
});
