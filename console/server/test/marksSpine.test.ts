import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { activeMark, addMarks, markKey, noteMarksOf, type MarkInput } from "../src/review/noteMarks.js";
import { createNoteTouch, flat, isTyped, noteKey, openAiTouchJudge, saidIn, spokenAt, TOUCH_HEAD, TOUCH_MIN_TYPED_WORDS, TOUCH_MIN_WORDS, type TouchCard, type TouchJudge } from "../src/voice/touch.js";
import { makeRepo, spineText, web } from "./reviewFixture.js";

/**
 * after a long note, each card in his inbox it touches shows
 * "updated" or "stale" until its owner acts, and the owner is woken with his words. The mark is a Decisions line in the
 * card's spine (L-45), keyed to the card as it was, so it clears itself when the row moves or the ask is rewritten.
 */

const SAID = "the clip should end on the app address. the flywheel is a big rock. we have YouTube now. redo it from scratch. the flywheel is one of the big rocks. end it on the app address. ";
const LONG = (extra = "") => SAID + `${"I keep thinking about the inbox and the cards and how they land. ".repeat(Math.ceil(TOUCH_MIN_WORDS / 12) + 2)}${extra}`;

const SPINE = [
  "# EPIC-948: Review inbox",
  "",
  "## Issue Ledger",
  "",
  "| Issue | Title | Status |",
  "|---|---|---|",
  "| E948-S37 | The clip | review (live abc1234) |",
  "",
  "## Decisions",
  "",
  "| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |",
  "|---|---|---|---|---|---|",
  "| 2026-11-09 | accepted | something earlier | why | none | — |",
  "",
  "## Waiting on",
  "",
].join("\n");

const mark = (o: Partial<MarkInput> = {}): MarkInput => ({
  ref: "E948-S37",
  kind: "stale",
  at: "2026-11-10 23:08Z",
  quote: 'make the ending say "Epic Team dot app" | twice',
  why: "he wants a new ending",
  note: "WhatsApp, Log/2026-11-10.md#^e-449504",
  current: "review (live abc1234)",
  date: "2026-11-10",
  ...o,
});

describe("E948-S40 marks in the spine", () => {
  it("adds one Decisions line per card under the table, reads it back, and never writes it twice", () => {
    const r = addMarks(SPINE, [mark(), mark({ ref: "E948-A8", kind: "updated", current: "Which line is second?" })]);
    expect(r.added).toBe(2);
    const lines = r.text.split("\n");
    const at = lines.findIndex((l) => l.includes("something earlier"));
    expect(lines[at + 1]).toMatch(/^\| 2026-11-10 \| stale \| E948-S37: your voice note of 2026-11-10 23:08Z changed this: "make the ending say 'Epic Team dot app' \/ twice" \(mark key [0-9a-f]{8}\) \|/);
    expect(lines[at + 2]).toContain("| updated | E948-A8: your voice note of 2026-11-10 23:08Z added to this:");
    // the rest of the spine is untouched
    expect(r.text.indexOf("## Waiting on")).toBeGreaterThan(r.text.indexOf("E948-A8: your voice note"));
    const marks = noteMarksOf(r.text);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({ kind: "stale", ref: "E948-S37", at: "2026-11-10 23:08Z", quote: "make the ending say 'Epic Team dot app' / twice", why: "he wants a new ending", key: markKey("review (live abc1234)") });
    expect(addMarks(r.text, [mark()]).added).toBe(0);
  });

  it("a line he typed says 'your message', not 'your voice note', and still reads back", () => {
    const r = addMarks(SPINE, [mark({ note: "a message to the Team desk, chat-f37c98e1" })]);
    expect(r.text).toContain("E948-S37: your message of 2026-11-10 23:08Z changed this:");
    expect(noteMarksOf(r.text)).toHaveLength(1);
    expect(addMarks(r.text, [mark({ note: "a message to the Team desk, chat-f37c98e1" })]).added).toBe(0);
  });

  it("holds while the card is as it was and clears the moment its status or question changes", () => {
    const marks = noteMarksOf(addMarks(SPINE, [mark()]).text);
    expect(activeMark(marks, "E948-S37", "review (live abc1234)")?.kind).toBe("stale");
    // spacing and inline marks do not count as a change
    expect(activeMark(marks, "E948-S37", "review  (live `abc1234`)")).toBeDefined();
    expect(activeMark(marks, "E948-S37", "active (iteration 2, relaunched by Sam 2026-11-11)")).toBeUndefined();
    expect(activeMark(marks, "E948-S38", "review (live abc1234)")).toBeUndefined();
    // the newest line for a card wins
    const again = noteMarksOf(addMarks(addMarks(SPINE, [mark()]).text, [mark({ kind: "updated", at: "2026-11-11 08:00Z" })]).text);
    expect(activeMark(again, "E948-S37", "review (live abc1234)")).toMatchObject({ kind: "updated", at: "2026-11-11 08:00Z" });
  });

  it("makes the Decisions section when the spine has none, and fits a table with other columns", () => {
    const bare = "# EPIC-909: x\n\n## Issue Ledger\n\n| Issue | Status |\n|---|---|\n| E909-S1 | review |\n";
    const r = addMarks(bare, [mark({ ref: "E909-S1", current: "review" })]);
    expect(r.text).toMatch(/## Decisions\n\n\| Date \| Outcome \|/);
    expect(activeMark(noteMarksOf(r.text), "E909-S1", "review")).toBeDefined();
    const narrow = "# x\n\n## Decisions\n\n| Date | Outcome | Decision |\n|---|---|---|\n";
    const n = addMarks(narrow, [mark()]);
    const line = n.text.split("\n").find((l) => l.includes("E948-S37:"))!;
    expect(line.split(" | ")).toHaveLength(3);
    expect(activeMark(noteMarksOf(n.text), "E948-S37", "review (live abc1234)")).toBeDefined();
  });
});

describe("E948-S40 the long-note pass", () => {
  let db: DB;
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s40-"));
    db = openDb(path.join(tmp, "console.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const CARDS: TouchCard[] = [
    { kind: "row", ref: "E948-S37", title: "The red line clip", about: "a clip of the red line", repo: "home_repo", path: "docs/spines/epic-48.md", milestoneId: "ms_a", current: "review (live abc1234)" },
    { kind: "ask", ref: "E948-A8", title: "Is the flywheel the second red line?", about: "", repo: "home_repo", path: "docs/spines/epic-48.md", milestoneId: "ms_a", current: "Is the flywheel the second red line?" },
    { kind: "row", ref: "E931-S3", title: "YouTube upload", about: "Shorts", repo: "memo", path: "docs/spines/e31.md", milestoneId: "ms_b", current: "review" },
  ];
  const setup = (verdict: Awaited<ReturnType<TouchJudge>>) => {
    const judged: Parameters<TouchJudge>[0][] = [];
    const marks: { repo: string; path: string; refs: string[] }[] = [];
    const wakes: { mid: string; text: string; key: string }[] = [];
    const told: string[] = [];
    const t = createNoteTouch({
      db,
      judge: async (n) => (judged.push(n), verdict),
      cards: async () => CARDS,
      mark: async (repo, p, ms) => (marks.push({ repo, path: p, refs: ms.map((m) => m.ref) }), true),
      wake: async (mid, text, key) => (wakes.push({ mid, text, key }), true),
      tell: async (_w, text) => (told.push(text), true),
      now: () => Date.parse("2026-11-10T23:30:00Z"),
    });
    return { t, judged, marks, wakes, told };
  };

  it("marks each touched card in its spine, wakes each milestone's owner once with his words, and tells the desk", async () => {
    const s = setup([
      { ref: "E948-S37", how: "stale", quote: "the clip should end on the app address", why: "new ending" },
      { ref: "E948-A8", how: "updated", quote: "the flywheel is a big rock", why: "adds a goal" },
      { ref: "E931-S3", how: "updated", quote: "we have YouTube now", why: "channel live" },
      { ref: "NOPE-1", how: "stale", quote: "made up", why: "" },
    ]);
    const words = `🎙 Voice note (WhatsApp → Memory), 2026-11-10 23:08Z\nMemory: Log/2026-11-10.md#^e-449504\n\n${LONG()}`;
    expect(await s.t.heard({ world: "acme", words, where: "WhatsApp", id: "wa-1" })).toBe("done");
    expect(s.judged[0].cards.map((c) => c.ref)).toEqual(["E948-S37", "E948-A8", "E931-S3"]);
    // one write per spine, unknown codes dropped
    expect(s.marks).toEqual([
      { repo: "home_repo", path: "docs/spines/epic-48.md", refs: ["E948-S37", "E948-A8"] },
      { repo: "memo", path: "docs/spines/e31.md", refs: ["E931-S3"] },
    ]);
    expect(s.wakes.map((w) => w.mid)).toEqual(["ms_a", "ms_b"]);
    expect(s.wakes[0].text).toContain("Sam's voice note of 2026-11-10 23:08Z (WhatsApp");
    expect(s.wakes[0].text).toContain('E948-S37 (home_repo docs/spines/epic-48.md), STALE: his note changed what it is about. He said: "the clip should end on the app address"');
    expect(s.wakes[0].key).toBe("note-touch:Log/2026-11-10.md#^e-449504:ms_a");
    expect(s.told).toHaveLength(1);
    expect(s.told[0].startsWith(`${TOUCH_HEAD} 3 card(s)`)).toBe(true);
    // the same note again (a retry, the chat note and its filing): never judged twice
    expect(await s.t.heard({ world: "acme", words, where: "WhatsApp", id: "wa-2" })).toBe("done");
    expect(s.judged).toHaveLength(1);
    expect(s.t.get("Log/2026-11-10.md#^e-449504")).toMatchObject({ state: "done", spoken_at: "2026-11-10 23:08Z" });
  });

  it("leaves short notes, console lines and notes that touch nothing alone", async () => {
    const s = setup([]);
    expect(await s.t.heard({ world: "acme", words: "yes go ahead with the second option", where: "Chat" })).toBeUndefined();
    expect(await s.t.heard({ world: "acme", words: `📎 Also in this note (vn_1): ${LONG()}`, where: "Chat" })).toBeUndefined();
    expect(await s.t.heard({ world: "acme", words: `${TOUCH_HEAD} 2 cards ${LONG()}`, where: "Chat" })).toBeUndefined();
    expect(s.judged).toHaveLength(0);
    expect(await s.t.heard({ world: "acme", words: LONG(), where: "Chat", id: "x1" })).toBe("none");
    expect(s.marks).toHaveLength(0);
    expect(s.wakes).toHaveLength(0);
    expect(s.told).toHaveLength(0);
  });

  it("a typed desk message marks the cards it speaks about, from TOUCH_MIN_TYPED_WORDS words, and says typed", async () => {
    const typed = "Didn't any of the many workers we have picked up on this not being reflected? The red line clip should end on the app address, not the logo.";
    expect(isTyped(typed)).toBe(true);
    expect(isTyped("🎙 Voice note (Chat), 2026-11-13 17:57Z\n\nhello")).toBe(false);
    expect(typed.split(/\s+/).length).toBeGreaterThanOrEqual(TOUCH_MIN_TYPED_WORDS);
    expect(typed.split(/\s+/).length).toBeLessThan(TOUCH_MIN_WORDS);
    const s = setup([{ ref: "E948-S37", how: "stale", quote: "The red line clip should end on the app address", why: "new ending" }]);
    // the same words as a voice note are too short; typed they are read
    expect(await s.t.heard({ world: "acme", words: typed, where: "a message to the Team desk", id: "t0" })).toBeUndefined();
    expect(await s.t.heard({ world: "acme", words: typed, where: "a message to the Team desk", id: "t1", typed: true })).toBe("done");
    expect(s.marks).toEqual([{ repo: "home_repo", path: "docs/spines/epic-48.md", refs: ["E948-S37"] }]);
    expect(s.wakes[0].text).toContain("Sam's typed message of");
    expect(s.wakes[0].text).toContain("STALE");
    // a short typed answer stays the desk's to place
    expect(await s.t.heard({ world: "acme", words: "yes go ahead with the second option", where: "a message to the Team desk", typed: true })).toBeUndefined();
    expect(s.judged).toHaveLength(1);
  });

  it("skips a card whose spine words already cite the note: it was made from it", async () => {
    const s = setup([{ ref: "E948-S37", how: "stale", quote: "x", why: "" }]);
    const made = createNoteTouch({
      db,
      judge: async (n) => (s.judged.push(n), []),
      cards: async () => [{ ...CARDS[0], text: "Widened by Sam's WhatsApp voice note 2026-11-10 23:08Z (Memory Log/2026-11-10.md#^e-449504)" }, CARDS[1]],
      mark: async () => true,
    });
    await made.heard({ world: "acme", words: `🎙 Voice note (WhatsApp → Memory), 2026-11-10 23:08Z\nMemory: Log/2026-11-10.md#^e-449504\n\n${LONG()}`, where: "WhatsApp" });
    expect(s.judged[0].cards.map((c) => c.ref)).toEqual(["E948-A8"]);
  });

  it("marks nothing with words he did not say (the model copied the card's words)", async () => {
    const s = setup([
      { ref: "E948-S37", how: "stale", quote: "We want you to talk to either desk and have it reach the other.", why: "" },
      { ref: "E948-A8", how: "updated", quote: "The flywheel is a big rock!", why: "" },
    ]);
    expect(await s.t.heard({ world: "acme", words: LONG(), where: "Chat", id: "q1" })).toBe("done");
    expect(s.marks).toEqual([{ repo: "home_repo", path: "docs/spines/epic-48.md", refs: ["E948-A8"] }]);
    expect(saidIn(flat(LONG()), "the clip should … end on the app address")).toBe(true);
    expect(saidIn(flat(LONG()), "yes")).toBe(false);
  });

  it("the model's own leave-outs mark nothing: speaks false, or a why that says it is not about the card", async () => {
    const answer = { touched: [
      { ref: "E948-S37", speaks: false, how: "updated", quote: "the clip should end on the app address", why: "" },
      { ref: "E948-A8", speaks: true, how: "updated", quote: "the flywheel is a big rock", why: "Not about this card; omitted." },
      { ref: "E931-S3", speaks: true, how: "updated", quote: "we have YouTube now", why: "the channel is live" },
    ] };
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 })) as unknown as typeof fetch;
    const got = await openAiTouchJudge(async () => "k", f)({ words: LONG(), cards: CARDS });
    expect(got.map((t) => t.ref)).toEqual(["E931-S3"]);
  });

  it("keys a note by its vn id, its Memo ref, else its words; reads when he spoke from the note", () => {
    expect(noteKey({ id: "voice-note-chat-vn_ab12", words: "x" })).toBe("vn_ab12");
    expect(noteKey({ words: "🎙 Voice note (Chat), 2026-11-10 20:45Z · 0 min 36 s · vn_ffa4783d\n\nwords" })).toBe("vn_ffa4783d");
    expect(noteKey({ words: "🎙 Voice note (WhatsApp → Memory), 2026-11-10 23:08Z\nMemory: Log/2026-11-10.md#^e-449504 · https://x" })).toBe("Log/2026-11-10.md#^e-449504");
    expect(noteKey({ words: "plain" })).toMatch(/^h_[0-9a-f]{20}$/);
    expect(spokenAt({ words: "🎙 Voice note (Chat), 2026-11-10 20:45Z · 0 min" }, 0)).toBe("2026-11-10 20:45Z");
    expect(spokenAt({ at: "2026-11-10T23:08:32.000Z", words: "" }, 0)).toBe("2026-11-10 23:08Z");
  });

  it("a failed spine write marks nothing and wakes no one for that card", async () => {
    const s = setup([{ ref: "E948-S37", how: "stale", quote: "redo it from scratch", why: "" }]);
    const t = createNoteTouch({ db, judge: async () => [{ ref: "E948-S37", how: "stale", quote: "redo it from scratch", why: "" }], cards: async () => CARDS, mark: async () => "failed: push refused", wake: async (mid, text, key) => (s.wakes.push({ mid, text, key }), true) });
    expect(await t.heard({ world: "acme", words: LONG(), where: "Chat", id: "f1" })).toBe("failed");
    expect(s.wakes).toHaveLength(0);
  });
});

describe("E948-S40 his inbox shows the mark until the owner acts", () => {
  const EPIC = "docs/spines/epic-48.md";
  const LIVE = "https://team.example/clip";
  let tmp: string;
  let db: DB;
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s40-app-"));
    repo = makeRepo(tmp, "home_repo", {
      "docs/spines/root.md": "# EPIC: home_repo\n\nRoot spine: self\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n",
      [EPIC]: spineText(
        "EPIC-948",
        "Review inbox",
        [
          { id: "E948-S37", title: "The red line clip", status: "review (live abc1234)", evidence: `[clip](${LIVE})` },
          { id: "E948-S38", title: "Another card", status: "review", evidence: `[clip](${LIVE}?b)` },
        ],
        ["## Waiting on", "", "- [ask E948-A8: decide @Sam] Is the flywheel the second red line? — options: A / B — since: 2026-11-10", ""],
      ),
    });
    db = openDb(path.join(tmp, "console.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the marks through the spine writer; the review card and the ask carry them; a moved row drops its mark", async () => {
    const w = web({ [LIVE]: 200, [`${LIVE}?b`]: 200 });
    const app = createApp(db, { read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] }, review: { live: { fetch: w.f, consoleHosts: [] } } });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    await call("POST", "/api/milestones", { title: "Review inbox", repo: "Acme/home_repo", path: EPIC });
    const items = async () => {
      await call("GET", "/api/review-items");
      await new Promise((r) => setTimeout(r, 30));
      return (await call("GET", "/api/review-items")).json as { ref: string; noteMark?: { kind: string; quote: string; at: string } }[];
    };
    expect((await items()).map((i) => i.ref).sort()).toEqual(["E948-S37", "E948-S38"]);

    const writer = createSpineWriter();
    const touch = createNoteTouch({
      db,
      judge: async () => [
        { ref: "E948-S37", how: "stale", quote: "the clip should end on the app address", why: "new ending" },
        { ref: "E948-A8", how: "updated", quote: "the flywheel is one of the big rocks", why: "adds a goal" },
      ],
      cards: async () => [
        { kind: "row", ref: "E948-S37", title: "clip", about: "", repo: "home_repo", path: EPIC, current: "review (live abc1234)" },
        // the question as the inbox lists it (what the console keys the mark to)
        { kind: "ask", ref: "E948-A8", title: "flywheel", about: "", repo: "home_repo", path: EPIC, current: "Is the flywheel the second red line? — since: 2026-11-10" },
      ],
      mark: async (_repo, rel, marks) => {
        const r = await writer.edit({ repoDir: repo.dir, path: rel, label: "marks", edit: (text) => ({ text: addMarks(text, marks).text, msg: "E948-S40: marks", body: "test" }) });
        return r.status === "written" ? true : `${r.status}: ${r.reason}`;
      },
    });
    expect(await touch.heard({ world: "acme", words: `🎙 Voice note (WhatsApp → Memory), 2026-11-10 23:08Z\n\n${LONG()}`, where: "WhatsApp", id: "wa" })).toBe("done");
    expect(repo.originLog()[0]).toBe("E948-S40: marks");

    const after = await items();
    expect(after.find((i) => i.ref === "E948-S37")?.noteMark).toMatchObject({ kind: "stale", at: "2026-11-10 23:08Z", quote: "the clip should end on the app address" });
    expect(after.find((i) => i.ref === "E948-S38")?.noteMark).toBeUndefined();
    const asks = (await call("GET", "/api/waiting-on-owner")).json as { code?: string; noteMark?: { kind: string } }[];
    expect(asks.find((a) => a.code === "E948-A8")?.noteMark).toMatchObject({ kind: "updated" });

    // the owner acts: a new iteration moves the row, and the mark is gone without anyone clearing it
    repo.setRow(EPIC, "E948-S37", "review (iteration 2, live def5678)");
    const moved = await items();
    expect(moved.find((i) => i.ref === "E948-S37")?.noteMark).toBeUndefined();
    // the ask's owner rewrites it with his words: its mark goes too
    const file = path.join(repo.dir, EPIC);
    fs.writeFileSync(file, repo.read(EPIC).replace("Is the flywheel the second red line?", "Is the flywheel the second red line, as one of your big rocks?"));
    const t = new Date(Date.now() + 10_000);
    fs.utimesSync(file, t, t);
    const rewritten = (await call("GET", "/api/waiting-on-owner")).json as { code?: string; noteMark?: unknown }[];
    expect(rewritten.find((a) => a.code === "E948-A8")).toBeDefined();
    expect(rewritten.find((a) => a.code === "E948-A8")?.noteMark).toBeUndefined();
  });

  it("the console's own pass: a WhatsApp note the desk got, read from Memo, marks the review card it touches in the spine", async () => {
    const w = web({ [LIVE]: 200, [`${LIVE}?b`]: 200 });
    const judged: string[][] = [];
    const app = createApp(db, {
      read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
      review: { live: { fetch: w.f, consoleHosts: [] } },
      noteTouch: { judge: async (n) => (judged.push(n.cards.map((c) => c.ref)), [{ ref: "E948-S37", how: "stale", quote: "end it on the app address", why: "new ending" }]) },
      mcp: { memoryLookup: async (ref) => ({ entry: { evidenceRef: ref, capturedAt: "2026-11-10T23:08:32.000Z", source: "whatsapp", contentType: "voice_note", content: `Source: WhatsApp voice note\n\n${LONG()}` } }) },
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    await call("POST", "/api/milestones", { title: "Review inbox", repo: "Acme/home_repo", path: EPIC });
    await call("GET", "/api/review-items");
    await new Promise((r) => setTimeout(r, 30));
    const REF = "Log/2026-11-10.md#^e-449504";
    // only a note the Team desk got
    expect((await call("POST", "/api/desk/voice-touches/run", { ref: REF })).status).toBe(404);
    expect((await call("POST", "/api/desk/voice-touches/run", { ref: "anything" })).status).toBe(400);
    db.prepare("INSERT INTO desk_voice_notes (evidence_ref, captured_at, state, seen_at, posted_at) VALUES (?, ?, 'posted', ?, ?)").run(REF, "2026-11-10T23:08:32.000Z", "2026-11-10T23:09:00Z", "2026-11-10T23:09:00Z");
    const r = await call("POST", "/api/desk/voice-touches/run", { ref: REF });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("done");
    // the model saw both review cards and the open ask
    expect(judged[0].sort()).toEqual(["E948-A8", "E948-S37", "E948-S38"]);
    expect(repo.originLog()[0]).toBe("Sam's voice note of 2026-11-10 23:08Z marks E948-S37 (stale)");
    const items = (await call("GET", "/api/review-items")).json as { ref: string; noteMark?: { kind: string; quote: string } }[];
    expect(items.find((i) => i.ref === "E948-S37")?.noteMark).toMatchObject({ kind: "stale", quote: "end it on the app address" });
    // once per note
    expect((await call("POST", "/api/desk/voice-touches/run", { ref: REF })).json.state).toBe("done");
    expect(judged).toHaveLength(1);
    expect((await call("GET", "/api/desk/voice-touches")).json.passes[0]).toMatchObject({ note_key: REF, state: "done", touched: [{ ref: "E948-S37", how: "stale", marked: true }] });
  });
});
