import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { addCard, answerCard, checkPost, dayOf, emptyDoc, listCards, mountTeamCards, TEAM_CARDS_FILE, type TeamCardsDoc } from "../src/inbox/teamCards.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";

// E948-S66 (the owner, vn_fe52ef4a 2026-11-12 22:19Z): the inbox carries a digest per scorecard, strategic ideas and goal
// conversations, each made by its persona through one console route, written to the repo, with his limits.

const digest = (scorecard: string, over: Record<string, unknown> = {}) => ({
  kind: "digest",
  by: "Performance",
  scorecard,
  title: `${scorecard} went greener`,
  digest: { greens: 3, total: 7, prevGreens: 2, prevTotal: 7, trend: "greener", reasons: [{ text: "Applications came in", url: "https://example.com/testers/" }] },
  ...over,
});
const idea = (n: number) => ({ kind: "idea", by: "Strategist", scorecard: "social-testers", title: `Idea ${n}`, idea: { gain: "two weeks sooner", recommend: "do it" } });
const goal = (scorecard = "memory-live") => ({
  kind: "goal",
  by: "Gap finder",
  scorecard,
  title: "Memory has no number for paying users",
  goal: { unset: "how many paying users by when", options: [{ goal: "10 paying by Dec 15", number: "10" }, { goal: "3 paying by Dec 1", number: "3" }], recommend: 1 },
});

function fakeWriter(dir: string): SpineWriter & { commits: string[] } {
  const commits: string[] = [];
  return {
    commits,
    async edit(o: { repoDir: string; path: string; edit: (t: string, d: string) => { skip: string } | { text: string; msg: string } }) {
      const file = path.join(o.repoDir, o.path);
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const e = o.edit(text, "2026-11-12");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, e.text);
      commits.push(e.msg);
      return { status: "written", sha: `sha${commits.length}` };
    },
  } as unknown as SpineWriter & { commits: string[] };
}

function app(now = "2026-11-13T15:00:00Z") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-cards-"));
  const writer = fakeWriter(dir);
  const api = new Hono();
  let clock = now;
  mountTeamCards(api, { writer, repo: () => dir, now: () => clock });
  const post = (p: string, body: unknown) => api.request(p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { api, dir, writer, post, setNow: (t: string) => (clock = t), file: () => JSON.parse(fs.readFileSync(path.join(dir, TEAM_CARDS_FILE), "utf8")) as TeamCardsDoc };
}

describe("E948-S66 team cards", () => {
  it("a day is Mexico City's", () => {
    expect(dayOf("2026-11-13T05:00:00Z")).toBe("2026-11-12");
    expect(dayOf("2026-11-13T07:00:00Z")).toBe("2026-11-13");
  });

  it("checks each kind's fields: a digest says why, a goal conversation has two or three goals with numbers", () => {
    expect(checkPost(digest("x")).ok).toBe(true);
    expect(checkPost(digest("x", { digest: { greens: 1, total: 2, trend: "redder", reasons: [] } }))).toMatchObject({ ok: false, code: "no_reasons" });
    expect(checkPost({ ...idea(1), idea: { gain: "x" } })).toMatchObject({ ok: false, code: "bad_idea" });
    expect(checkPost({ ...goal(), goal: { unset: "x", options: [{ goal: "a", number: "1" }] } })).toMatchObject({ ok: false, code: "bad_options" });
    expect(checkPost({ kind: "news", by: "x", title: "y" })).toMatchObject({ ok: false, code: "bad_kind" });
  });

  it("E948-S113: a digest where nothing moved is no card; a held line keeps what it waits on for the next comparison", () => {
    const same = { greens: 3, total: 9, prevGreens: 3, prevTotal: 9, trend: "same", reasons: [{ text: "Still red: browser" }], lines: [{ label: "Browser", state: "red", value: "0 of 1" }] };
    expect(checkPost(digest("x", { digest: same }))).toMatchObject({ ok: false, code: "no_news" });
    expect(checkPost(digest("x", { digest: { ...same, news: ["Browser now waits on your answer"] } }))).toMatchObject({ ok: true, card: { digest: { news: ["Browser now waits on your answer"] } } });
    expect(checkPost(digest("x", { digest: { ...same, lines: [{ label: "Browser", state: "red", value: "0 of 1", was: "amber" }] } })).ok).toBe(true);
    const w = checkPost(digest("x", { digest: { ...same, news: ["first"], lines: [{ label: "Browser", state: "red", value: "0", waits: { who: "team", text: "the team: a box, being built now", url: "https://team.example.com/x", extra: 1 } }, { label: "Sign-up", state: "green", value: "yes", waits: { who: "team", text: "x" } }] } }));
    expect(w.ok && w.card.digest?.lines).toEqual([{ label: "Browser", state: "red", value: "0", waits: { who: "team", text: "the team: a box, being built now", url: "https://team.example.com/x" } }, { label: "Sign-up", state: "green", value: "yes" }]);
  });

  it("a card names the key result it is about, and so does each digest reason", () => {
    const c = checkPost({ ...idea(1), scorecard: "launch", keyResult: "Tester applications" });
    expect(c).toMatchObject({ ok: true, card: { scorecard: "launch", keyResult: "Tester applications" } });
    const d = checkPost(digest("launch", { digest: { greens: 1, total: 2, trend: "first", reasons: [{ text: "Still red: Tester applications, 0", url: "https://team.example.com/sets/launch?kr=Tester%20applications", keyResult: "Tester applications" }, { text: "plain" }] } }));
    expect(d.ok && d.card.digest?.reasons).toEqual([{ text: "Still red: Tester applications, 0", url: "https://team.example.com/sets/launch?kr=Tester%20applications", keyResult: "Tester applications" }, { text: "plain" }]);
    expect(checkPost(idea(1))).toMatchObject({ ok: true });
    expect((checkPost(idea(1)) as { card: object }).card).not.toHaveProperty("keyResult");
  });

  it("posts through the route, one commit each, into the repo file", async () => {
    const a = app();
    const r = await a.post("/inbox/team-cards", digest("social-testers"));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { card: { id: string; day: string } };
    expect(j.card.id).toBe("tc_20261113_digest_social-testers");
    expect(a.file().cards).toHaveLength(1);
    expect(a.writer.commits[0]).toMatch(/^Performance: digest card/);
  });

  it("his limits: one digest per scorecard a day, three ideas a day, one open goal conversation per scorecard", async () => {
    const a = app();
    expect((await a.post("/inbox/team-cards", digest("s1"))).status).toBe(200);
    expect((await a.post("/inbox/team-cards", digest("s1"))).status).toBe(429);
    expect((await a.post("/inbox/team-cards", digest("s2"))).status).toBe(200);
    for (const n of [1, 2, 3]) expect((await a.post("/inbox/team-cards", idea(n))).status).toBe(200);
    const fourth = await a.post("/inbox/team-cards", idea(4));
    expect(fourth.status).toBe(429);
    expect(((await fourth.json()) as { error: { code: string } }).error.code).toBe("limit_ideas");
    expect((await a.post("/inbox/team-cards", goal())).status).toBe(200);
    expect((await a.post("/inbox/team-cards", goal())).status).toBe(429);
    // a dry run says the same without writing
    expect((await a.post("/inbox/team-cards", { ...idea(5), dryRun: true })).status).toBe(429);
    // the next day (Mexico City) the digest and the ideas are allowed again
    a.setNow("2026-11-14T15:00:00Z");
    expect((await a.post("/inbox/team-cards", digest("s1"))).status).toBe(200);
    expect((await a.post("/inbox/team-cards", idea(6))).status).toBe(200);
  });

  it("lists open cards digests, ideas, goals in that order; a newer digest replaces the older; filter by scorecard and kind", () => {
    let doc = emptyDoc();
    const put = (b: Record<string, unknown>, at: string) => {
      const c = checkPost(b);
      if (!c.ok) throw new Error(c.message);
      const r = addCard(doc, c.card, at);
      if ("error" in r) throw new Error(r.error.message);
      doc = r.doc;
      return r.card;
    };
    put(goal(), "2026-11-13T15:00:00Z");
    put(idea(1), "2026-11-13T15:01:00Z");
    const old = put(digest("s1"), "2026-11-12T15:00:00Z");
    put(digest("s1"), "2026-11-13T15:02:00Z");
    put(digest("s2"), "2026-11-13T15:03:00Z");
    const l = listCards(doc, { now: "2026-11-13T16:00:00Z" });
    expect(l.open.map((c) => c.kind)).toEqual(["digest", "digest", "idea", "goal"]);
    expect(l.open.some((c) => c.id === old.id)).toBe(false);
    expect(l.counts).toEqual({ digest: 2, idea: 1, goal: 1, advisor: 0, support: 0 });
    expect(listCards(doc, { now: "2026-11-13T16:00:00Z", scorecard: "s2" }).open.map((c) => c.scorecard)).toEqual(["s2"]);
    expect(listCards(doc, { now: "2026-11-13T16:00:00Z", kind: "idea" }).open).toHaveLength(1);
  });

  it("his answer (words, voice or a picked goal) is written to the card and moves it to Answered; a wrong pick is refused", async () => {
    const a = app();
    const r = (await (await a.post("/inbox/team-cards", goal())).json()) as { card: { id: string } };
    expect((await a.post(`/inbox/team-cards/${r.card.id}/answer`, { pick: 5 })).status).toBe(400);
    expect((await a.post(`/inbox/team-cards/${r.card.id}/answer`, { pick: 1, via: "button" })).status).toBe(200);
    expect((await a.post(`/inbox/team-cards/${r.card.id}/answer`, { text: "but by Dec 10", via: "voice" })).status).toBe(200);
    const card = a.file().cards[0];
    expect(card.answer).toMatchObject({ pick: 1, text: "but by Dec 10", via: "voice" });
    const l = (await (await a.api.request("/inbox/team-cards")).json()) as ReturnType<typeof listCards>;
    expect(l.open).toHaveLength(0);
    expect(l.answered.map((c) => c.id)).toEqual([r.card.id]);
    // with the goal answered, a new goal conversation for that scorecard may come
    expect((await a.post("/inbox/team-cards", goal())).status).toBe(200);
    expect((await a.post("/inbox/team-cards/tc_nope/answer", { text: "x" })).status).toBe(404);
  });

  it("answerCard keeps earlier words when more come", () => {
    let doc: TeamCardsDoc = emptyDoc();
    const c = checkPost(idea(1));
    if (!c.ok) throw new Error();
    const r = addCard(doc, c.card, "2026-11-13T15:00:00Z");
    if ("error" in r) throw new Error();
    doc = r.doc;
    const a1 = answerCard(doc, r.card.id, { at: "2026-11-13T16:00:00Z", text: "yes", via: "text" });
    if ("error" in a1) throw new Error();
    const a2 = answerCard(a1.doc, r.card.id, { at: "2026-11-13T16:05:00Z", text: "start Monday", via: "voice" });
    if ("error" in a2) throw new Error();
    expect(a2.card.answer?.text).toBe("yes\n\nstart Monday");
  });
});
