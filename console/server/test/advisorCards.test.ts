import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { acceptOnSpine, checkAdvisor, isoWeek, readyDraftRow, weekLabel } from "../src/inbox/advisorCards.js";
import { listCards, mountTeamCards, TEAM_CARDS_FILE, type TeamCardsDoc } from "../src/inbox/teamCards.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";

// E948-S59 (the owner, 2026-11-12: "how do I distinguish this? In the inbox when this guy sends me some suggestions"):
// the Senior advisor's week is one marked set on the team cards; accept writes a ready row on the spine first.

const SPINE = `# EPIC-946: Social launch

## Issue Ledger

| Row | Role | Owner | Task | Status | Depends | Base | Evidence | Verified | Next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E946-S1 | Ticket worker | x | first | done | none | main | e | 2026-11-01 | none |
| E946-S2 | Ticket worker | x | the pilot offer | draft | none | main | e | 2026-11-01 | none |

## Decisions

| Date | Outcome | Decision | Summary | Evidence | Revisit |
| --- | --- | --- | --- | --- | --- |
| 2026-11-01 | decided | x | y | z | none |
`;

function fakeWriter(): SpineWriter & { commits: string[] } {
  const commits: string[] = [];
  return {
    commits,
    async edit(o: { repoDir: string; path: string; edit: (t: string, d: string) => { skip: string } | { text: string; msg: string } }) {
      const file = path.join(o.repoDir, o.path);
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const e = o.edit(text, "2026-11-13");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, e.text);
      commits.push(`${o.path}: ${e.msg}`);
      return { status: "written", sha: `sha${commits.length}` };
    },
  } as unknown as SpineWriter & { commits: string[] };
}

const set = (over: Record<string, unknown> = {}) => ({
  kind: "advisor",
  by: "Senior advisor",
  title: "Three moves this week toward commercially live",
  advisor: {
    page: "https://example.com/advisor/2026-11-12",
    items: [
      { title: "Open the door: one stranger inside each product by Sunday", why: "zero outside users", spine: "docs/spines/epic-946.md" },
      { title: "Post every day without the owner, and count", spine: "docs/spines/epic-946.md" },
      { title: "The owner sells one pilot", spine: "docs/spines/epic-946.md", row: "E946-S2" },
    ],
  },
  ...over,
});

function app() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-cards-"));
  fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/spines/epic-946.md"), SPINE);
  const writer = fakeWriter();
  const api = new Hono();
  mountTeamCards(api, { writer, repo: () => dir, now: () => "2026-11-13T15:00:00Z" });
  const post = (p: string, body: unknown) => api.request(p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { dir, writer, post, spine: () => fs.readFileSync(path.join(dir, "docs/spines/epic-946.md"), "utf8"), file: () => JSON.parse(fs.readFileSync(path.join(dir, TEAM_CARDS_FILE), "utf8")) as TeamCardsDoc };
}

describe("E948-S59 the Senior advisor's weekly set", () => {
  it("names its ISO week and the days", () => {
    expect(isoWeek("2026-11-13")).toBe("2026-W46");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(weekLabel("2026-W46")).toBe("9 to 15 November");
    expect(weekLabel("2026-W49")).toBe("30 November to 6 December");
  });

  it("checks each suggestion: a title and the spine it lands on", () => {
    expect(checkAdvisor({ items: [] }, "2026-11-13")).toMatchObject({ ok: false, code: "bad_items" });
    expect(checkAdvisor({ items: [{ title: "x" }] }, "2026-11-13")).toMatchObject({ ok: false, code: "bad_spine" });
    expect(checkAdvisor({ items: [{ title: "x", spine: "../etc/passwd" }] }, "2026-11-13")).toMatchObject({ ok: false, code: "bad_spine" });
    const ok = checkAdvisor({ items: [{ title: "x", spine: "docs/spines/a.md" }] }, "2026-11-13");
    expect(ok).toMatchObject({ ok: true, set: { week: "2026-W46", items: [{ id: "a1", title: "x" }] } });
  });

  it("only the Senior advisor posts a set, one a week; it lists first", async () => {
    const a = app();
    expect((await a.post("/inbox/team-cards", set({ by: "Strategist" }))).status).toBe(400);
    expect((await a.post("/inbox/team-cards", set())).status).toBe(200);
    expect((await a.post("/inbox/team-cards", set())).status).toBe(429);
    await a.post("/inbox/team-cards", { kind: "idea", by: "Strategist", title: "An idea", idea: { gain: "g", recommend: "r" } });
    const l = listCards(a.file(), { now: "2026-11-13T16:00:00Z" });
    expect(l.open.map((c) => c.kind)).toEqual(["advisor", "idea"]);
    expect(l.counts.advisor).toBe(1);
  });

  it("Accept all: a ready row per new suggestion and a Decisions row naming him and quoting it; a drafted row turns ready", async () => {
    const a = app();
    const id = ((await (await a.post("/inbox/team-cards", set())).json()) as { card: { id: string } }).card.id;
    const r = await a.post(`/inbox/team-cards/${id}/advisor`, { verdict: "accept" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rows: Record<string, string> };
    expect(body.rows).toEqual({ a1: "E946-S3", a2: "E946-S4", a3: "E946-S2" });
    const s = a.spine();
    expect(s).toMatch(/\| E946-S3 \| Ticket worker \| unassigned \| Senior advisor: Open the door[^|]*Why: zero outside users[^|]*\| ready \|/);
    expect(s).toMatch(/\| E946-S2 \| Ticket worker \| x \| the pilot offer \| ready \|/);
    expect(s).toMatch(/accepted the Senior advisor's suggestions for the week of 9 to 15 November in his inbox: "The owner sells one pilot"; E946-S2 carries it and is ready now/);
    expect(s.match(/\| 2026-11-13 \| accepted \|/g)?.length).toBe(3);
    // the repo first: three spine commits, then the set's
    expect(a.writer.commits.map((c) => c.split(":")[0])).toEqual(["docs/inbox/cards.json", "docs/spines/epic-946.md", "docs/spines/epic-946.md", "docs/spines/epic-946.md", "docs/inbox/cards.json"]);
    const card = a.file().cards[0];
    expect(card.advisor!.items.map((i) => [i.verdict?.state, i.verdict?.row])).toEqual([["accepted", "E946-S3"], ["accepted", "E946-S4"], ["accepted", "E946-S2"]]);
    expect(card.answer?.text).toBe("Accepted 3, declined 0");
    expect(listCards(a.file(), { now: "2026-11-13T16:00:00Z" }).answered.map((c) => c.id)).toEqual([id]);
  });

  it("one at a time: decline one with words, a note on another, the set stays open until each has his answer", async () => {
    const a = app();
    const id = ((await (await a.post("/inbox/team-cards", set())).json()) as { card: { id: string } }).card.id;
    expect((await a.post(`/inbox/team-cards/${id}/advisor`, { verdict: "decline", items: ["a2"], text: "not this week", via: "voice" })).status).toBe(200);
    expect((await a.post(`/inbox/team-cards/${id}/advisor`, { verdict: "note", items: ["a1"], text: "start with the memory app" })).status).toBe(200);
    expect((await a.post(`/inbox/team-cards/${id}/advisor`, { verdict: "decline", items: ["a2"] })).status).toBe(409);
    expect(listCards(a.file(), { now: "2026-11-13T16:00:00Z" }).open.map((c) => c.id)).toEqual([id]);
    const items = a.file().cards[0].advisor!.items;
    expect(items[1].verdict).toMatchObject({ state: "declined", text: "not this week", via: "voice" });
    expect(items[0].notes?.[0].text).toBe("start with the memory app");
    expect(a.spine()).toBe(SPINE); // a decline and a note write no row
    expect((await a.post(`/inbox/team-cards/${id}/advisor`, { verdict: "accept", items: ["a1"] })).status).toBe(200);
    expect(a.spine()).toMatch(/E946-S3/);
    expect(a.file().cards[0].advisor!.items[2].verdict).toBeUndefined();
  });

  it("a spine that refuses leaves that suggestion open and saves nothing for it", async () => {
    const a = app();
    const id = ((await (await a.post("/inbox/team-cards", set({ advisor: { items: [{ title: "x", spine: "docs/spines/missing.md" }] } }))).json()) as { card: { id: string } }).card.id;
    const r = await a.post(`/inbox/team-cards/${id}/advisor`, { verdict: "accept" });
    expect(r.status).toBe(502);
    expect(a.file().cards[0].advisor!.items[0].verdict).toBeUndefined();
  });

  it("acceptOnSpine refuses a spine with no EPIC heading; readyDraftRow leaves a ready row alone", () => {
    const item = { id: "a1", title: "x", spine: "docs/spines/root.md" };
    expect(acceptOnSpine("# EPIC: root\n", item, { week: "2026-W46", items: [item] }, { date: "2026-11-13", who: "Sam", source: "s" })).toMatchObject({ skip: expect.stringMatching(/no EPIC-n heading/) });
    expect(readyDraftRow(SPINE, "E946-S1")).toBe(SPINE);
  });
});
