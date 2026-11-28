import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountTreeAdd, placeWords, type Held } from "../src/status/add.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";

/**
 * The owner's card answer of 18 Nov: "I need to know that the first time around is already gonna be
 * pretty good ... 80 to 90% there, and then we're gonna do the final twist once a day". The filing step runs the match
 * itself: his words on a point an open ticket already holds go onto that ticket (no new row, the ticket ready again on
 * his ask); a point that repeats a closed ticket is filed new and names it; only when the match cannot run does the
 * desk's own `matched: new: …` decide, as before.
 */
const SPINE = `# EPIC-909: Demo

## Current State

Status: active

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| E909-S1 | Ticket worker | worker | Objective opens in under 2 s on his phone | deferred (parked by Sam 18 Nov) | none | none | main | none | 2026-11-18 | wait |
| E909-S2 | Ticket worker | worker | Counters match the cards | done (approved by Sam 2026-11-22) | none | none | main | none | 2026-11-22 | none |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-20 | accepted | x | y | z | never |
`;

const SAID = "the objective page takes 10 seconds to open on my phone, fix it";

function mount(held: Held | undefined) {
  let text = SPINE;
  const commits: { path: string; msg: string; body: string }[] = [];
  const wakes: string[] = [];
  const asked: string[] = [];
  const spine = {
    edit: async (i: { path: string; edit: (t: string, d: string) => { text: string; msg: string; body: string } | { skip: string } }) => {
      const out = i.edit(text, "2026-11-23");
      if ("skip" in out) return { status: "skipped" as const, reason: out.skip };
      text = out.text;
      commits.push({ path: i.path, msg: out.msg, body: out.body });
      return { status: "written" as const, sha: "abc1234" };
    },
  } as unknown as SpineWriter;
  const m = { id: "ms_1", title: "Demo", repo: "demo", path: "docs/spines/epic.md", owner: "", paused: false } as never;
  const api = new Hono();
  mountTreeAdd(api, {
    store: { getMilestone: () => m } as never,
    spine,
    locate: async () => ({ repoDir: "/r", rel: "docs/spines/epic.md" }),
    treePaths: async () => new Set(),
    invalidate: () => undefined,
    deskAsk: async (chat) => (SAID.includes(chat) ? { text: SAID, at: "2026-11-23T10:00:00Z" } : "not his"),
    wake: async (_m, instructions) => (wakes.push(instructions), { runId: "run_dm" }),
    wakeWaitMs: 50,
    held: async (_dir, words) => (asked.push(words), held),
  });
  const add = async (body: unknown) =>
    (await api.request("/milestones/ms_1/tree/add", { method: "POST", headers: { "content-type": "application/json", "x-console-run": "team-desk" }, body: JSON.stringify(body) })).json();
  return { add, text: () => text, commits, wakes, asked };
}

describe("the filing step matches his words itself", () => {
  it("an open ticket that holds them gets his words, quoted; no new row; parked, it is ready again on his ask", async () => {
    const t = mount({ held: "E909-S1", file: "r/docs/spines/epic.md", agree: "3/3", why: "the same outcome: an objective opens fast on his phone", top: ["E909-S1"] });
    const r = await t.add({ kind: "row", title: "Objective page is slow", chat: "the objective page takes 10 seconds to open" });
    expect(r).toMatchObject({ placed: "E909-S1", ready: true, wake: { runId: "run_dm" } });
    expect(t.text()).not.toContain("E909-S3");
    expect(t.text()).toMatch(/\| E909-S1 \| Ticket worker \| worker \| Objective opens in under 2 s on his phone \| ready \|/);
    expect(t.text()).toContain(`E909-S1: Sam's words placed here at filing, no new row (the same outcome, judges 3/3, Team desk): "the objective page takes 10 seconds to open"`);
    expect(t.commits[0].msg).toMatch(/^Place Sam's words on E909-S1: it already holds them/);
    expect(t.asked[0]).toContain("the objective page takes 10 seconds to open");
  });

  it("no `matched: new` is needed when the match ran: a new point is filed new and says what was read", async () => {
    const t = mount({ held: null, after: null, top: ["E909-S1"], why: "none wants a dark mode" });
    const r = await t.add({ kind: "row", title: "Dark mode", chat: "fix it" });
    expect(r).toMatchObject({ id: "E909-S3", ready: true });
    expect(t.commits[0].body).toContain("Matched at filing: new (read E909-S1): none wants a dark mode");
  });

  it("a repeat of a closed ticket is filed new and names it as its follow-up, so the night never counts it a miss", async () => {
    const t = mount({ held: null, after: "E909-S2", top: ["E909-S2"], why: "the counters, already approved" });
    const r = await t.add({ kind: "row", title: "Counters wrong again", line: "on his phone", chat: "fix it" });
    expect(r).toMatchObject({ id: "E909-S3" });
    expect(t.text()).toContain("Counters wrong again: on his phone (follow-up of E909-S2, closed)");
  });

  it("words that match a ticket in his review get a ready follow-up row, never sit on the card", async () => {
    const t = mount({ held: null, after: "E909-S2", status: "review — snoozed until: 2026-12-17", top: ["E909-S2"], why: "the same call" });
    const r = await t.add({ kind: "row", title: "One briefed call", line: "all objectives", chat: "fix it" });
    expect(r).toMatchObject({ id: "E909-S3", ready: true });
    expect(t.text()).toContain("One briefed call: all objectives (follow-up of E909-S2, in his review)");
    expect(t.commits[0].body).toContain("Matched at filing: follow-up of E909-S2, in his review");
  });

  it("when the match cannot run, the desk's own `matched: new: …` is still required", async () => {
    const t = mount(undefined);
    expect((await t.add({ kind: "row", title: "Dark mode", chat: "fix it" })).error.code).toBe("match_first");
    expect(await t.add({ kind: "row", title: "Dark mode", chat: "fix it", matched: "new: read E909-S1, none wants a dark mode" })).toMatchObject({ id: "E909-S3" });
  });

  it("placeWords: an open ticket keeps its status; a draft only turns ready on his ask", () => {
    const open = SPINE.replace("deferred (parked by Sam 18 Nov)", "active");
    const a = placeWords(open, "E909-S1", { quote: "q", why: "w", date: "2026-11-23", ready: true, via: "Team desk" });
    expect(a.readied).toBe(false);
    expect(a.text).toMatch(/\| E909-S1 \|[^\n]*\| active \|/);
    const b = placeWords(SPINE, "E909-S1", { quote: "q", why: "w", date: "2026-11-23", ready: false, via: "Team desk" });
    expect(b.readied).toBe(false);
    expect(b.text).toContain('placed here at filing, no new row (the same outcome, judges ?, Team desk): "q"');
  });
});
