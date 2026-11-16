import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountSpokenAnswers, readByOrder, readOnly, readSpokenAnswers, saidIn, type SpokenAsk } from "../src/inbox/spokenAnswers.js";

// E948-S127: his voice note on "The Delivery Manager's 3 recommendations" (16 Nov 20:29Z, vn_7f478843), word for word.
const NOTE_2029 =
  "I'm not clear, did we send an email to the tester yet or no? Because I approved this a long time ago and now it's confusing to me. So you see an extra paragraph to the thank you email? Oh, that's for new testers, yeah. So the first one, OK, the second one, no, I don't want to raise the limit. The third one, yes. But like I just said, and maybe this one to the right, did you apply without my consent to OVH? Didn't I just give this feedback? Don't apply without showing me the application in draft. You can send a screenshot of the filled-in form. You can send a text. I would prefer a screenshot of the form and I approve it and then you apply, but not before I see what you are suggesting, because you're not so good at writing.";

const SET: SpokenAsk[] = [
  { id: "a1", code: "E907-A26", line: "Add one paragraph to the thank-you email new testers get" },
  { id: "a2", code: "E988-A10", line: "Raise your test limit from 5 to 20 euros a month" },
  { id: "a3", code: "E995-A3", line: "Apply to the Nirvana Labs Founders programme" },
];

describe("his words on a card answer its asks (E948-S127)", () => {
  it("reads the exact 20:29Z note as yes, no, yes by order", async () => {
    const { reads } = await readSpokenAnswers(NOTE_2029, SET);
    expect(reads.map((r) => [r.id, r.kind, r.how])).toEqual([
      ["a1", "approve", "order"],
      ["a2", "deny", "order"],
      ["a3", "approve", "order"],
    ]);
    for (const r of reads) expect(saidIn(NOTE_2029, r.quote)).toBe(true);
    expect(reads[1].quote).toMatch(/second one, no, I don't want to raise the limit/);
  });

  it("reads answers by code, and yes to all", () => {
    expect(readByOrder("E988-A10 no. E907-A26 yes please.", SET).map((r) => r.kind)).toEqual(["approve", "deny", "none"]);
    expect(readByOrder("Yes to all, go ahead.", SET).map((r) => r.kind)).toEqual(["approve", "approve", "approve"]);
  });

  it("never guesses: a hedge or two answers for one ask is unclear, an ask he did not name is none", () => {
    expect(readByOrder("The first one, maybe later. The second one, yes.", SET).map((r) => r.kind)).toEqual(["unclear", "approve", "none"]);
    expect(readByOrder("The first one, yes. Actually the first one, no.", SET)[0].kind).toBe("unclear");
    expect(readByOrder("I am not sure about any of these.", SET).every((r) => r.kind === "none")).toBe(true);
  });

  it("one ask: only a plain yes or no is read without the model; a yes with a change stays feedback", async () => {
    expect(readOnly("Yes, go ahead.")).toBe("approve");
    expect(readOnly("No.")).toBe("deny");
    expect(readOnly("Yes, but change the title first")).toBeUndefined();
    const judge = async () => [{ id: "a1", kind: "approve", quote: "yes, but change the title first" }];
    const { reads } = await readSpokenAnswers("Yes, but change the title first.", [SET[0]], judge);
    expect(reads[0].kind).toBe("unclear");
  });

  it("the model fills only what the plain reader left open, and only with words he said", async () => {
    const judge = async () => [
      { id: "a1", kind: "deny", quote: "made up words" },
      { id: "a2", kind: "approve", quote: "the limit one is fine" },
      { id: "a3", kind: "approve", quote: "not in his note" },
    ];
    const { reads } = await readSpokenAnswers("The limit one is fine. The third one, no.", SET, judge);
    expect(reads.map((r) => [r.kind, r.how])).toEqual([
      ["none", undefined],
      ["approve", "model"],
      ["deny", "order"],
    ]);
  });

  it("a model that fails leaves the plain reads and says why", async () => {
    const r = await readSpokenAnswers("The second one, no.", SET, async () => {
      throw new Error("no key");
    });
    expect(r.reads[1].kind).toBe("deny");
    expect(r.judgeError).toBe("no key");
  });

  it("POST /spoken-answers reads and writes nothing", async () => {
    const api = new Hono();
    mountSpokenAnswers(api, {});
    const res = await api.request("/spoken-answers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ words: NOTE_2029, asks: SET }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { reads: { kind: string }[] };
    expect(j.reads.map((r) => r.kind)).toEqual(["approve", "deny", "approve"]);
    const bad = await api.request("/spoken-answers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ words: "" }) });
    expect(bad.status).toBe(400);
  });
});
