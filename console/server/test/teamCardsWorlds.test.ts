import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runWithAuth, type Identity } from "../src/auth/identity.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { DEFAULT_TENANT } from "../src/db.js";
import { cardRepoOf, cardWorlds, mountTeamCards, TEAM_CARDS_FILE, type listCards, type TeamCardsDoc } from "../src/inbox/teamCards.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";

// A card world (the social world) posts and reads only its own idea cards, kept in its own repo; the three ideas a day cap
// is shared; the owner's inbox (the home world) lists them with their world named. Every direction is tested: a world
// never reads the home world's cards or another world's, and a home card never lands in a world's file.

function fakeWriter(): SpineWriter & { commits: { dir: string; msg: string }[] } {
  const commits: { dir: string; msg: string }[] = [];
  return {
    commits,
    async edit(o: { repoDir: string; path: string; edit: (t: string, d: string) => { skip: string } | { text: string; msg: string } }) {
      const file = path.join(o.repoDir, o.path);
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const e = o.edit(text, "2026-11-13");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, e.text);
      commits.push({ dir: o.repoDir, msg: e.msg });
      return { status: "written", sha: `sha${commits.length}` };
    },
  } as unknown as SpineWriter & { commits: { dir: string; msg: string }[] };
}

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const WORLDS = () => ["social-w", "other-w"];

function app() {
  const home = tmp("tc-home-");
  const zen = tmp("tc-social-");
  const other = tmp("tc-other-");
  const writer = fakeWriter();
  const api = new Hono();
  // the request's credential: a world token (x-world), or none (legacy trust, the home world)
  api.use(async (c, next) => {
    const w = c.req.header("x-world");
    // x-login: the owner logged in to that world (a session), as in its own skin; else the world's agent token
    const identity: Identity = w
      ? c.req.header("x-login")
        ? { kind: "session", tenant: w, userId: "u", email: "owner@x", name: "Owner", role: "owner" }
        : { kind: "token", tenant: w, tokenId: "t", label: "t" }
      : { kind: "none" };
    return runWithAuth({ mode: "on", identity }, () => next());
  });
  const dirs: Record<string, string> = { "social-w": zen, "other-w": other };
  mountTeamCards(api, { writer, repo: () => home, worldRepo: (w) => dirs[w], worlds: WORLDS, now: () => "2026-11-13T15:00:00Z" });
  const as = (world?: string, login = false) => ({
    post: (p: string, body: unknown) =>
      api.request(p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(world ? { "x-world": world } : {}), ...(login ? { "x-login": "1" } : {}) } }),
    get: async (p = "/inbox/team-cards") => (await api.request(p, { headers: world ? { "x-world": world } : {} })).json() as Promise<ReturnType<typeof listCards>>,
  });
  const file = (dir: string) => (fs.existsSync(path.join(dir, TEAM_CARDS_FILE)) ? (JSON.parse(fs.readFileSync(path.join(dir, TEAM_CARDS_FILE), "utf8")) as TeamCardsDoc) : { cards: [] });
  return { home, zen, other, writer, as, file };
}

const idea = (title: string) => ({ kind: "idea", by: "Goal persona", title, idea: { gain: "a week sooner", recommend: "rewrite the key result" } });
const digest = { kind: "digest", by: "Performance", scorecard: "s1", title: "s1 went greener", digest: { greens: 1, total: 2, trend: "first", reasons: [{ text: "why" }] } };

describe("team cards per world", () => {
  it("the route and the answer are open to worlds at the judge; advisor verdicts stay the home world's", () => {
    expect(isTenantSafe("GET", "/api/inbox/team-cards")).toBe(true);
    expect(isTenantSafe("POST", "/api/inbox/team-cards")).toBe(true);
    expect(isTenantSafe("POST", "/api/inbox/team-cards/tc_20261113_idea_social-w_add-a-tester/answer")).toBe(true);
    expect(isTenantSafe("GET", "/api/inbox/team-cards/tc_x/answer")).toBe(false);
    expect(isTenantSafe("POST", "/api/inbox/team-cards/tc_x/advisor")).toBe(false);
    expect(cardWorlds()).not.toContain(DEFAULT_TENANT);
    expect(cardRepoOf("social-w", [{ name: "campaign", path: "/a" }, { name: "social-w", path: "/b" }])).toBe("/b");
    expect(cardRepoOf("social-w", [{ name: "campaign", path: "/a" }])).toBe("/a");
    expect(cardRepoOf("social-w", undefined)).toBeUndefined();
  });

  it("a card world's idea lands in its own repo, names its world, and never in the home repo", async () => {
    const a = app();
    const r = await a.as("social-w").post("/inbox/team-cards", idea("Rewrite KR 2"));
    expect(r.status).toBe(200);
    const card = ((await r.json()) as { card: { id: string; world: string } }).card;
    expect(card.world).toBe("social-w");
    expect(card.id).toContain("social-w");
    expect(a.file(a.zen).cards.map((c) => c.title)).toEqual(["Rewrite KR 2"]);
    expect(a.file(a.home).cards).toEqual([]);
    expect(a.writer.commits.map((c) => c.dir)).toEqual([a.zen]);
  });

  it("a card world reads only its own cards: never the home world's, never another world's", async () => {
    const a = app();
    expect((await a.as().post("/inbox/team-cards", idea("Home idea"))).status).toBe(200);
    expect((await a.as().post("/inbox/team-cards", digest)).status).toBe(200);
    expect((await a.as("other-w").post("/inbox/team-cards", idea("Other idea"))).status).toBe(200);
    expect((await a.as("social-w").post("/inbox/team-cards", idea("Social idea"))).status).toBe(200);
    const zen = await a.as("social-w").get();
    expect(zen.open.map((c) => c.title)).toEqual(["Social idea"]);
    const other = await a.as("other-w").get();
    expect(other.open.map((c) => c.title)).toEqual(["Other idea"]);
    // a home card's id asked by kind or scorecard still yields nothing of the home world
    expect((await a.as("social-w").get("/inbox/team-cards?kind=digest")).open).toEqual([]);
    expect((await a.as("social-w").get("/inbox/team-cards?scorecard=s1")).open).toEqual([]);
  });

  it("a home card never reaches a world's file, even one planted there with a home kind", async () => {
    const a = app();
    // a digest written into the world's file by hand is not a world kind: the world's list leaves it out
    fs.mkdirSync(path.join(a.zen, "docs/inbox"), { recursive: true });
    fs.writeFileSync(path.join(a.zen, TEAM_CARDS_FILE), JSON.stringify({ version: 1, about: "x", cards: [{ id: "tc_d", kind: "digest", by: "P", at: "2026-11-13T10:00:00Z", day: "2026-11-13", title: "Planted", scorecard: "s1" }] }));
    expect((await a.as("social-w").get()).open).toEqual([]);
    expect((await a.as().get()).open.map((c) => c.title)).toEqual([]);
  });

  it("the owner's inbox (home world) lists the home cards and every card world's ideas, each naming its world", async () => {
    const a = app();
    await a.as().post("/inbox/team-cards", idea("Home idea"));
    await a.as("social-w").post("/inbox/team-cards", idea("Social idea"));
    const home = await a.as().get();
    expect(home.open.map((c) => [c.title, c.world ?? "home"]).sort()).toEqual([
      ["Home idea", "home"],
      ["Social idea", "social-w"],
    ]);
  });

  it("other kinds stay home-world only; a world outside CARD_WORLDS is refused both ways", async () => {
    const a = app();
    for (const body of [digest, { kind: "goal", by: "x", title: "y" }, { kind: "advisor", by: "Senior advisor", title: "z" }]) {
      const r = await a.as("social-w").post("/inbox/team-cards", body);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("world_kind");
    }
    await a.as().post("/inbox/team-cards", idea("Home idea"));
    const stranger = await a.as("stranger-w").post("/inbox/team-cards", idea("Stranger"));
    expect(stranger.status).toBe(403);
    expect((await a.as("stranger-w").get()) as unknown).toEqual({ error: { code: "world_scope", message: "team cards are not open to this world" } });
    expect(a.file(a.home).cards.map((c) => c.title)).toEqual(["Home idea"]);
  });

  it("three ideas a day is one cap across the worlds", async () => {
    const a = app();
    expect((await a.as().post("/inbox/team-cards", idea("H1"))).status).toBe(200);
    expect((await a.as("social-w").post("/inbox/team-cards", idea("Z1"))).status).toBe(200);
    expect((await a.as("social-w").post("/inbox/team-cards", { ...idea("Z2"), dryRun: true })).status).toBe(200);
    expect((await a.as("other-w").post("/inbox/team-cards", idea("O1"))).status).toBe(200);
    expect((await a.as("social-w").post("/inbox/team-cards", { ...idea("Z2"), dryRun: true })).status).toBe(429);
    expect((await a.as("social-w").post("/inbox/team-cards", idea("Z2"))).status).toBe(429);
    expect((await a.as().post("/inbox/team-cards", idea("H2"))).status).toBe(429);
  });

  it("the owner's answer on a world's idea is written to that world's file", async () => {
    const a = app();
    const r = (await (await a.as("social-w").post("/inbox/team-cards", idea("Social idea"))).json()) as { card: { id: string } };
    expect((await a.as().post(`/inbox/team-cards/${r.card.id}/answer`, { text: "yes, do it" })).status).toBe(200);
    expect(a.file(a.zen).cards[0].answer?.text).toBe("yes, do it");
    expect(a.file(a.home).cards).toEqual([]);
    // the world reads his answer back on its own card
    expect((await a.as("social-w").get()).answered.map((c) => c.answer?.text)).toEqual(["yes, do it"]);
  });

  // The owner answers a persona's idea card from the social world's own skin, logged in to that world.
  it("the owner logged in to a card world answers its idea card there: Go ahead and his words land in that world's file", async () => {
    const a = app();
    const r = (await (await a.as("social-w").post("/inbox/team-cards", idea("Social idea"))).json()) as { card: { id: string } };
    const go = await a.as("social-w", true).post(`/inbox/team-cards/${r.card.id}/answer`, { text: "Go ahead", via: "button" });
    expect(go.status).toBe(200);
    expect(a.file(a.zen).cards[0].answer).toMatchObject({ text: "Go ahead", via: "button" });
    expect(a.file(a.home).cards).toEqual([]);
    expect(a.file(a.other).cards).toEqual([]);
    expect(a.writer.commits.at(-1)?.dir).toBe(a.zen);
    // his typed words answer it too (added under the first, as at home)
    const said = await a.as("social-w", true).post(`/inbox/team-cards/${r.card.id}/answer`, { text: "Yes, and count the applications weekly" });
    expect(said.status).toBe(200);
    expect(a.file(a.zen).cards[0].answer?.text).toBe("Go ahead\n\nYes, and count the applications weekly");
    // the world's own list and the owner's home inbox both show it answered
    expect((await a.as("social-w").get()).answered.map((c) => c.id)).toEqual([r.card.id]);
    expect((await a.as().get()).answered.map((c) => c.id)).toEqual([r.card.id]);
  });

  it("a card world never answers another world's card or a home card, and its agents never answer", async () => {
    const a = app();
    const home = (await (await a.as().post("/inbox/team-cards", idea("Home idea"))).json()) as { card: { id: string } };
    const homeDigest = (await (await a.as().post("/inbox/team-cards", digest)).json()) as { card: { id: string } };
    const other = (await (await a.as("other-w").post("/inbox/team-cards", idea("Other idea"))).json()) as { card: { id: string } };
    const own = (await (await a.as("social-w").post("/inbox/team-cards", idea("Social idea"))).json()) as { card: { id: string } };
    for (const id of [home.card.id, homeDigest.card.id, other.card.id]) {
      const r = await a.as("social-w", true).post(`/inbox/team-cards/${id}/answer`, { text: "Go ahead" });
      expect(r.status).toBe(404);
    }
    // the other world, logged in, cannot answer the social world's card either (the other direction)
    expect((await a.as("other-w", true).post(`/inbox/team-cards/${own.card.id}/answer`, { text: "Go ahead" })).status).toBe(404);
    // the world's agent token: refused, even on its own card
    const agent = await a.as("social-w").post(`/inbox/team-cards/${own.card.id}/answer`, { text: "Go ahead" });
    expect(agent.status).toBe(403);
    // a world outside the card worlds: refused
    expect((await a.as("stranger-w", true).post(`/inbox/team-cards/${own.card.id}/answer`, { text: "Go ahead" })).status).toBe(403);
    // advisor verdicts stay the home world's
    expect((await a.as("social-w", true).post(`/inbox/team-cards/${own.card.id}/advisor`, { verdict: "accept" })).status).toBe(404);
    // nothing was answered anywhere
    for (const dir of [a.home, a.zen, a.other]) expect(a.file(dir).cards.every((c) => !c.answer)).toBe(true);
  });
});
