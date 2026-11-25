import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createNoteTouch, openAiTouchConfirm, openAiTouchJudge, passageOf, takesBack, type TouchCard, type TouchConfirm, type Touched } from "../src/voice/touch.js";

/**
 * E942-S174 the console puts his note only on the card it is about. Three wrong touches on 22 Nov, each caught by the desk
 * by hand (the E942-S141 audit, failure 17):
 *   16:12Z his house note ("a table that had five key results, so it's like a weird way to talk about criteria") went on the
 *          key-results card E940-S91;
 *   16:50Z his note about his dad ("He wants me to play a character to leave a fiction, and I am saying no") marked the
 *          script card E948-A28 stale;
 *   20:00Z his typed remark, taken back at 20:01Z ("you can ignore my last message"), went on the family card E940-A11.
 */

const HOUSE =
  "🎙 Voice note (WhatsApp → Memory), 2026-11-22 16:12Z\nMemory: Log/2026-11-22.md#^e-6b8c8a\n\n" +
  "So for the house decision, for example, do we have one place that is like another canonical place where everything stems from or the knowledge is totally disconnected? " +
  "What are the criteria that we're using? Because I see, today I saw a table that had five key results, so it's like a weird way to talk about criteria. And I didn't see premiumness in it. " +
  "And I don't know how many times I've said this bro, so for me this is frustrating because it's months and months of context. ".repeat(30);
const DAD =
  "🎙 Voice note (WhatsApp → Memory), 2026-11-22 16:50Z\nMemory: Log/2026-11-22.md#^e-aed0e1\n\n" +
  "It's almost like he wants to leave me a fiction. He wants me to play a character to leave a fiction, and I am saying no. " +
  "I'm saying no, and I have already tried to explain it's difficult because I don't want to hurt his feelings. ".repeat(30);
const TYPED =
  "You see this card, this is a great example of it asking me to approve these three objectives, but it's talking about three objectives, but there is nothing for me to check which objectives they are.";

const CARDS: TouchCard[] = [
  { kind: "row", ref: "E940-S91", title: "Each objective shows its key results as one table.", about: "Every objective lists its key results.", topic: "your objectives", repo: "home_repo", path: "docs/spines/epic-40.md", milestoneId: "ms_a", current: "review" },
  { kind: "ask", ref: "E948-A28", title: "Read this script, now with your 16:50 points, to your dad?", about: "a short script to read to your dad", topic: "your reply to Dad", repo: "home_repo", path: "docs/spines/epic-48.md", milestoneId: "ms_a", current: "Read this script?" },
  { kind: "ask", ref: "E940-A11", title: "Pick the family objective's three key results?", about: "family key results", topic: "the family objective", repo: "home_repo", path: "docs/spines/epic-40.md", milestoneId: "ms_a", current: "Pick?" },
];

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

function setup(verdict: Touched[], confirm?: TouchConfirm, sleep?: (ms: number) => Promise<void>) {
  const marks: string[] = [];
  const told: string[] = [];
  const looked: string[] = [];
  const judged: { after?: string }[] = [];
  const t = createNoteTouch({
    db,
    judge: async (n) => (judged.push({ after: n.after }), verdict),
    ...(confirm ? { confirm: async (x) => (looked.push(x.card.ref), confirm(x)) } : {}),
    ...(sleep ? { sleep } : {}),
    cards: async () => CARDS,
    mark: async (_r, _p, m) => (marks.push(...m.map((x) => `${x.ref} ${x.kind}`)), true),
    wake: async () => true,
    tell: async (_w, text) => (told.push(text), true),
  });
  return { t, marks, told, looked, judged };
}

describe("E942-S174 a note goes only on the card it is about", () => {
  it("16:12Z: his house remark about 'five key results' never lands on the key-results card", async () => {
    const s = setup([{ ref: "E940-S91", how: "stale", quote: "a table that had five key results, so it's like a weird way to talk about criteria", why: "redirects its framing" }], async (x) => {
      // the second look sees the house passage around his quote
      expect(x.passage).toContain("house decision");
      return { subject: "the house search's criteria table", same: false, how: "updated", why: "about the house, not objectives" };
    });
    expect(await s.t.heard({ world: "acme", words: HOUSE, where: "WhatsApp" })).toBe("none");
    expect(s.looked).toEqual(["E940-S91"]);
    expect(s.marks).toEqual([]);
    expect(s.told).toEqual([]);
    expect(s.t.recent(1)[0]).toMatchObject({ state: "none", touched: [{ ref: "E940-S91", dropped: true, subject: "the house search's criteria table" }] });
  });

  it("16:50Z: a private remark about his dad never marks the script card stale; the milder mark wins", async () => {
    const quote = "He wants me to play a character to leave a fiction, and I am saying no";
    const no = setup([{ ref: "E948-A28", how: "stale", quote, why: "he refuses the script" }], async () => ({ subject: "his dad wanting him to act out a closeness", same: false, how: "stale", why: "" }));
    expect(await no.t.heard({ world: "acme", words: DAD, where: "WhatsApp" })).toBe("none");
    expect(no.marks).toEqual([]);
    // when the second look finds it is about the script but only adds to it, the card is updated, never stale
    db.exec("DELETE FROM voice_note_touches");
    const add = setup([{ ref: "E948-A28", how: "stale", quote, why: "" }], async () => ({ subject: "the script for his dad", same: true, how: "updated", why: "adds his points" }));
    expect(await add.t.heard({ world: "acme", words: DAD, where: "WhatsApp" })).toBe("done");
    expect(add.marks).toEqual(["E948-A28 updated"]);
  });

  it("a second look that fails marks nothing: fewer, sure marks", async () => {
    const s = setup([{ ref: "E948-A28", how: "stale", quote: "He wants me to play a character to leave a fiction", why: "" }], async () => {
      throw new Error("timeout");
    });
    expect(await s.t.heard({ world: "acme", words: DAD, where: "WhatsApp" })).toBe("none");
    expect(s.marks).toEqual([]);
  });

  it("20:00Z: a typed message he takes back within the grace window marks nothing", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((r) => (release = r));
    const s = setup([{ ref: "E940-A11", how: "updated", quote: "it's talking about three objectives, but there is nothing for me to check", why: "" }], async () => ({ subject: "x", same: true, how: "updated", why: "" }), () => waiting);
    const first = s.t.heard({ world: "acme", words: TYPED, where: "a message to the Team desk", typed: true, id: "chat-780b5144" }, { graceMs: 120_000 });
    // his 20:01Z line arrives while the first waits
    expect(await s.t.heard({ world: "acme", words: "I actually just saw them, you can ignore my last message.", where: "a message to the Team desk", typed: true }, { graceMs: 120_000 })).toBeUndefined();
    release();
    expect(await first).toBe("withdrawn");
    expect(s.judged).toHaveLength(0);
    expect(s.marks).toEqual([]);
    expect(s.t.get("chat-780b5144")).toMatchObject({ state: "withdrawn" });
  });

  it("a typed message not taken back is read after the window, with what he said right after", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((r) => (release = r));
    const s = setup([{ ref: "E940-A11", how: "updated", quote: "it's talking about three objectives, but there is nothing for me to check", why: "needs a link" }], async () => ({ subject: "the family key results card", same: true, how: "updated", why: "needs a link" }), () => waiting);
    const first = s.t.heard({ world: "acme", words: TYPED, where: "a message to the Team desk", typed: true, id: "chat-1" }, { graceMs: 120_000 });
    await s.t.heard({ world: "acme", words: "and the same on the house card", where: "a message to the Team desk", typed: true }, { graceMs: 120_000 });
    release();
    expect(await first).toBe("done");
    expect(s.judged[0].after).toBe("and the same on the house card");
    expect(s.marks).toEqual(["E940-A11 updated"]);
  });

  it("knows a take-back from a point about the work", () => {
    for (const yes of ["I actually just saw them, you can ignore my last message.", "never mind", "Disregard that.", "please ignore the previous note", "forget about my last voice note, I found it"]) expect(takesBack(yes), yes).toBe(true);
    for (const no of ["ignore that table, it is wrong", "you can ignore the old shortlist", "drop the second key result", TYPED]) expect(takesBack(no), no).toBe(false);
  });

  it("the first pass is told each card's topic and what he said after; the second look reads the passage around his quote", async () => {
    const bodies: string[] = [];
    const f = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      const content = bodies.length === 1 ? JSON.stringify({ touched: [] }) : JSON.stringify({ subject: "house criteria table", work: "objectives key results", same: false, how: "updated", why: "" });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await openAiTouchJudge(async () => "k", f)({ words: HOUSE, cards: CARDS, after: "ignore that" });
    expect(bodies[0]).toContain("[About: your objectives]");
    expect(bodies[0]).toContain("What he said right after:\\nignore that");
    const c = await openAiTouchConfirm(async () => "k", f)({ card: CARDS[0], how: "stale", quote: "five key results", passage: passageOf(HOUSE, "a table that had five key results") });
    expect(c).toEqual({ subject: "house criteria table", same: false, how: "updated", why: "" });
    expect(bodies[1]).toContain("About: your objectives");
    expect(bodies[1]).toContain("five key results");
  });

  it("finds the passage around a quote, speech-to-text punctuation aside", () => {
    const p = passageOf(HOUSE, "I saw a table that had five key results", 12);
    expect(p).toContain("five key results");
    expect(p).toContain("criteria");
    expect(p.split(" ").length).toBeLessThanOrEqual(24);
    expect(passageOf("a b c", "nothing here at all", 5)).toBe("a b c");
  });

  it("the console tries the same pass on given words and writes nothing (the proof on his real notes)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s174-"));
    try {
      const app = createApp(db, {
        read: { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] },
        noteTouch: {
          judge: async () => [{ ref: "E940-S91", how: "stale", quote: "a table that had five key results, so it's like a weird way to talk about criteria", why: "" }],
          confirm: async () => ({ subject: "the house criteria table", same: false, how: "updated", why: "" }),
        },
      });
      const post = async (body: unknown) => {
        const r = await app.request("/api/desk/voice-touches/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, json: (await r.json()) as { state: string; marks: unknown[]; pass: { touched: { ref: string; dropped?: boolean }[] } } };
      };
      expect((await post({})).status).toBe(400);
      const r = await post({ words: HOUSE, cards: CARDS.map(({ kind, ref, title, about }) => ({ kind, ref, title, about })) });
      expect(r.json).toMatchObject({ state: "none", marks: [], pass: { touched: [{ ref: "E940-S91", dropped: true }] } });
      const w = await post({ words: TYPED, typed: true, after: "I actually just saw them, you can ignore my last message.", cards: CARDS });
      expect(w.json.state).toBe("withdrawn");
      // nothing reached the console's own record
      expect((db.prepare("SELECT COUNT(*) AS n FROM voice_note_touches").get() as { n: number }).n).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
