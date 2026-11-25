import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { PressWorker } from "../src/press/mount.js";
import { closeEnough, epicCall, EPIC_SURE, judgeWanted, resetSameMeaning, type PairJudge } from "../src/inbox/sameMeaning.js";
import { heldAsRepeat, movedInto, oneSubjectOneCard, subjectText, type ReviewRow } from "../src/review/rows.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * E948-S206 round 3, the owner 25 Nov 18:13Z (vn_e4dbcbce): "there were two cards on the same subject waiting for me, and
 * one was stale. So by the time I got to the one that was latest, I had already given feedback to one that was-- didn't
 * have the latest version ... We didn't detect that the two tickets were about the same subject, didn't merge them."
 *
 * The replay is that exact pair, their card faces as they were at 18:00Z: E995-S2 (in review since 10:24, a tracker whose
 * page showed our answers on the credit forms) and E995-S22 (in review since 14:20, the same forms, every field answered).
 *  1. why the same-subject check missed them: their faces share no content word, so they were never judged;
 *  2. now: cards of one epic are judged pairwise on what they put in front of him, the older is held to fold into the
 *     newer, and only the latest reaches him;
 *  3. his note on E995-S2 folded E995-S22 into it (18:04Z), then his "Yes: fill the forms tonight" on E995-S22 was refused
 *     five times (18:07 to 18:12, "not in review any more ... Press again"); now that press lands on E995-S2 as his words,
 *     wakes its owner and tells him where it went.
 */

const S2_FACE = {
  title: "Get funding was made to track every credit application in colour.",
  delivered: ["✓ The five forms now apply as Acme or Beta, never Gamma.", "✓ One page: the four questions they ask and our answers.", "✓ A tracker of 42 programs in colour, 3 of 11 granted."],
  look: "The four questions on top, then each form as Acme or Beta.",
  decision: "Does this tracker show your applications the way you want? The team recommends yes.",
};
const S22_FACE = {
  title: "Nine startup forms were prepared for you to send yourself tonight.",
  delivered: ["✓ Each program shows its rules, founders' reports and one product only.", "✓ Every field answered, founded year 2026, a laptop ticket per form.", "✗ Nothing readable on X, so founders' words come from Reddit and blogs."],
  look: "Cloudflare first, its rules, then founders who got in or not.",
  decision: "Are these the answers you want to send tonight? We recommend yes.",
};
const S21_FACE = {
  title: "Blockchain node plans for the Nirvana credit were priced, and all lose.",
  delivered: ["✓ Selling RPC access loses about 3,235 dollars without paying customers."],
  look: "Each bar is one use of the credit over 12 months.",
  decision: "Use the credit for our own extra worker box, not a node? We recommend yes.",
};
type Face = typeof S2_FACE;
const row = (ref: string, verifiedAt: string, f: Face) =>
  ({
    id: `rv_${ref}`,
    ref,
    title: f.title,
    repo: "acme",
    path: "docs/spines/startup-programs-for-compute-cloudflare.md",
    status: "review",
    links: [],
    closes: {},
    verifiedAt,
    verdict: { kind: "card" },
    face: { title: f.title, decision: f.decision, delivered: f.delivered.map((t) => ({ ok: t.startsWith("✓"), text: t })), evidence: { url: "", label: "", look: f.look } },
  }) as unknown as ReviewRow;

// the epic judge's calls, measured on production's judge (docs/inbox/same-subject-eval.json): the funding pair overlaps, the Nirvana plan does not
const epicTruth: PairJudge = async (pairs) =>
  pairs.map((p) => {
    const forms = (t: string) => /startup forms|credit application/.test(t);
    return forms(p.a) && forms(p.b) ? { same: true, confidence: 80 } : { same: false, confidence: 92 };
  });
const neverMeaning: PairJudge = async (pairs) => pairs.map(() => ({ same: false, confidence: 95 }));

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "same-subject-"));
  process.env.CONSOLE_SAME_MEANING_FILE = path.join(dir, "same-meaning.json");
  resetSameMeaning();
});
afterEach(() => {
  delete process.env.CONSOLE_SAME_MEANING_FILE;
  resetSameMeaning();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("two cards of one epic on the same subject: the older one is held, the latest reaches him", () => {
  it("before: the faces he saw share no content word, so the check never judged the pair", () => {
    const face = (f: Face) => `${f.title} ${f.decision}`;
    expect(closeEnough(face(S2_FACE), face(S22_FACE))).toBe(0);
  });

  it("now: every pair of the epic is judged on what it puts in front of him; E995-S2 folds into the newer E995-S22", async () => {
    const s2 = row("E995-S2", "2026-11-25T10:24Z", S2_FACE);
    const s22 = row("E995-S22", "2026-11-25T14:20Z", S22_FACE);
    const s21 = row("E995-S21", "2026-11-25T12:00Z", S21_FACE);
    oneSubjectOneCard([s2, s21, s22]);
    // not judged yet: both still cards, the pairs are queued for the epic judge
    expect([s2, s21, s22].map((x) => x.verdict.kind)).toEqual(["card", "card", "card"]);
    expect(epicCall(subjectText(s2), subjectText(s22))).toBeUndefined();
    await judgeWanted(neverMeaning, undefined, 60, epicTruth);
    expect(epicCall(subjectText(s2), subjectText(s22))).toBe("same");
    expect(epicCall(subjectText(s21), subjectText(s22))).toBe("different");
    oneSubjectOneCard([s2, s21, s22]);
    expect(s22.verdict.kind).toBe("card");
    expect(s21.verdict.kind).toBe("card");
    expect(s2.verdict).toMatchObject({ kind: "needs-rewriting", reason: "card needs rewriting" });
    expect(s2.verdict.problems?.[0]).toMatch(/^it puts the same work in front of \S+ as E995-S22's card, the newer card of this epic: one subject, one card/);
    expect(s2.verdict.problems?.[0]).toContain("`done (folded into E995-S22)`");
    // held as a repeat: a press he makes on it from a screen loaded before still lands
    expect(heldAsRepeat(s2.verdict)).toBe(true);
    expect(EPIC_SURE).toBeLessThanOrEqual(80);
  });

  it("the status cells of a fold name where the row went", () => {
    expect(movedInto("active (iteration 2, folded into E995-S2 round 4, run_965b8371: his vn_740516fc 25 Nov 18:04Z, the form answers rewritten)")).toBe("E995-S2");
    expect(movedInto("done (folded into E995-S2)")).toBe("E995-S2");
    expect(movedInto("superseded by E948-S139")).toBe("E948-S139");
    expect(movedInto("active (iteration 2, relaunched by Sam 2026-11-25: redo it)")).toBeUndefined();
  });
});

// ---- the press: the exact sequence of 25 Nov through the console's own routes ----------------------------------------

const SPINE = "docs/spines/startup-programs-for-compute-cloudflare.md";
const card = (ref: string, f: Face, evidence: string, options: string[]) =>
  [
    "---",
    `row: ${ref}`,
    `title: ${f.title}`,
    "goal: Every credit form ready for your final touch.",
    "delivered:",
    ...f.delivered.map((d) => `  - "${d}"`),
    `evidence: "[Open the page](${evidence})"`,
    `look: ${f.look}`,
    "screenshot: shot.png",
    `source: 'Your voice note, 25 Nov: "we have done zero prep"'`,
    `decision: ${f.decision}`,
    "options:",
    ...options.map((o) => `  - "${o}"`),
    "confirm: yes",
    "---",
    "",
  ].join("\n");
const DECISIONS = ["", "## Decisions", "", "| Date | Outcome | Decision | Summary | Evidence | Revisit |", "|---|---|---|---|---|---|", "| 2026-11-24 | accepted | E95 opened | the forms | none | none |", ""];

class FakeT3 {
  sent: string[] = [];
  async listProjects() {
    return [{ id: "proj", title: "acme", workspaceRoot: "/nowhere/acme" }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(i: { prompt?: string }) {
    this.sent.push(String(i?.prompt ?? ""));
    return { threadId: "thread_1" };
  }
  async sendToThread(_t: string, text: string) {
    this.sent.push(String(text ?? ""));
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s206-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s206-write-"));
  const db: DB = openDb(path.join(root, "console.db"));
  const repo = makeRepo(
    root,
    "acme",
    {
      [SPINE]:
        spineText("EPIC-995", "Startup programs for compute", [
          { id: "E995-S2", title: "Track each credit application", status: "review", evidence: "[answers](http://pages.example:9725/#answers)", verified: "2026-11-25T10:24Z" },
          { id: "E995-S22", title: "Funding prep he submits himself tonight", status: "review", evidence: "[prep page](http://pages.example:9779/#cloudflare)", verified: "2026-11-25T14:20Z" },
        ]) + DECISIONS.join("\n"),
      "docs/cards/E995-S2.md": card("E995-S2", S2_FACE, "http://pages.example:9725/#answers", ["Yes: keep it as the one place for applications", "No: say what to change in a note"]),
      "docs/cards/E995-S22.md": card("E995-S22", S22_FACE, "http://pages.example:9779/#cloudflare", ["Yes: fill the forms tonight", "Change: say which answer in a note"]),
      "docs/cards/shot.png": "",
    },
    { cards: false },
  );
  const live = (async () => new Response("<h1>ok</h1>", { status: 200 })) as unknown as typeof fetch;
  const t3 = new FakeT3();
  let worker: PressWorker | undefined;
  const app = createApp(db, {
    read: { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: live, consoleHosts: [] } },
    presses: { retryMs: [0], heldRetryMs: 0, onWorker: (w) => (worker = w), answerFirst: true },
    writeClones: { root: writeRoot },
    cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
  });
  const s = createStore(db);
  const m = s.createMilestone({ title: "acme", repo: "acme", path: SPINE, owner: "Sam", paused: false });
  const p = s.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
  const a = s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(
      url,
      { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, pressId: res.headers.get("x-press-id") };
  };
  const until = async (id: string, ok: (p: any) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const pr = (await req("GET", `/api/presses/${id}`)).json;
      if (ok(pr)) return pr;
      if (i % 4 === 3) await worker!.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`press ${id} never got there: ${JSON.stringify((await req("GET", `/api/presses/${id}`)).json)}`);
  };
  const wakes = () => (db.prepare("SELECT * FROM runs WHERE assignment_id = ?").all(a.id) as Record<string, unknown>[]).map((r) => JSON.stringify(r));
  /** a worker sets a row's status on origin (the fold of 18:05Z, as run_965b8371 did). */
  const fold = (id: string, status: string) => {
    const lines = repo.read(SPINE).split("\n");
    const i = lines.findIndex((l) => l.startsWith(`| ${id} |`));
    const cells = lines[i].split(" | ");
    cells[4] = status;
    lines[i] = cells.join(" | ");
    fs.writeFileSync(path.join(repo.dir, SPINE), lines.join("\n"));
    git(repo.dir, "commit", "-q", "-am", `${id} folded`);
    git(repo.dir, "push", "-q", "origin", "main");
  };
  const origin = () => git(repo.bare, "show", `main:${SPINE}`);
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(writeRoot, { recursive: true, force: true });
  });
  return { req, until, wakes, fold, origin };
}

describe("his press on the card whose sibling he just answered lands there, never refused", () => {
  it("replay of 25 Nov: E995-S22 folded into E995-S2 after his note, then his Yes on E995-S22 lands on E995-S2 and says so", async () => {
    // the epic judge is off here (no verdict file named for the app): both cards reach him, as on 25 Nov
    delete process.env.CONSOLE_SAME_MEANING_FILE;
    const w = world();
    await w.req("GET", "/api/review-items?wait=1");
    await new Promise((r) => setTimeout(r, 30));
    const cards = (await w.req("GET", "/api/review-items?wait=1")).json as { id: string; ref: string }[];
    expect(cards.map((c) => c.ref).sort()).toEqual(["E995-S2", "E995-S22"]);
    const s22 = cards.find((c) => c.ref === "E995-S22")!;

    // 18:05Z: his note on E995-S2 folds E995-S22 into it (the card is still on his screen)
    w.fold("E995-S22", "active (iteration 2, folded into E995-S2 round 4, run_965b8371: his vn_740516fc 25 Nov 18:04Z, the form answers rewritten)");

    // 18:07Z: he presses "Yes: fill the forms tonight" on E995-S22
    const r = await w.req("POST", `/api/review-items/${encodeURIComponent(s22.id)}/complete`, { start: [], park: [], choice: "Yes: fill the forms tonight" });
    expect(r.status).toBe(202);
    const done = await w.until(r.pressId!, (p) => p.state !== "landing");
    // before this fix: state "failed", "not written: row E995-S22 is not in review any more ... Press again"
    expect(done, JSON.stringify(done)).toMatchObject({ state: "landed" });
    expect(done.response.movedOn).toMatchObject({ ref: "E995-S2", title: S2_FACE.title });
    expect(done.response.movedOn.line).toBe(`This card had been merged into "${S2_FACE.title.replace(/\.$/, "")}" before your press. Your answer went there, and its owner has it.`);
    // his words are in the repo, on E995-S2, and E995-S22's row is left as the fold wrote it
    const spine = w.origin();
    expect(spine).toMatch(/\| E995-S2: Sam's press "Yes: fill the forms tonight" on E995-S22's card landed on E995-S2, the row E995-S22 was folded into before the press/);
    expect(spine.split("\n").find((l) => l.startsWith("| E995-S22 |"))).toContain("active (iteration 2, folded into E995-S2 round 4");
    expect(spine.split("\n").find((l) => l.startsWith("| E995-S2 |"))).toContain("| review |");
    // E995-S2's owner was woken with his press
    for (let i = 0; i < 100 && !w.wakes().some((x) => x.includes("landed the press on E995-S2")); i++) await new Promise((res) => setTimeout(res, 20));
    expect(w.wakes().some((x) => x.includes("landed the press on E995-S2"))).toBe(true);
    // nothing failed
    expect((await w.req("GET", "/api/write-health")).json.failed24h).toBe(0);

    // 18:12Z: the fold closes E995-S22 `done (folded into E995-S2)`; a second press lands there too, never refused
    w.fold("E995-S22", "done (folded into E995-S2)");
    const again = await w.req("POST", `/api/review-items/${encodeURIComponent(s22.id)}/complete`, { start: [], park: [], choice: "Yes: fill the forms tonight" });
    const done2 = await w.until(again.pressId!, (p) => p.state !== "landing");
    expect(done2, JSON.stringify(done2)).toMatchObject({ state: "landed" });
    expect(done2.response.movedOn.ref).toBe("E995-S2");
  });
});
