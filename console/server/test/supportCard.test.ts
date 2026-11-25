import { describe, expect, it } from "vitest";
import { addCard, checkPost, emptyDoc, listCards } from "../src/inbox/teamCards.js";

// a help desk's one support card a day: the inbound mails sorted by product, drafted or needing the owner.
const support = (items: unknown[]) => ({ kind: "support", by: "Help desk", title: "Support on 2026-11-13: 3 mails, 1 needs you", scorecard: "sample-memo", support: { items } });
const three = [
  { product: "Memo", subject: "Voice notes do not show up", state: "drafted" },
  { product: "SocialApp", subject: "Plan next week's posts", state: "drafted" },
  { product: "TeamApp", subject: "Charged twice", state: "needs you", note: "Why you: money back", test: true },
];

describe("the support card", () => {
  it("counts each product, the drafts and what needs him from the items themselves", () => {
    const r = checkPost(support(three));
    expect(r).toMatchObject({ ok: true, card: { kind: "support", support: { drafted: 2, needsYou: 1, products: [{ product: "Memo", mails: 1 }, { product: "SocialApp", mails: 1 }, { product: "TeamApp", mails: 1 }] } } });
  });
  it("refuses a day with no mail, a mail with no product or an unknown state", () => {
    expect(checkPost(support([]))).toMatchObject({ ok: false, code: "no_support" });
    expect(checkPost(support([{ product: "", subject: "x", state: "drafted" }]))).toMatchObject({ ok: false, code: "no_support" });
    expect(checkPost(support([{ product: "Memo", subject: "x", state: "sent" }]))).toMatchObject({ ok: false, code: "no_support" });
  });
  it("allows one support card a day and lists it first among the team's cards", () => {
    const at = "2026-11-13T18:00:00Z";
    const c = checkPost(support(three));
    if (!c.ok) throw new Error(c.message);
    const one = addCard(emptyDoc(), c.card, at);
    if ("error" in one) throw new Error(one.error.message);
    expect(addCard(one.doc, c.card, "2026-11-13T19:00:00Z")).toMatchObject({ error: { code: "limit_support" } });
    expect(listCards(one.doc, { now: at })).toMatchObject({ open: [{ kind: "support" }], counts: { support: 1 } });
  });
});
