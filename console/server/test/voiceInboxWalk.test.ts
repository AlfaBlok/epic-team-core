import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { DeskView } from "../src/desk/session.js";
import { cardLine, cardText, INBOX_PACK_MAX, inboxPack, walk, type InboxCard } from "../src/voice/inbox.js";
import { createVoice, type DeskPort } from "../src/voice/voice.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// the Team desk's call starts with his inbox and objectives, and walks the cards with next_card and
// read_card, the console keeping which card he is on.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const cards: InboxCard[] = [
  {
    kind: "review",
    id: "rv1",
    code: "E907-S3",
    title: "A Notes logo and connect page were made for directories.",
    where: "Notes",
    source: 'Sam, 3 Nov, "put Notes in every directory"',
    goal: "Every directory can point to Notes.",
    delivered: ["✓ [notes.example.com/connect](https://notes.example.com/connect) is live.", "✗ No video: none was asked."],
    evidence: "Notes connect page",
    decision: "Do we list it on five directories? We recommend yes.",
    options: ["Yes: list it", "No: park it"],
  },
  { kind: "review", id: "rv2", code: "E907-S4", title: "The inbox loads twice as fast.", decision: "Is it fast enough for you? We think so." },
  { kind: "ask", id: "w1", code: "E907-A1", title: "Which domain for the shop?", question: "Which domain should the shop use: shop.example.com or example.shop?", where: "Shop" },
];

function setup(inbox: (() => Promise<InboxCard[]>) | null = async () => cards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s118-"));
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
  const voice = createVoice({ db, mint, desk, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), ...(inbox ? { inbox, objectives: async () => "1. Notes: 5 testers (4 of 8 key results green)\n2. Notes: servers run themselves" } : {}) });
  return { db, voice, minted, desk };
}

describe("the inbox on the call", () => {
  it("a card's line names what it asks; its full text reads the face in plain words, the code marked never to be said", () => {
    expect(cardLine(cards[0], 1)).toBe("1. Review [E907-S3]: A Notes logo and connect page were made for directories. | asks: Do we list it on five directories? We recommend yes.");
    expect(cardLine(cards[2], 3)).toContain("3. Question [E907-A1]: Which domain for the shop? | asks: Which domain should the shop use");
    const t = cardText(cards[0]);
    expect(t).toContain("never say the code");
    expect(t).toContain("Delivered: notes.example.com/connect is live.");
    expect(t).toContain("Not delivered: No video: none was asked.");
    expect(t).not.toContain("https://");
    expect(t).toContain("His buttons on it: Yes: list it · No: park it");
    expect(cardText(cards[1])).toContain("His buttons on it: Mark complete · Changes wanted");
  });

  it("the pack holds the rule, the count, at most INBOX_PACK_MAX lines and his objectives", () => {
    const many = Array.from({ length: INBOX_PACK_MAX + 5 }, (_, i) => ({ kind: "review" as const, id: `r${i}`, title: `Card ${i + 1}` }));
    const p = inboxPack(many, "1. Notes: 5 testers");
    expect(p).toContain(`His inbox now: ${INBOX_PACK_MAX + 5} cards (${INBOX_PACK_MAX + 5} to review, 0 questions).`);
    expect(p).toContain(`${INBOX_PACK_MAX}. Review: Card ${INBOX_PACK_MAX}`);
    expect(p).not.toContain(`${INBOX_PACK_MAX + 1}. Review`);
    expect(p).toContain("… and 5 more");
    expect(p).toContain("1. Notes: 5 testers");
    expect(p).toContain("This call does not press his buttons yet");
    expect(inboxPack([])).toContain("His inbox is empty right now.");
  });

  it("walk: next goes one by one and stops at the end; read reads the current, a number, or back one", () => {
    let s = walk(cards, 0, "next_card");
    expect([s.place, s.pos]).toEqual(["card 1 of 3", 1]);
    s = walk(cards, s.pos, "next_card");
    expect(s.place).toBe("card 2 of 3");
    expect(walk(cards, 2, "read_card").place).toBe("card 2 of 3");
    expect(walk(cards, 2, "read_card", { number: -1 }).pos).toBe(1);
    expect(walk(cards, 1, "read_card", { number: 3 }).card).toContain("Which domain should the shop use");
    expect(walk(cards, 1, "read_card", { number: 9 })).toMatchObject({ pos: 1, place: "there is no card 9" });
    expect(walk(cards, 3, "next_card")).toMatchObject({ done: true, pos: 3 });
    expect(walk(cards, 0, "read_card").pos).toBe(1);
    expect(walk([], 0, "next_card")).toMatchObject({ done: true, total: 0 });
  });

  it("a call starts with his inbox and objectives in its instructions, gets the two walk tools, and keeps his place", async () => {
    const { voice, minted, desk } = setup();
    const s = await voice.start();
    const sess = minted[0].session;
    expect(sess.instructions).toContain("His inbox now: 3 cards (2 to review, 1 questions).");
    expect(sess.instructions).toContain("2. Notes: servers run themselves");
    expect(sess.tools.map((t: { name: string }) => t.name)).toEqual(["quick_status", "ask_the_desk", "listen_for_feedback", "hang_up", "next_card", "read_card"]);
    const id = s.call.id;
    expect(voice.walkState(id)).toEqual({ pos: 0, total: 3 });
    expect(voice.tool(id, "next_card").place).toBe("card 1 of 3");
    expect(voice.tool(id, "next_card").place).toBe("card 2 of 3");
    expect(voice.walkState(id)).toEqual({ pos: 2, total: 3 });
    expect(voice.tool(id, "read_card", { number: -1 }).card).toContain("A Notes logo");
    expect(() => voice.tool(id, "press_button")).toThrow(/no console tool/);
    await voice.ask(id, "mark this one complete", true);
    expect(String((desk.send as any).mock.calls.at(-1)[0])).toContain('On his inbox walk he is on card 1 of 3: the review card E907-S3 "A Notes logo');
    await voice.end(id, { reason: "hangup" });
    expect(() => voice.tool(id, "next_card")).toThrow(/has ended/);
  });

  it("a call whose inbox cannot be read starts as before: no walk tools, no inbox", async () => {
    const { voice, minted } = setup(async () => {
      throw new Error("review list down");
    });
    const s = await voice.start();
    expect(minted[0].session.tools.map((t: { name: string }) => t.name)).not.toContain("next_card");
    expect(minted[0].session.instructions).not.toContain("His inbox now");
    expect(() => voice.tool(s.call.id, "next_card")).toThrow(/without his inbox/);
  });

  it("a voice with no inbox (a campaign or world desk call) is unchanged", async () => {
    const { voice, minted } = setup(null);
    await voice.start();
    expect(minted[0].session.tools.map((t: { name: string }) => t.name)).toEqual(["quick_status", "ask_the_desk", "listen_for_feedback", "hang_up"]);
  });
});
