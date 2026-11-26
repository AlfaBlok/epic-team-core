import { describe, expect, it } from "vitest";
import { isDoorSafe, isTenantSafe } from "../src/auth/routeScope.js";
import { asksOf, levelKnows, objectiveCallInstructions, objectiveNoteText, partnerRule, spineState } from "../src/voice/levelCall.js";

/** a Call at each level (product desk, objective, campaign), each briefed with that level's context. */

const card = {
  id: "social-launch",
  name: "SocialApp: Launch SocialApp",
  light: "red",
  krs: "0 of 2 key results green",
  stands: "not moved today",
  words: "Get 5 testers posting by Friday",
  said: "2026-11-26T10:00Z",
  keyResults: [
    { label: "5 testers post every week", state: "red", value: "1", target: "5", tickets: ["E907-S3"] },
    { label: "Posts a day on target", state: "green", value: "12", target: "12" },
  ],
} as any;

const SPINE = `# EPIC-907: Acme testers
## Current State
Owner: Delivery manager
Status: active
Next action: post the tester call on Reddit
Waiting on: his answer on the tester post
## Waiting on
- [ask the tester post: approve @Owner since 2026-11-25] You approve: the [tester post](https://x.example) goes out today — context: …
## Operating Learnings
`;

describe("what each level's call knows", () => {
  it("an objective: every key result with today's number and target, his newest words, where we are, the plan and its asks", () => {
    const asks = asksOf([card], [
      { kind: "ask", id: "a1", title: "Approve the tester post", question: "unblocks: E907-S3", recommend: "Yes, today" },
      { kind: "review", id: "r1", code: "other", title: "Some other card" },
    ] as any);
    expect(asks).toEqual(["Question: Approve the tester post; the team recommends: Yes, today"]);
    const k = levelKnows({ level: "objective", name: card.name, objectives: [{ card, where: "One tester posts; Reddit is the channel." }], asks, plan: "## The plan: SocialApp: Launch SocialApp\nPost daily." });
    expect(k).toContain('the objective "SocialApp: Launch SocialApp"');
    expect(k).toContain("5 testers post every week (red): now 1, target 5; being worked: 1 open ticket");
    expect(k).toContain("Posts a day on target (green): now 12, target 12; nothing open moves it");
    expect(k).toContain('His newest words in force (2026-11-26): "Get 5 testers posting by Friday"');
    expect(k).toContain("Where we are (its Context chapter): One tester posts");
    expect(k).toContain("Post daily.");
    expect(k).toContain("Approve the tester post");
  });

  it("a campaign: its spine's state and open asks, links read as words", () => {
    const s = spineState(SPINE);
    expect(s.state).toEqual(["Status: active", "Next action: post the tester call on Reddit", "Waiting on: his answer on the tester post"]);
    expect(s.asks).toEqual(["You approve: the tester post goes out today — context: …"]);
    const k = levelKnows({ level: "campaign", name: "Acme testers", objectives: [], asks: s.asks, state: s.state });
    expect(k).toContain("## Where it stands now (its spine)");
    expect(k).toContain("No objective could be read");
    expect(spineState(undefined)).toEqual({ state: [], asks: [] });
  });

  it("nothing waiting says so, never an empty list", () => {
    expect(levelKnows({ level: "desk", name: "SocialApp desk", objectives: [{ card }], asks: [] })).toContain("None waits on him at this level right now.");
  });
});

describe("how each level's call talks", () => {
  it("the desk's senior partner and each level's briefer think in key results and never invent one", () => {
    expect(partnerRule("desk", "SocialApp")).toMatch(/senior partner and OKR expert for the SocialApp desk/);
    expect(partnerRule("campaign", "Acme testers")).toMatch(/this campaign, "Acme testers"/);
    const i = objectiveCallInstructions(card.name);
    expect(i).toMatch(/briefer for one objective, "SocialApp: Launch SocialApp"/);
    expect(i).toMatch(/Never invent a number or a key result/);
    expect(i).toMatch(/relay_to_desk/);
    expect(i).toMatch(/hang_up/);
  });

  it("a note from an objective call reaches the desk with his words first and the objective named", () => {
    const t = objectiveNoteText("call_1", card.name, { words: "Add a waitlist", note: "" });
    expect(t).toMatch(/^📞 From the SocialApp: Launch SocialApp call \(call_1\)/);
    expect(t).toContain('"Add a waitlist"');
  });
});

describe("an objective's Call reaches his own workspace on a customer site, like the briefer", () => {
  it("every call route of /api/objectives/:id/voice is on both door lists", () => {
    for (const [m, p] of [
      ["GET", "/api/objectives/social-launch/voice/state"],
      ["POST", "/api/objectives/social-launch/voice/calls"],
      ["POST", "/api/objectives/social-launch/voice/calls/vc_1/relay"],
      ["POST", "/api/objectives/social-launch/voice/calls/vc_1/end"],
      ["GET", "/api/objectives/social-launch/voice/calls/vc_1/status"],
    ])
      expect(isTenantSafe(m, p) && isDoorSafe(m, p), `${m} ${p}`).toBe(true);
    expect(isTenantSafe("GET", "/api/objectives/social-launch/voice/secret")).toBe(false);
  });

  it("answers the home world's owner; another world gets no call and no link to his console", async () => {
    const { Hono } = await import("hono");
    const { mountObjectiveVoice } = await import("../src/voice/routes.js");
    const { homeWorld } = await import("../src/identity.js");
    let world = homeWorld();
    const api = new Hono();
    const voice = { state: () => ({ available: true, enabled: true }) } as any;
    mountObjectiveVoice(api, (id) => (id === "social-launch" ? voice : undefined), { world: () => world });
    expect(await (await api.request("/objectives/social-launch/voice/state")).json()).toMatchObject({ available: true });
    expect((await api.request("/objectives/nope/voice/state")).status).toBe(404);
    world = "someone-else";
    const other = (await (await api.request("/objectives/social-launch/voice/state")).json()) as any;
    expect(other.available).toBe(false);
    expect(other.elsewhere).toBeUndefined();
    expect((await api.request("/objectives/social-launch/voice/calls", { method: "POST" })).status).toBe(404);
  });
});
