import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { DeskView } from "../src/desk/session.js";
import { objectiveCards } from "../src/objectives.js";
import { askButtons, briefingRule, cardText, inboxPack, objectiveStep, objectiveText, pressStep, reviewButtons, type InboxCard, type ObjectiveCard } from "../src/voice/inbox.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// the voice presses his button on his spoken yes on every card the whole-inbox call walks (reviews, asks, goals),
// read back once, through the card's own route (the page presses). his objectives one by one on the same call,
// his words filed on each through the briefing's own route.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const cards: InboxCard[] = [
  { kind: "review", id: "rv1", code: "E907-S3", title: "A Notes logo was made.", buttons: reviewButtons({}) },
  { kind: "review", id: "rv2", code: "E907-S4", title: "Pick a plan.", decision: "Do we plan the shop? We recommend yes.", buttons: reviewButtons({ decision: "Do we plan the shop? We recommend yes." }) },
  { kind: "ask", id: "w1", code: "E907-A1", title: "Can we spend 5 dollars?", milestoneId: "ms_1", buttons: askButtons("approve") },
  { kind: "ask", id: "w2", title: "A check stopped.", milestoneId: "ms_1", buttons: [] },
  { kind: "goal", id: "tc_1", title: "Set the testers goal.", buttons: ["10 testers", "Answer in words…"] },
];

const objectives: ObjectiveCard[] = [
  { id: "notes-testers", name: "Notes: 5 testers", light: "red", krs: "1 of 2 key results green", keyResults: [{ label: "Testers signed up", state: "red", value: "2", target: "5" }, { label: "Site up", state: "green", value: "yes" }], stands: "not moved today: moving: worker on E907-S9", words: "Get the second tester this week.", said: "2026-11-17T21:34Z" },
  { id: "notes-servers", name: "Notes: servers run themselves", light: "amber", krs: "0 of 0 key results green", keyResults: [], stands: "not moved today" },
];

function setup(o: { objectives?: ObjectiveCard[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s129-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const minted: any[] = [];
  const mint = vi.fn(async (b: unknown) => (minted.push(b), { value: "ek", expires_at: 0, session: { id: "sess" } }));
  const desk: DeskPort = {
    send: vi.fn(async () => ({ threadId: "th", pending: true })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as unknown as DeskView,
  };
  const voice = createVoice({
    db,
    mint,
    desk,
    quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }),
    inbox: async () => cards,
    objectives: async () => "1. Notes: 5 testers\n2. Notes: servers run themselves",
    ...(o.objectives ? { objectiveCards: async () => o.objectives! } : {}),
  });
  return { voice, minted };
}

describe("the voice presses his button on every card the whole-inbox call walks", () => {
  it("each card carries the buttons its page card shows", () => {
    expect(reviewButtons({})).toEqual(["Mark complete", "Changes wanted…"]);
    expect(reviewButtons({ decision: "Do we plan the shop?" })).toEqual(["Yes: plan it", "No: park it", "Changes wanted…"]);
    expect(reviewButtons({ options: ["Keep: keep it", "Drop: drop it", "Change it: say how"] })).toEqual(["Keep: keep it", "Drop: drop it", "Change it: say how", "Changes wanted…"]);
    expect(askButtons("approve")).toEqual(["Yes: go ahead", "No: drop it", "Answer in words…"]);
    expect(askButtons("decide")).toEqual(["Answer in words…"]);
  });

  it("the rule says it presses on his yes, says 'pressed, it landed', and never reads the buttons aloud", () => {
    const pack = inboxPack(cards);
    expect(pack).toContain("press_card");
    expect(pack).toContain("pressed, it landed");
    expect(pack).toContain("never read the list of buttons aloud");
    expect(pack).not.toMatch(/does not press|desk presses/);
    expect(pack).toContain("1 goals to set");
    expect(cardText(cards[0])).toContain("he sees them, never read them out");
  });

  it("press_card hands the page a review's, an ask's (with its milestone) and a goal's press only on his yes and his own button", () => {
    expect(pressStep(cards, 1, { button: "Mark complete", confirmed: false }).press).toBeUndefined();
    expect(pressStep(cards, 1, { button: "Mark complete", confirmed: true }).press).toMatchObject({ id: "rv1", kind: "review", button: "Mark complete" });
    expect(pressStep(cards, 2, { button: "yes: plan it", confirmed: true }).press).toMatchObject({ id: "rv2", button: "Yes: plan it" });
    expect(pressStep(cards, 3, { button: "Yes: go ahead", confirmed: true }).press).toMatchObject({ id: "w1", kind: "ask", button: "Yes: go ahead", milestoneId: "ms_1" });
    expect(pressStep(cards, 4, { button: "Answer in words…", words: "fine", confirmed: true }).note).toMatch(/no button you may press/);
    expect(pressStep(cards, 5, { button: "Answer in words", confirmed: true }).note).toMatch(/needs his words/);
    expect(pressStep(cards, 5, { button: "10 testers", confirmed: true }).press).toMatchObject({ id: "tc_1", kind: "goal" });
  });

  it("on a live whole-inbox call the console checks the press and shows the card's title", async () => {
    const { voice, minted } = setup();
    const s = await voice.start();
    expect(minted[0].session.tools.map((t: { name: string }) => t.name)).toContain("press_card");
    expect(voice.tool(s.call.id, "next_card")).toMatchObject({ place: "card 1 of 5", title: "A Notes logo was made." });
    expect(voice.tool(s.call.id, "press_card", { button: "Mark complete", confirmed: true }).press).toMatchObject({ id: "rv1", button: "Mark complete" });
  });
});

describe("his objectives one by one on the same call", () => {
  it("an objective reads its light, key results, where it stands and his newest words", () => {
    const t = objectiveText(objectives[0], 1, 2);
    expect(t).toContain("Objective 1 of 2 in Sam's order: Notes: 5 testers. Light: red. 1 of 2 key results green.");
    expect(t).toContain("- Testers signed up (red): now 2, target 5");
    expect(t).toContain("Where it stands: not moved today: moving: worker on E907-S9");
    expect(t).toContain('His newest words on it (2026-11-17): "Get the second tester this week."');
    expect(objectiveText(objectives[1], 2, 2)).toContain("It has no key results yet.");
  });

  it("next, read, back and the end; filing only on his yes and with his words", () => {
    expect(objectiveStep(objectives, 0, "next_objective")).toMatchObject({ place: "objective 1 of 2", id: "notes-testers", pos: 1 });
    expect(objectiveStep(objectives, 1, "next_objective")).toMatchObject({ pos: 2, id: "notes-servers" });
    expect(objectiveStep(objectives, 2, "next_objective")).toMatchObject({ done: true, pos: 2 });
    expect(objectiveStep(objectives, 2, "read_objective", { number: -1 })).toMatchObject({ pos: 1 });
    expect(objectiveStep(objectives, 1, "read_objective", { number: 7 }).place).toBe("there is no objective 7");
    expect(objectiveStep(objectives, 1, "file_objective_words", { words: "push it", confirmed: false }).file).toBeUndefined();
    expect(objectiveStep(objectives, 1, "file_objective_words", { words: " ", confirmed: true }).file).toBeUndefined();
    expect(objectiveStep(objectives, 1, "file_objective_words", { words: "push  it", confirmed: true }).file).toEqual({ id: "notes-testers", name: "Notes: 5 testers", words: "push it" });
    expect(objectiveStep(objectives, 1, "file_objective_words", { words: "later", number: 2, confirmed: true }).file?.id).toBe("notes-servers");
    expect(objectiveStep([], 0, "next_objective")).toMatchObject({ done: true, total: 0 });
  });

  it("a call with his objectives gets the briefing rule and the three tools, and keeps which one he is on", async () => {
    const { voice, minted } = setup({ objectives });
    const s = await voice.start();
    const sess = minted[0].session;
    expect(sess.instructions).toContain(briefingRule(2).split("\n")[0]);
    expect(sess.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["next_objective", "read_objective", "file_objective_words", "press_card"]));
    const id = s.call.id;
    expect(voice.tool(id, "next_objective")).toMatchObject({ place: "objective 1 of 2" });
    expect(voice.tool(id, "next_objective")).toMatchObject({ place: "objective 2 of 2" });
    expect(voice.tool(id, "file_objective_words", { words: "no key results yet, set them", confirmed: true }).file).toMatchObject({ id: "notes-servers" });
    // the inbox walk keeps its own place
    expect(voice.tool(id, "next_card").place).toBe("card 1 of 5");
  });

  it("a call without his objectives has no objective tools", async () => {
    const { voice, minted } = setup();
    const s = await voice.start();
    expect(minted[0].session.tools.map((t: { name: string }) => t.name)).not.toContain("next_objective");
    expect(() => voice.tool(s.call.id, "next_objective")).toThrow(/without his objectives/);
  });

  it("the objective cards follow the one objectives list: his order, the screen's lights, his words whole", () => {
    const list = objectiveCards(
      {
        nodes: [
          { id: "b", kind: "pursuit", name: "Notes: servers", rank: 2, greens: 0, total: 0, idle: { idle: true, reason: "no key results yet" } },
          { id: "a", kind: "pursuit", name: "Notes: 5 testers", rank: 1, greens: 1, total: 2, state: "red", keyResults: [{ label: "Testers", state: "red", value: "2", target: "5" }, { label: "Site", state: "green", value: "up" }] },
          { id: "p", kind: "pursuit", name: "Parked", rank: 3, parked: true, greens: 0, total: 0 },
        ],
        progress: { sets: { a: { today: 1, week: 1 } } },
      },
      { objectives: [{ id: "a", name: "Notes: 5 testers", after: { words: "Get the second tester this week, and ask the first one what stopped them from paying.", said: "2026-11-17T21:34Z" } }] } as never,
    );
    expect(list.map((o) => o.id)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({ light: "red", krs: "1 of 2 key results green", stands: "moved today: 1 key result turned green", words: "Get the second tester this week, and ask the first one what stopped them from paying." });
    expect(list[0].keyResults[0]).toEqual({ label: "Testers", state: "red", value: "2", target: "5" });
    expect(list[1].stands).toBe("not moved today: no key results yet");
  });
});
