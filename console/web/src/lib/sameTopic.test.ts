import { describe, expect, it } from "vitest";
import type { ReviewItem, WaitingItem } from "@/api";
import { answerJoined, foldAsks, foldReviews, joinedFor, joinedPress, rememberJoined } from "./sameTopic";

// E948-S183: the owner's 23 Nov screenshot: a plan ask and the review card of the same work both in Urgent.
const ask = (o: Partial<WaitingItem>): WaitingItem => ({ id: "wi_a16", source: "ask", state: "open", title: "", question: "", contextLinks: [], ...o }) as WaitingItem;
const review = (o: Partial<ReviewItem>): ReviewItem => ({ id: "rv_s221", title: "", liveUrl: "", state: "review", createdAt: "2026-11-22T23:35:00Z", ...o }) as ReviewItem;

describe("one card per topic in his inbox (E948-S183)", () => {
  it("the kernel plan ask shows as folded into the kernel review card: one card in Urgent", () => {
    const asks = [ask({ code: "E907-A16", ask: "approve", unblocks: "E907-S221", about: "the kernel plan", urgent: true }), ask({ id: "other", code: "E909-A1", ask: "decide", about: "your reply to the landlord" }), ask({ id: "key", code: "E907-A20", ask: "provide", unblocks: "E907-S221" })];
    const reviews = [review({ ref: "E907-S221", liveUrl: "http://pages.example.com:18997/#kernel" })];
    const out = foldAsks(asks, reviews)!;
    expect(out[0]).toMatchObject({ state: "superseded", supersededBy: "E907-S221", foldedInto: "rv_s221" });
    expect(out[1].state).toBe("open");
    expect(out.filter((i) => i.state === "open").map((i) => i.id)).toEqual(["other", "key"]);
  });
  it("a snoozed or answered ask is never folded; no review list leaves the asks as they are", () => {
    const asks = [ask({ code: "E907-A16", ask: "approve", unblocks: "E907-S221", state: "answered" })];
    expect(foldAsks(asks, [review({ ref: "E907-S221" })])).toBe(asks);
    expect(foldAsks(asks, undefined)).toBe(asks);
  });
  it("two review cards opening one page keep the one shown first", () => {
    const a = review({ id: "a", ref: "E901-S1", liveUrl: "http://pages.example.com:9001/", inboxSince: "2026-11-20T00:00:00Z" });
    const b = review({ id: "b", ref: "E901-S2", liveUrl: "http://pages.example.com:9001/#x", inboxSince: "2026-11-22T00:00:00Z" });
    expect(foldReviews([b, a])!.map((r) => r.id)).toEqual(["a"]);
  });
});

// E948-S187: his follow-up when he closed the one-card-per-topic card: fold a review card into an OLDER ask.
describe("a review card after an older ask joins the ask's card (E948-S187)", () => {
  const older = () =>
    ask({ code: "E907-A16", ask: "approve", unblocks: "E907-S221", about: "the kernel plan", since: "2026-11-22T20:00:00Z" });
  const card = () =>
    review({
      ref: "E907-S221",
      liveUrl: "http://pages.example.com:18997/",
      inboxSince: "2026-11-22T23:35:00Z",
      face: {
        title: "One diagram of the whole kernel was made.",
        evidence: { url: "http://pages.example.com:18997/#kernel", label: "The kernel page", look: "Every tab and who writes it." },
        delivered: [{ ok: true, text: "✓ Real runs show each tab." }],
        decision: "Does the kernel read right? We recommend yes.",
        options: ["Yes: keep it", "No: say what to change"],
      } as ReviewItem["face"],
    });
  it("the ask stays open and carries the review's evidence and decision; the review card leaves the list", () => {
    const out = foldAsks([older()], [card()])!;
    expect(out[0].state).toBe("open");
    expect(out[0].joined).toEqual([
      {
        id: "rv_s221",
        ref: "E907-S221",
        title: "One diagram of the whole kernel was made.",
        evidence: { url: "http://pages.example.com:18997/#kernel", label: "The kernel page", look: "Every tab and who writes it." },
        delivered: [{ ok: true, text: "✓ Real runs show each tab." }],
        decision: "Does the kernel read right? We recommend yes.",
        options: ["Yes: keep it", "No: say what to change"],
      },
    ]);
    expect(foldReviews([card()], [older()])).toEqual([]);
    // without the asks only review cards fold, as before
    expect(foldReviews([card()])!.length).toBe(1);
  });
  it("a newer ask still folds into the review card, as before", () => {
    const newer = ask({ code: "E907-A16", ask: "approve", unblocks: "E907-S221", since: "2026-11-23T01:00:00Z" });
    expect(foldAsks([newer], [card()])![0]).toMatchObject({ state: "superseded", foldedInto: "rv_s221" });
    expect(foldReviews([card()], [newer])!.length).toBe(1);
  });
  it("his answer on the ask is the same answer on the joined card", async () => {
    const calls: string[] = [];
    const api = {
      completeReviewItem: async (id: string, pick: { choice?: string }) => void calls.push(`complete ${id} ${pick.choice ?? ""}`.trim()),
      denyReviewItem: async (id: string, reason: string) => void calls.push(`deny ${id} ${reason}`),
      relaunchReviewItem: async (id: string, feedback: string) => void calls.push(`relaunch ${id} ${feedback}`),
    };
    rememberJoined(foldAsks([older()], [card()]));
    const j = joinedFor("wi_a16");
    expect(j.map((x) => x.ref)).toEqual(["E907-S221"]);
    expect(await answerJoined("wi_a16", j, "approve", "", api)).toEqual(["rv_s221"]);
    expect(joinedFor("wi_a16")).toEqual([]);
    await answerJoined("wi_a16", j, "feedback", "Draw the wake as a circle", api);
    await answerJoined("wi_a16", j, "deny", "", api);
    await answerJoined("wi_a16", j, "answer", "yes", api);
    expect(calls).toEqual(["complete rv_s221", "relaunch rv_s221 Draw the wake as a circle", "deny rv_s221 Declined on the ask it joined.", "complete rv_s221 Yes: keep it"]);
    // an ask with no joined card answers only itself; an answer he took back reaches no card
    expect(await answerJoined("other", [], "approve", "", api)).toEqual([]);
    expect(await answerJoined("wi_a16", j, "approve", "", api, async () => true)).toEqual([]);
    expect(calls).toHaveLength(4);
  });
  it("feedback with no words sends nothing to the card", () => {
    expect(joinedPress("feedback", " ", { id: "x" })).toBeUndefined();
  });
});
