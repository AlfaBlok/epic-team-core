import { describe, expect, it } from "vitest";
import { askTopicCard, codesIn, foldableAsk, foldSameTopic, inboxFolds, reviewTopicCard, sameTopic, topicPage, topicWords, type TopicCard } from "../src/inbox/sameTopic.js";

// E948-S183: the owner's 23 Nov screenshot: a plan ask and the review card of the same work both in Urgent.
const kernelAsk = askTopicCard({
  id: "wi_a16",
  code: "E907-A16",
  unblocks: "E907-S221",
  about: "the kernel plan",
  question: "You approve the kernel plan, or say what to change?",
  contextText: "The full picture tab by tab is the kernel page: http://pages.example.com:18997/",
  detail: "http://pages.example.com:9699/",
  since: "2026-11-22T23:40:00Z",
});
const kernelCard = reviewTopicCard({
  id: "rv_s221",
  ref: "E907-S221",
  title: "One diagram of the whole app kernel",
  links: [{ url: "http://pages.example.com:18997/#kernel" }],
  face: { about: "the whole kernel", delivered: [{ text: "✓ Real runs show which tabs each persona reads and writes." }] },
  verifiedAt: "2026-11-22T23:35:00Z",
});

const card = (over: Partial<TopicCard> & { id: string }): TopicCard => ({ kind: "review", tickets: [], pages: [], ...over });

describe("same topic (E948-S183)", () => {
  it("the kernel plan ask folds into the whole-kernel review card: one card", () => {
    expect(sameTopic(kernelAsk, kernelCard)).toBe("same ticket E907-S221");
    const f = foldSameTopic([kernelAsk, kernelCard]);
    expect(f.size).toBe(1);
    expect(f.get("wi_a16")).toEqual({ into: "rv_s221", intoRef: "E907-S221", reason: "same ticket E907-S221" });
  });

  it("the same page folds them even with no ticket named (not the same words)", () => {
    const ask = { ...kernelAsk, tickets: ["E907-A16"] };
    expect(sameTopic(ask, kernelCard)).toBe("same page pages.example.com:18997");
  });

  it("different words on the same topic fold; one shared word alone does not", () => {
    const a = card({ id: "a", kind: "ask", about: "Bitwarden migration of your team keys" });
    const b = card({ id: "b", about: "the team keys moved to Bitwarden" });
    expect(sameTopic(a, b)).toMatch(/^same topic: /);
    const c = card({ id: "c", about: "your inbox count" });
    const d = card({ id: "d", about: "the inbox colours" });
    expect(sameTopic(c, d)).toBeUndefined();
    const e = card({ id: "e", about: "Acme testers invite" });
    const g = card({ id: "g", about: "Acme testers feedback" });
    expect(sameTopic(e, g)).toBeUndefined();
  });

  it("the console's own screens and GitHub are no topic: two cards linking the chat stay apart", () => {
    const a = card({ id: "a", kind: "ask", pages: ["https://console.example.com/chat"], about: "where each message went" });
    const b = card({ id: "b", pages: ["https://console.example.com/chat?focus=x"], about: "the house search" });
    expect(sameTopic(a, b)).toBeUndefined();
    expect(topicPage("https://github.com/acme/team/blob/main/x.md")).toBeUndefined();
    expect(topicPage("http://pages.example.com:9699/index.html#how")).toBe("pages.example.com:9699");
    expect(topicPage("https://shop.example.com/")).toBeUndefined();
  });

  it("a chain is one card: A and B one ticket, B and C one page", () => {
    const a = card({ id: "a", kind: "ask", ref: "E901-A1", tickets: ["E901-A1", "E901-S2"], since: "2026-11-20" });
    const b = card({ id: "b", ref: "E901-S2", tickets: ["E901-S2"], pages: ["http://h:9001/"], since: "2026-11-21" });
    const c = card({ id: "c", ref: "E901-S3", tickets: ["E901-S3"], pages: ["http://h:9001/#x"], since: "2026-11-22" });
    const f = foldSameTopic([c, a, b]);
    // E948-S187: the ask came first, so its card stays and both review cards join it
    expect([...f.keys()].sort()).toEqual(["b", "c"]);
    expect(f.get("b")?.into).toBe("a");
    expect(f.get("c")?.into).toBe("a");
  });

  it("E948-S187: a review card arriving after an older ask on its ticket joins the ask's card; a newer ask still folds into the card", () => {
    const olderAsk = { ...kernelAsk, since: "2026-11-22T20:00:00Z" };
    expect(foldSameTopic([kernelCard, olderAsk]).get("rv_s221")).toEqual({ into: "wi_a16", intoRef: "E907-A16", reason: "same ticket E907-S221" });
    expect(foldSameTopic([kernelCard, olderAsk]).has("wi_a16")).toBe(false);
    // the kernel ask (23:40) is newer than its card (23:35): the card stays, as before
    expect(foldSameTopic([kernelAsk, kernelCard]).get("wi_a16")?.into).toBe("rv_s221");
    // a tie or no time: the review card stays
    expect(foldSameTopic([{ ...kernelAsk, since: "2026-11-22T23:35:00Z" }, kernelCard]).get("wi_a16")?.into).toBe("rv_s221");
    expect(foldSameTopic([{ ...kernelAsk, since: undefined }, kernelCard]).get("wi_a16")?.into).toBe("rv_s221");
  });

  it("two asks on one ticket keep the one shown first", () => {
    const old = card({ id: "old", kind: "ask", ref: "E902-A1", tickets: ["E902-A1", "E902-S5"], since: "2026-11-20T10:00Z" });
    const fresh = card({ id: "new", kind: "ask", ref: "E902-A2", tickets: ["E902-A2", "E902-S5"], since: "2026-11-22T10:00Z" });
    expect(foldSameTopic([fresh, old]).get("new")?.into).toBe("old");
  });

  it("an ask's row is the same ticket as that row's review card, never a reason to fold two asks of one row", () => {
    const onRow = askTopicCard({ id: "x", code: "E907-A1", row: "row E907-S9", about: "the logo colour" });
    const other = askTopicCard({ id: "y", code: "E907-A2", row: "row E907-S9", about: "the launch day" });
    expect(sameTopic(onRow, other)).toBeUndefined();
    expect(sameTopic(onRow, reviewTopicCard({ id: "rv", ref: "E907-S9" }))).toBe("same ticket E907-S9");
  });

  it("only decisions fold: a key box, steps or a Mac job always shows", () => {
    expect(foldableAsk({ ask: "approve" })).toBe(true);
    expect(foldableAsk({ ask: "decide" })).toBe(true);
    expect(foldableAsk({ ask: "provide" })).toBe(false);
    expect(foldableAsk({ ask: "do" })).toBe(false);
    expect(foldableAsk({ ask: "decide", secret: { app: "x", name: "Y" } })).toBe(false);
    expect(foldableAsk({ ask: "approve", putFirst: { objective: "team-browser" } })).toBe(false);
  });

  it("unrelated cards all stay", () => {
    const f = foldSameTopic([
      card({ id: "a", ref: "E901-S1", tickets: ["E901-S1"], about: "your reply to the landlord" }),
      card({ id: "b", ref: "E902-S1", tickets: ["E902-S1"], about: "the house search in Tenerife" }),
      card({ id: "c", kind: "ask", ref: "E903-A1", tickets: ["E903-A1"], about: "the WhatsApp number" }),
    ]);
    expect(f.size).toBe(0);
  });

  it("reads codes and words plainly", () => {
    expect(codesIn("unblocks: E907-S221, E907-S21 and EPIC-907")).toEqual(["E907-S221", "E907-S21"]);
    expect([...topicWords("The Kernel plans for every page")]).toEqual(["kernel"]);
  });
});

describe("inboxFolds (E948-S186: one selection for the web inbox and the census)", () => {
  const ask = { id: "wj_a16", ask: "approve", code: "E907-A2", row: "E907-S3", state: "open", about: "the kernel plan" };
  const card = { id: "rv_221", ref: "E907-S3", state: "review", face: { about: "the whole kernel" } };
  it("folds an open decision ask into the review card of its row", () => {
    expect(inboxFolds([ask], [card]).get("wj_a16")).toMatchObject({ into: "rv_221", reason: "same ticket E907-S3" });
  });
  it("leaves snoozed cards, hands asks and closed cards out", () => {
    expect(inboxFolds([{ ...ask, snoozedUntil: "2026-12-01" }], [card]).size).toBe(0);
    expect(inboxFolds([{ ...ask, ask: "do", secret: { app: "x" } }], [card]).size).toBe(0);
    expect(inboxFolds([{ ...ask, state: "done" }], [card]).size).toBe(0);
    expect(inboxFolds([ask], [{ ...card, state: "snoozed" }]).size).toBe(0);
  });
});
