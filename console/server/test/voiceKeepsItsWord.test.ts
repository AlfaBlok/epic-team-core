import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { DeskMessage, DeskView } from "../src/desk/session.js";
import { SEED_VERSION } from "../src/desk/desk.js";
import { askButtons, inboxPack, reviewButtons, saidYes, yesButton, yesCheck, type InboxCard } from "../src/voice/inbox.js";
import { answerIn, CALL_FEEDBACK_HEAD, CALL_QUESTION_HEAD, createVoice, pressLanding, sessionConfig, taggedIds, voiceInstructions, type DeskPort } from "../src/voice/voice.js";
import { checkCall, ensureAfterCallColumns } from "../src/voice/afterCall.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// the call keeps its word (his call defects of 18 Nov, call_c83e51e8 and call_a3e08f34): a spoken yes presses
// the card, the desk's answer lands on the call question it answers, "pressed, it landed" only with the commit, and the
// voice never talks over him.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const cards: InboxCard[] = [
  { kind: "review", id: "rv1", code: "E907-S3", title: "Every goal now has a Trackers tab.", decision: "Do we plan the shop? We recommend yes.", buttons: reviewButtons({ decision: "Do we plan the shop? We recommend yes." }) },
  { kind: "review", id: "rv2", code: "E907-S4", title: "Your call was given your inbox.", buttons: reviewButtons({}) },
  { kind: "ask", id: "w1", title: "Can we spend 5 dollars?", milestoneId: "ms_1", buttons: askButtons("approve") },
  { kind: "goal", id: "tc_1", title: "Set the testers goal.", recommend: "10 testers", buttons: ["5 testers", "10 testers", "Answer in words…"] },
  { kind: "ask", id: "w2", title: "A check stopped.", buttons: [] },
];
const msg = (id: string, role: "user" | "assistant", text: string, status = "completed"): DeskMessage => ({ id, role, kind: "message", text, status });

function db0() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s134-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return db;
}

describe("a spoken yes on a card presses it, every time", () => {
  it("his words of call_c83e51e8 card 2 are a yes; a yes that moves on or a no is not", () => {
    expect(saidYes("My answer is yes, but can you actually give the feedback that I'm literally on a call right now and I'm asking you to press buttons, and you seem to be doing it, so it's not clear to me what is the additional. Can you pass that feedback on?")).toBe(true);
    expect(saidYes("Yes, OK, go for it.")).toBe(true);
    expect(saidYes("Do what you recommend.")).toBe(true);
    expect(saidYes("Yes, next card.")).toBe(false);
    expect(saidYes("No, not yet.")).toBe(false);
    expect(saidYes("What is this one about?")).toBe(false);
  });

  it("his plain yes presses the team's recommendation, a Yes choice or Mark complete; never a no or a words button", () => {
    expect(yesButton(cards[0])).toBe("Yes: plan it");
    expect(yesButton(cards[1])).toBe("Mark complete");
    expect(yesButton(cards[2])).toBe("Yes: go ahead");
    expect(yesButton(cards[3])).toBe("10 testers");
    expect(yesButton(cards[4])).toBeUndefined();
  });

  it("the console's yes check tells the voice to press now, once, on the card he was on", () => {
    const r = yesCheck(cards, "rv2", "My answer is yes, but pass this on to the desk", []);
    expect(r).toMatchObject({ place: "card 2 of 5", button: "Mark complete" });
    expect(r.note).toMatch(/press_card with button "Mark complete", number 2 and confirmed=true/);
    expect(yesCheck(cards, "rv2", "yes", ["rv2"])).toEqual({});
    expect(yesCheck(cards, "rv2", "tell me more", [])).toEqual({});
  });

  it("on a live call, yes_check is answered until the card is pressed", async () => {
    const db = db0();
    const desk: DeskPort = { send: vi.fn(async () => ({ threadId: "th", pending: true })), view: async () => ({ messages: [], working: false }) as unknown as DeskView };
    const voice = createVoice({ db, mint: vi.fn(async () => ({ value: "ek", expires_at: 0 })), desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), inbox: async () => cards });
    const s = await voice.start();
    voice.tool(s.call.id, "read_card", { number: 2 });
    expect((voice.tool(s.call.id, "yes_check", { cardId: "rv2", words: "My answer is yes" }) as { button?: string }).button).toBe("Mark complete");
    expect(voice.tool(s.call.id, "press_card", { button: "Mark complete", confirmed: true }).press).toMatchObject({ id: "rv2" });
    expect(voice.tool(s.call.id, "yes_check", { cardId: "rv2", words: "yes" })).toEqual({});
  });

  it("the rule: his yes in a line that asks something else is still his yes to the card", () => {
    expect(inboxPack(cards)).toContain("My answer is yes, but pass this on");
  });
});

describe("the desk's answer lands on the call question it answers", () => {
  const q = (n: number, head = CALL_QUESTION_HEAD) => `${head} (call_a3-q${n})`;
  it("a tagged reply answers each question it names, even one answered inside another's reply (q7 in q8's)", () => {
    const m = [msg("1", "user", `${q(7)}\nevidence link`), msg("2", "user", `${q(8)}\ntester applications`), msg("3", "assistant", "↩ call_a3-q7, call_a3-q8: The evidence link is on E907-S5, and tester applications is out.")];
    expect(answerIn({ messages: m, working: false }, q(7))).toEqual({ state: "answered", answer: "The evidence link is on E907-S5, and tester applications is out." });
    expect(answerIn({ messages: m, working: false }, q(8)).answer).toMatch(/^The evidence link/);
    expect(taggedIds(m[2].text)).toEqual(["call_a3-q7", "call_a3-q8"]);
  });

  it("a line between tool calls is not the answer (q6): the tagged final reply is", () => {
    const m = [msg("1", "user", `${q(6)}\nreplace the key result`), msg("2", "assistant", "Now the posting itself (the posting team's job) and the counter that measures it (ours)."), msg("3", "user", `${q(7)}\nlink`), msg("4", "assistant", "↩ call_a3-q6: Your new key result is in the scorecard, counted daily.")];
    expect(answerIn({ messages: m.slice(0, 3), working: true }, q(6)).state).toBe("working");
    expect(answerIn({ messages: m, working: false }, q(6)).answer).toBe("Your new key result is in the scorecard, counted daily.");
    // a reply tagged only for another question is not this one's
    expect(answerIn({ messages: m, working: false }, q(7)).state).toBe("working");
  });

  it("call feedback answered after the transcript message still lands (q9)", () => {
    const m = [msg("1", "user", `${q(9, CALL_FEEDBACK_HEAD)}\n- his words`), msg("2", "user", "📞 Call with the desk · record"), msg("3", "assistant", "↩ call_a3-q9: Filed: five key results out.")];
    expect(answerIn({ messages: m, working: false }, q(9, CALL_FEEDBACK_HEAD)).answer).toBe("Filed: five key results out.");
  });

  it("the desk is told to tag each call reply (seed v46)", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(46);
  });

  it("the after-call check writes a found answer onto its question", () => {
    const db = db0();
    createVoice({ db, mint: vi.fn(), quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }) });
    ensureAfterCallColumns(db);
    db.prepare("INSERT INTO voice_calls (id, started_at, last_beat_at, ended_at, model, transcript) VALUES ('call_a3', '2026-11-18T04:17:00Z', '2026-11-18T04:29:00Z', '2026-11-18T04:29:37Z', 'm', '[]')").run();
    db.prepare("INSERT INTO voice_asks (id, call_id, n, request, head, sent_at) VALUES ('call_a3-q7', 'call_a3', 7, 'link', ?, '2026-11-18T04:26:08Z')").run(q(7));
    const ch = checkCall(db, "call_a3", { answerOf: () => "On E907-S5.", now: () => Date.parse("2026-11-18T05:00:00Z") })!;
    expect(ch.gaps).toEqual([]);
    expect((db.prepare("SELECT answer FROM voice_asks WHERE id = 'call_a3-q7'").get() as { answer: string }).answer).toBe("On E907-S5.");
  });
});

describe("'pressed, it landed' only when the commit shows", () => {
  it("the press log says landed only with a commit", () => {
    const db = db0();
    db.exec("CREATE TABLE IF NOT EXISTS presses (id TEXT, at TEXT, target TEXT, route TEXT, action TEXT, state TEXT, sha TEXT, reason TEXT, result TEXT)");
    const since = "2026-11-18T03:35:00Z";
    expect(pressLanding(db, "rv2", since)).toEqual({ state: "none" });
    db.prepare("INSERT INTO presses (id, at, target, route, action, state, sha) VALUES ('p1', '2026-11-18T03:38:00Z', 'rv2', '/review-items/rv2/complete', 'complete', 'landing', NULL)").run();
    expect(pressLanding(db, "rv2", since)).toEqual({ state: "landing" });
    db.prepare("UPDATE presses SET state = 'landed' WHERE id = 'p1'").run();
    expect(pressLanding(db, "rv2", since)).toEqual({ state: "landing" }); // landed but no commit yet: still saving
    db.prepare("UPDATE presses SET sha = '8ed652c5a1234' WHERE id = 'p1'").run();
    expect(pressLanding(db, "rv2", since)).toEqual({ state: "landed", sha: "8ed652c5a" });
    db.prepare("INSERT INTO presses (id, at, target, route, action, state, reason) VALUES ('p2', '2026-11-18T03:39:00Z', 'w1', '/waiting-on-owner/w1/respond', 'approve', 'failed', 'row left review')").run();
    expect(pressLanding(db, "w1", since)).toEqual({ state: "failed", reason: "row left review" });
  });
});

describe("the voice never talks over him", () => {
  it("turn detection waits for his whole thought (semantic, low eagerness)", () => {
    expect(sessionConfig("m").session.audio.input.turn_detection).toMatchObject({ type: "semantic_vad", eagerness: "low", interrupt_response: true });
  });
  it("the instructions give him priority and send 'don't interrupt me' to listen mode", () => {
    const i = voiceInstructions();
    expect(i).toContain("Don't speak over me, ever");
    expect(i).toContain("'don't interrupt me'");
  });
});
