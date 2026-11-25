import { describe, expect, it, vi } from "vitest";
import { NoteTab, outText, OUT_CARD_TEXT, OUT_DESK_TEXT, type HeldNote } from "./NoteProvider";
import type { SentNote } from "./noteEngine";

/**
 * A card once refused the owner's long voice note and the card and Chat said Not sent, while his
 * words had already reached his memory. Now a refused card note goes to the Team desk whole (once, keyed on the note), and
 * no line ever says Not sent over words that already reached their owner.
 */
const note: SentNote = { id: "vn_test9000", state: "transcribed", seconds: 451, costUsd: 0.02, segments: 9, transcript: `${"words ".repeat(1500)}THE-END`, audio: "https://team.example/api/voice/notes/vn_test9000/audio" };

function held(deliver: () => Promise<unknown>): HeldNote {
  const engine = { view: () => ({ phase: "idle" }), dismiss: () => undefined } as unknown as HeldNote["engine"];
  return { key: "card:rv_1", base: "/api/voice", engine, to: "a card", docks: 1, deliver, words: (n) => `${n.transcript} (voice note ${n.id})`, page: "card E907-S3: a card" };
}

describe("a refused card voice note is never lost or called Not sent", () => {
  it("the card refuses it: the whole words go to the Team desk once, keyed on the note, and the line says so", async () => {
    const toDesk = vi.fn().mockResolvedValue({});
    const tab = new NoteTab(undefined, toDesk);
    const h = held(() => Promise.reject(new Error("feedback is required (at most 4000 characters)")));
    await tab.send(h, note);
    expect(toDesk).toHaveBeenCalledTimes(1);
    const [text, page, id] = toDesk.mock.calls[0];
    expect(text).toContain("THE-END");
    expect(text).toContain("vn_test9000");
    expect(text).toContain("the card did not take it: feedback is required");
    expect(page).toBe("card E907-S3: a card");
    expect(id).toBe("card-note:vn_test9000");
    expect(h.out?.state).toBe("desk");
    expect(outText(h.out!, "a card")).toBe(OUT_DESK_TEXT);
    expect(outText(h.out!, "a card")).not.toMatch(/not sent/i);
  });

  it("the card takes it: the desk is not used", async () => {
    const toDesk = vi.fn();
    const tab = new NoteTab(undefined, toDesk);
    const h = held(() => Promise.resolve({}));
    await tab.send(h, note);
    expect(toDesk).not.toHaveBeenCalled();
    expect(h.out?.state).toBe("done");
  });

  it("card and desk both refuse: it stays with Send again and says his words are in his memory, never Not sent", async () => {
    const tab = new NoteTab(undefined, () => Promise.reject(new Error("desk down")));
    const h = held(() => Promise.reject(new Error("the console is restarting")));
    await tab.send(h, note);
    expect(h.out).toMatchObject({ state: "failed", note });
    const line = outText(h.out!, "a card");
    expect(line).toMatch(/in your memory/);
    expect(line).toContain("the console is restarting");
    expect(line).not.toMatch(/not sent/i);
  });
});

/**
 * card notes were once answered "the card did not take it" and his words reached the desk only as a side copy. Now a note the
 * card's press refuses lands on the card's own row as his note on that card; the desk is only the last resort.
 */
describe("a card never refuses his note", () => {
  const card = { kind: "review" as const, repo: "home_repo", path: "docs/spines/m48.md", ref: "E907-S3", title: "A check showed the self-assessment ran" };
  it("the card's press refuses it: the whole note goes onto the card's row, never to the desk", async () => {
    const toDesk = vi.fn();
    const toCard = vi.fn().mockResolvedValue({});
    const tab = new NoteTab(undefined, toDesk, toCard);
    const h = { ...held(() => Promise.reject(new Error("no row in review with that id (the spine moved on)"))), card };
    await tab.send(h, note);
    expect(toCard).toHaveBeenCalledTimes(1);
    const [where, words, id] = toCard.mock.calls[0];
    expect(where).toEqual(card);
    expect(words).toContain("THE-END");
    expect(words).toContain("vn_test9000");
    expect(words).not.toMatch(/did not take/);
    expect(id).toBe("card-note:vn_test9000");
    expect(toDesk).not.toHaveBeenCalled();
    expect(h.out?.state).toBe("card");
    expect(outText(h.out!, "a card")).toBe(OUT_CARD_TEXT);
    expect(outText(h.out!, "a card")).not.toMatch(/did not take|not sent/i);
  });

  it("the card's row cannot be written either: the desk still gets the whole note", async () => {
    const toDesk = vi.fn().mockResolvedValue({});
    const tab = new NoteTab(undefined, toDesk, () => Promise.reject(new Error("spine write failed")));
    const h = { ...held(() => Promise.reject(new Error("the card refused it"))), card };
    await tab.send(h, note);
    expect(toDesk).toHaveBeenCalledTimes(1);
    expect(h.out?.state).toBe("desk");
  });

  it("a card with no known row goes to the desk as before", async () => {
    const toDesk = vi.fn().mockResolvedValue({});
    const toCard = vi.fn();
    const tab = new NoteTab(undefined, toDesk, toCard);
    await tab.send(held(() => Promise.reject(new Error("refused"))), note);
    expect(toCard).not.toHaveBeenCalled();
    expect(toDesk).toHaveBeenCalledTimes(1);
  });
});
