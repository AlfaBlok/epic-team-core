import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLine } from "../src/review/agentWake.js";
import { cardSha, DELIVERY_GROUPS_SCHEMA, DELIVERY_LIVE_SCHEMA, JUDGE_SCHEMAS, mountQcJudge, QC_JUDGE_SCHEMA, qcVerdict, readQc, type QcResult } from "../src/review/qc.js";
import { computeReviewRows } from "../src/review/rows.js";
import { createStore } from "../src/store.js";
import { openDb, type DB } from "../src/db.js";
import { cardText, makeRepo, PNG_1PX, spineText } from "./reviewFixture.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * E948-S62 (the owner's vn_1, "did he get what he asked for", and his note of 12 Nov 19:39Z: "Can we have like a
 * quality control or something?"): the quality check's result sits beside the card in the repo; the gate holds a card
 * that missed his words or failed the look at 390 or 1280, and his card shows the live screen. Temp repos only.
 */
const EPIC = "docs/spines/epic-941.md";
const ROOT = "# EPIC: home_repo\n\nProject name: [The team console](https://team.example/)\nRoot spine: self\n\n## Current State\n\nStatus: active\n";

let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e948s62-"));
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ROWS = [
  { id: "E941-S1", title: 'The phone page Sam asked for: "make the buttons big enough to tap"', status: "review", evidence: "https://team.example/" },
  { id: "E941-S2", title: 'The laptop page Sam asked for: "show the diagram first"', status: "review", evidence: "https://team.example/" },
];

function qcFile(row: string, card: string, o: Partial<QcResult> = {}): string {
  const r: QcResult = {
    row,
    cardSha: cardSha(card),
    checkedAt: "2026-11-12T20:00:00Z",
    words: [{ said: "make the buttons big enough to tap", where: "vn_1", status: "met", how: "the buttons fill the phone width" }],
    visual: { pass: true, problems: [], summary: "the page with its diagram first" },
    pass: true,
    shots: [
      { width: 390, file: `${row}-390.webp` },
      { width: 1280, file: `${row}-1280.webp` },
    ],
    ...o,
  };
  return JSON.stringify(r);
}

function repo(qc: Record<string, string> | undefined) {
  const text = spineText("EPIC-941", "Desk home", ROWS, ["Goal sentence: Give the team desk a home of its own.", ""]).replace("Project name: [The team console](https://team.example/)\n", "");
  const files: Record<string, string> = { "docs/spines/root.md": ROOT, [EPIC]: text, "docs/cards/shot.png": "" };
  for (const r of ROWS) files[`docs/cards/${r.id}.md`] = cardText(r.id);
  if (qc) {
    files["docs/cards/qc/.keep"] = "";
    for (const [row, body] of Object.entries(qc)) {
      files[`docs/cards/qc/${row}.json`] = body;
      files[`docs/cards/qc/${row}-390.png`] = "";
      files[`docs/cards/qc/${row}-1280.png`] = "";
    }
  }
  const made = makeRepo(tmp, "home_repo", files, { cards: false });
  // the live screens (the fixture writes .png files as a 1px PNG): the result names .webp, so copy them over
  if (qc) for (const row of Object.keys(qc)) for (const w of [390, 1280]) fs.writeFileSync(path.join(made.dir, `docs/cards/qc/${row}-${w}.webp`), PNG_1PX);
  return made;
}

function rows() {
  const store = createStore(db);
  store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
  return computeReviewRows(store, tmp).rows;
}
const byRef = (ref: string) => rows().find((r) => r.ref === ref)!;

describe("E948-S62 the card quality check in the review gate", () => {
  it("a passing card reaches him and shows the live screen, with his words beside the result", () => {
    repo({ "E941-S1": qcFile("E941-S1", cardText("E941-S1")), "E941-S2": qcFile("E941-S2", cardText("E941-S2")) });
    const r = byRef("E941-S1");
    expect(r.verdict.kind).toBe("card");
    expect(r.face?.screenshot).toBe("docs/cards/qc/E941-S1-1280.webp");
    expect(r.face?.qc?.shots.map((s) => s.width)).toEqual([390, 1280]);
    expect(r.face?.qc?.words[0]).toMatchObject({ said: "make the buttons big enough to tap", status: "met" });
  });

  it("a missed point holds the card as not what he asked, with the missed words, and tells its worker what to do", () => {
    const miss = qcFile("E941-S2", cardText("E941-S2"), {
      words: [{ said: "show the diagram first", where: "vn_1", status: "missed", how: "the first screen is a wall of text, no diagram" }],
      pass: false,
    });
    repo({ "E941-S1": qcFile("E941-S1", cardText("E941-S1")), "E941-S2": miss });
    const r = byRef("E941-S2");
    expect(r.verdict).toMatchObject({ kind: "fails-qc", reason: "not what he asked" });
    expect(r.verdict.problems?.[0]).toBe('Sam said "show the diagram first" (vn_1): the first screen is a wall of text, no diagram');
    // never shown to him with a picture of the failed result
    expect(r.face?.screenshot).toBe("docs/cards/shot.png");
    const line = agentLine({ ref: r.ref, repo: r.repo, path: r.path, verdict: r.verdict, state: "review" } as never);
    expect(line).toMatch(/held by the quality check, not what he asked/);
    expect(line).toMatch(/card_qc\.py --repo <checkout> --row E941-S2 --commit/);
  });

  it("a failed look at 390 or 1280 holds the card; a point the card itself marks as not done does not", () => {
    const look = qcFile("E941-S1", cardText("E941-S1"), {
      words: [{ said: "make the buttons big enough to tap", status: "declared", how: "the card says the phone layout is not done yet" }],
      visual: { pass: false, problems: ["at 390 px the Send button is squashed to one letter"] },
      pass: false,
    });
    repo({ "E941-S1": look, "E941-S2": qcFile("E941-S2", cardText("E941-S2")) });
    expect(byRef("E941-S1").verdict).toMatchObject({ kind: "fails-qc", reason: "failed the visual check", problems: ["at 390 px the Send button is squashed to one letter"] });
    expect(byRef("E941-S2").verdict.kind).toBe("card");
  });

  it("a card changed after its check, or never checked in a repo that runs the check, waits for the check", () => {
    const made = repo({ "E941-S1": qcFile("E941-S1", "an older card text") });
    expect(byRef("E941-S1").verdict).toMatchObject({ kind: "fails-qc", reason: "changed since its check" });
    expect(byRef("E941-S2").verdict).toMatchObject({ kind: "fails-qc", reason: "not checked yet" });
    void made;
  });

  it("a repo that does not run the check yet keeps the gate as it was", () => {
    repo(undefined);
    expect(rows().map((r) => r.verdict.kind)).toEqual(["card", "card"]);
    expect(qcVerdict({ row: "E941-S1", required: false, qc: undefined, cardText: "x" })).toBeUndefined();
  });

  it("a card the fresh reader finds ambiguous is held, naming the ambiguous part; nothing ambiguous passes", () => {
    const amb = qcFile("E941-S1", cardText("E941-S1"), {
      pass: false,
      held: ['ambiguous: "Keep it?": the new page or the old one?'],
      reader: { asked: "Keep the page?", ambiguous: '"Keep it?": the new page or the old one?' },
    });
    const clear = qcFile("E941-S2", cardText("E941-S2"), { reader: { asked: "Keep the new page?", ambiguous: "" } });
    const made = repo({ "E941-S1": amb, "E941-S2": clear });
    expect(byRef("E941-S1").verdict).toMatchObject({
      kind: "fails-qc",
      reason: "ambiguous",
      problems: ['a fresh reader found this most ambiguous: "Keep it?": the new page or the old one?', "they read the card as asking: Keep the page?"],
    });
    expect(readQc(made.dir, "E941-S2")?.reader).toEqual({ asked: "Keep the new page?", ambiguous: "" });
    expect(byRef("E941-S2").verdict.kind).toBe("card");
  });

  it("a dead end on the evidence page holds the card, naming the step and its screen; a clean walk passes", () => {
    const dead = qcFile("E941-S1", cardText("E941-S1"), {
      pass: false,
      held: ["dead end: step 2, the 'Open' button on http://h/p/ does nothing"],
      clicks: { dead: "step 2, the 'Open' button on http://h/p/ does nothing", shot: "E941-S1-dead.webp" },
    });
    const clean = qcFile("E941-S2", cardText("E941-S2"), { clicks: { dead: null } });
    const made = repo({ "E941-S1": dead, "E941-S2": clean });
    expect(byRef("E941-S1").verdict).toMatchObject({
      kind: "fails-qc",
      reason: "dead end",
      problems: ["step 2, the 'Open' button on http://h/p/ does nothing", "its screen: docs/cards/qc/E941-S1-dead.webp"],
    });
    expect(readQc(made.dir, "E941-S2")?.clicks).toEqual({ dead: null });
    expect(byRef("E941-S2").verdict.kind).toBe("card");
  });

  it("a broken result file never passes: it reads as no check", () => {
    const made = repo({ "E941-S1": "{not json", "E941-S2": qcFile("E941-S2", cardText("E941-S2")) });
    expect(readQc(made.dir, "E941-S1")).toBeUndefined();
    expect(byRef("E941-S1").verdict).toMatchObject({ kind: "fails-qc", reason: "not checked yet" });
  });
});

describe("E948-S62 judge fix: the model answers breaches as a list", () => {
  it("asks for visual.breaches [{rule, width, what}] and no pass flag", () => {
    const v = QC_JUDGE_SCHEMA.properties.visual;
    expect(v.required).toEqual(["breaches", "summary"]);
    expect(Object.keys(v.properties)).not.toContain("pass");
    expect(v.properties.breaches.items.required).toEqual(["rule", "width", "fault", "what"]);
  });
  it("each point says whether the evidence page shows it and what changed since the last check", () => {
    const w = QC_JUDGE_SCHEMA.properties.words.items;
    expect(w.required).toEqual(["n", "status", "how", "onPage", "changed"]);
    expect(w.properties.onPage.type).toBe("boolean");
    expect(w.properties.changed.type).toBe("string");
  });
  it("the card judge and the ask dry run both answer what is asked and the most ambiguous part", () => {
    expect(QC_JUDGE_SCHEMA.required).toContain("reader");
    expect(QC_JUDGE_SCHEMA.properties.reader.required).toEqual(["asked", "ambiguous", "changesAnswer"]);
    expect(JUDGE_SCHEMAS.dryrun.required).toEqual(["steps", "asked", "ambiguous", "verdict", "firstProblem", "changed", "notStated", "answeredBy", "changesAnswer"]);
    expect(JUDGE_SCHEMAS.dryrun.properties.ambiguous.type).toBe("string");
  });
});

describe("E948-S62 the judge route", () => {
  it("passes the prompt and screens to the model and returns its answer; refuses a bad request", async () => {
    const seen: { prompt: string; n: number }[] = [];
    const api = new Hono();
    mountQcJudge(api, async (prompt, images) => (seen.push({ prompt, n: images.length }), { value: { words: [], visual: { pass: true, problems: [], summary: "ok" } }, costUsd: 0.001 }));
    const ok = await api.request("/review-qc/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "judge it", images: [{ label: "390", data: "aGk=" }] }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ answer: { visual: { pass: true } }, costUsd: 0.001 });
    expect(seen).toEqual([{ prompt: "judge it", n: 1 }]);
    const bad = await api.request("/review-qc/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "", images: [] }) });
    expect(bad.status).toBe(400);
    const many = await api.request("/review-qc/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", images: Array.from({ length: 9 }, () => ({ label: "a", data: "aGk=" })) }) });
    expect(many.status).toBe(400);
  });
});

describe("the judge route answers the delivery check's two questions by name", () => {
  it("passes schema groups or live to the model, defaults to qc, refuses any other name", async () => {
    const seen: (string | undefined)[] = [];
    const api = new Hono();
    mountQcJudge(api, async (_p, _i, schema) => (seen.push(schema), { value: { live: "no", seen: "a list", missing: "the key results" }, costUsd: 0 }));
    const ask = (body: object) => api.request("/review-qc/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const live = await ask({ prompt: "is it live?", images: [], schema: "live" });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ answer: { live: "no" }, schema: "live" });
    expect((await ask({ prompt: "which repeat?", schema: "groups" })).status).toBe(200);
    expect((await ask({ prompt: "judge it" })).status).toBe(200);
    expect(seen).toEqual(["live", "groups", "qc"]);
    const bad = await ask({ prompt: "x", schema: "anything" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "bad_schema" } });
    expect(Object.keys(JUDGE_SCHEMAS)).toEqual(["qc", "groups", "live", "dryrun"]);
    expect(DELIVERY_LIVE_SCHEMA.properties.live.enum).toEqual(["yes", "partly", "no"]);
    expect(DELIVERY_GROUPS_SCHEMA.properties.groups.items.required).toEqual(["ask", "items", "quotes", "screen"]);
  });
});

describe("E948-S62 the judge route is on the whole console app", () => {
  // the bare-Hono test above passes even when createApp never mounts the route, so production can answer 404
  // when a release lacks it. This one fails the moment the full app stops serving it.
  it("POST /api/review-qc/judge reaches the judge through createApp (never the 404 catch-all)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e948s62-"));
    const db = openDb(path.join(dir, "console.db"));
    try {
      const { createApp } = await import("../src/app.js");
      const seen: number[] = [];
      const app = createApp(db, { browser: { browserUrl: "http://127.0.0.1:9" }, read: { reposRoot: path.join(dir, "repos"), seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] }, qcJudge: async (_p, images) => (seen.push(images.length), { value: { words: [], visual: { pass: true, problems: [], summary: "ok" } }, costUsd: 0 }) });
      const res = await app.request("/api/review-qc/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "judge it", images: [{ label: "1280", data: "aGk=" }] }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ answer: { visual: { pass: true } } });
      expect(seen).toEqual([1]);
      const bad = await app.request("/api/review-qc/judge", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(bad.status).toBe(400);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a console without the key says so in a 502 the check can name (staging never reads keys)", async () => {
    const { anthropicQcJudge } = await import("../src/review/qc.js");
    const api = new Hono();
    mountQcJudge(api, anthropicQcJudge(async () => undefined));
    const res = await api.request("/review-qc/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", images: [] }) });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "judge_failed", message: expect.stringContaining("no ANTHROPIC_API_KEY") } });
  });
});
