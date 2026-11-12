import { describe, expect, it } from "vitest";
import { ideaParts, splitBullets, textParts } from "./readable";

// the detail views split a post
// and an idea into labelled parts. The texts are the real P-0006 (the campaign repo) and I-18 (a social world repo).

const P0006 = "[1/5] How do you keep Reddit and X alive every day without living on them? \u00b7 I couldn't, so I built a small agent team for the daily part. Nothing goes out until I say yes. \u00b7 This is my real board, today. I'm picking a few testers \ud83d\udc47 \u00b7 [2/5] The team is five personas, each with one job: \u2022 Scout finds topics \u2022 Writer drafts each post and its diagram \u2022 Publisher posts what I approved \u2022 Responder answers replies \u2022 Reporter reads the numbers \u00b7 It wakes each one on a schedule. They pass work along in one repo. \u00b7 [3/5] My part is small. I give it ideas, often a voice note. Each campaign starts from a short brief I own. \u00b7 Then every draft waits for me: yes, no, or \"yes, but shorter\". \u00b7 [4/5] What I'd ask of you, for about 4 weeks in November: \u2022 a few ideas a week \u2022 approve or comment on drafts within a day \u2022 a few lines of feedback a week, or a 15-min call \u2022 log into your X/Reddit once in a private browser only your team uses \u00b7 [5/5] It costs $10, paid once, for your month. It's not a subscription. \u00b7 The fee is only there to keep out abuse. Each tester's team costs me about $50 in compute. You pay only if I pick you, when your team is ready. \u00b7 Short application: https://epicspine.dev/testers/?src=x";
const I18 = "You told your assistant no, and next week it proposes the same thing again. The human stake is that your decisions do not stick, so you spend the week repeating yourself. State the purpose in one line before drafting: the reader should think \"the fix is not a smarter model, it is a written record of what I already said no to, and why\". Open on the person with an example anyone follows (you ruled out one library on Monday and it comes back on Friday), no blame on any model. Mechanism only as proof: our own rejected options are rows with the reason they were dropped, and this week one idea of ours went to a rejected pile with the lesson kept, shown as a screenshot of that pile (L-8, the ideas file is the real thing); Memo at most a plain clause in line 2 (L-7). Say what we have not solved: whether an agent reads the rejected row before it proposes. End on a question: how do you make a no stick across sessions? Live thread: r/ClaudeCode 1xodr56, score 1,188 and 460 comments, where the complaint is \"it keeps circling back to the same thing we decided as rejected\"; it closes today, so the post is written fresh for its community and does not reply into it. r/ClaudeCode has P-0066 on 11-10 and P-0067 on 11-17, so another community: r/ChatGPTCoding has P-0104 on 11-08, r/AI_Agents has P-0103 on 11-09, which leaves r/ContextEngineering or r/mcp from 11-12 (one per community a week). No price, no security claim, no competitor named (T-1106-2, messages 3 and 6, L-1, L-2, L-7, L-8)";

describe("T46-S13 r3 readable parts", () => {
  it("an X thread is one part per post: hook, body, call to action; its bullets are list items", () => {
    const parts = textParts(P0006);
    expect(parts.map((p) => [p.label, p.n])).toEqual([
      ["Hook", "1/5"],
      ["Body", "2/5"],
      ["Body", "3/5"],
      ["Body", "4/5"],
      ["Call to action", "5/5"],
    ]);
    expect(parts[0].paras.map((p) => p.lead)).toEqual(["How do you keep Reddit and X alive every day without living on them?", "I couldn't, so I built a small agent team for the daily part. Nothing goes out until I say yes.", "This is my real board, today. I'm picking a few testers 👇"]);
    expect(parts[1].paras[0]).toEqual({ lead: "The team is five personas, each with one job:", items: ["Scout finds topics", "Writer drafts each post and its diagram", "Publisher posts what I approved", "Responder answers replies", "Reporter reads the numbers"] });
    expect(parts[4].paras.at(-1)!.lead).toBe("Short application: https://epicspine.dev/testers/?src=x");
  });

  it("a Reddit text under its title: body, then the last paragraph as the call to action when it asks", () => {
    expect(textParts("I build Memo. · Our rule is that nothing gets deleted. · What do you do?", { titleIsHook: true }).map((p) => [p.label, p.paras.length])).toEqual([
      ["Body", 2],
      ["Call to action", 1],
    ]);
    expect(textParts("One. · Two. · Three.").map((p) => p.label)).toEqual(["Hook", "Body", "Ending"]);
    expect(textParts("Only one paragraph.").map((p) => p.label)).toEqual(["Text"]);
  });

  it("one bullet stays in its sentence", () => {
    expect(splitBullets("a • b")).toEqual({ lead: "a • b", items: [] });
  });

  it("I-18: what, why, audience, how to write it and source, each its own part", () => {
    const p = ideaParts(I18, { platform: "Reddit", format: "text" });
    expect(p.what).toEqual(["You told your assistant no, and next week it proposes the same thing again."]);
    expect(p.why).toEqual(["The human stake is that your decisions do not stick, so you spend the week repeating yourself."]);
    expect(p.audience[0]).toBe("Reddit, text");
    expect(p.audience.some((a) => a.startsWith("r/ClaudeCode has P-0066"))).toBe(true);
    expect(p.how[0]).toMatch(/^State the purpose in one line/);
    expect(p.how.at(-1)).toBe("No price, no security claim, no competitor named");
    expect(p.how.length).toBeGreaterThanOrEqual(5);
    expect(p.source[0]).toMatch(/^Live thread: r\/ClaudeCode 1xodr56/);
    expect(p.source.at(-1)).toBe("Topics and messages: T-1106-2, messages 3 and 6, L-1, L-2, L-7, L-8");
  });

  it("an idea in the old shape: the bracket note says who it is for, the communities are named", () => {
    const p = ideaParts('Reddit discussion (r/ContextEngineering, for M1; ask first, disclose, no link): "We never delete a memory." A real case from our repos plus an honest question (T-1101-5, message 3).', { platform: "Reddit", format: "text" });
    expect(p.audience).toEqual(["Reddit, text", "Reddit discussion: r/ContextEngineering, for M1; ask first, disclose, no link"]);
    expect(p.what).toEqual(['"We never delete a memory."', "A real case from our repos plus an honest question"]);
    expect(p.source).toEqual(["Topics and messages: T-1101-5, message 3"]);
  });
});
