import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createAuth } from "../src/auth/identity.js";
import { spineFolders } from "../src/review/rows.js";
import { cardText, makeRepo, spineText } from "./reviewFixture.js";

/**
 * the review inbox lists review cards from every milestone of his world, whatever its repo.
 * tax-assist-research's cards never reached him: its milestone spine is docs/EPIC_SPINE.md and its epics sit
 * in docs/spines/, and the list read only the folder of the milestone spine. Now it follows the spine tree down (a linked
 * file whose `Parent spine:` points back), so every epic folder of the tree is read. Worlds stay apart; the badge, the
 * sidebar and the section header count the same cards. Temp repos only.
 */
const A = "home";
const Z = "social";
const OUTSIDE = "203.0.113.7";
const LIVE = "https://brief.example/";

const child = (code: string, title: string, rows: Parameters<typeof spineText>[2]) =>
  spineText(code, title, rows).replace("Root spine: [root](root.md)\nParent spine: [root](root.md)", "Root spine: [root](../EPIC_SPINE.md)\nParent spine: [root](../EPIC_SPINE.md)");

/** A root spine away from its epics: docs/EPIC_SPINE.md links its children in docs/spines/ (tax-assist-research's shape). */
const ROOT = (links: string[]) =>
  ["# EPIC: Tax matters", "", "Project name: [Tax matters](https://brief.example/)", "Parent spine: none", "", "## Current State", "", "Status: active", "", "## Spine Map", "", ...links.map((l) => `- ${l}`), ""].join("\n");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s30-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  makeRepo(dir, "home_repo", { "docs/spines/root.md": spineText("EPIC-900", "home_repo", [{ id: "E901-S1", status: "review", evidence: "[live](https://team.example/e1)" }]) });
  makeRepo(
    dir,
    "tax-assist-research",
    {
      "docs/EPIC_SPINE.md": ROOT(["[EPIC-903: brief](spines/brief.md)", "[EPIC-904: deck](spines/deck.md \"the deck\")", "[a note](notes/other.md)"]),
      "docs/spines/brief.md": child("EPIC-903", "Accountant brief", [{ id: "E903-S1", status: "review", evidence: `[brief](${LIVE})` }]),
      "docs/spines/deck.md": child("EPIC-904", "Concept deck", [{ id: "E904-S1", status: "review", evidence: `[deck](${LIVE}deck)` }]),
      // linked from the root but not its child (its parent is elsewhere): its folder is not part of the tree
      "docs/notes/other.md": spineText("EPIC-909", "Not a child", [{ id: "E909-S1", status: "review", evidence: `[x](${LIVE}x)` }]).replace("Parent spine: [root](root.md)", "Parent spine: [elsewhere](elsewhere.md)"),
      "docs/cards/E903-S1.md": cardText("E903-S1", { evidence: LIVE }),
      // a card that fails the gate (no verb in the title): "not a card yet", back to the agents, never dropped
      "docs/cards/E904-S1.md": cardText("E904-S1", { evidence: `${LIVE}deck`, title: "The new concept deck for the accountant." }),
      "docs/cards/shot.png": "",
    },
    { cards: false },
  );
  makeRepo(dir, "social", {
    "docs/EPIC_SPINE.md": ROOT(["[EPIC-901: posts](spines/posts.md)"]),
    "docs/spines/posts.md": child("EPIC-901", "Posts", [{ id: "Z1-S1", status: "review", evidence: "[post](https://social.example/p1)" }]),
  });
  const app = createApp(db, {
    auth: "on",
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: (async () => new Response("ok")) as unknown as typeof fetch, consoleHosts: [] } },
  });
  db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'internal', ?)").run(Z, Z, new Date().toISOString());
  const sa = createStore(db);
  const sz = createStore(db, { tenant: Z });
  const mAt = sa.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const mTax = sa.createMilestone({ title: "Tax", repo: "tax-assist-research", path: "docs/EPIC_SPINE.md", owner: "Sam", paused: false });
  const mZ = sz.createMilestone({ title: "social", repo: "social", path: "docs/EPIC_SPINE.md", owner: "Sam", paused: false });
  const auth = createAuth(db);
  const aTok = auth.createToken({ tenant: A, label: "automated-checks" }).token;
  const zTok = auth.createToken({ tenant: Z, label: "social check" }).token;
  const get = async (url: string, bearer: string) => {
    const res = await app.request(url, { headers: { authorization: `Bearer ${bearer}` } }, { incoming: { socket: { remoteAddress: OUTSIDE } } });
    return res.json() as Promise<any>;
  };
  /** A list once the background pass has read the spines and checked the links (the first read only starts it). */
  const read = async (url: string, bearer: string) => {
    for (let i = 0; i < 50; i++) {
      await get(url, bearer);
      await new Promise((r) => setTimeout(r, 20));
    }
    return get(url, bearer);
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, read, get, mAt, mTax, mZ, aTok, zTok };
}

describe("E948-S30 every milestone's repo", () => {
  it("follows the spine tree down: child folders join, a linked file whose parent is elsewhere does not", () => {
    const w = setup();
    expect([...spineFolders(path.join(w.dir, "tax-assist-research"), ["docs/EPIC_SPINE.md"])].sort()).toEqual(["docs", "docs/spines"]);
    // the code repo's shape (epics beside the root) reads one folder as before
    expect([...spineFolders(path.join(w.dir, "home_repo"), ["docs/spines/root.md"])]).toEqual(["docs/spines"]);
  });

  it("Sam's inbox holds the second repo's card; its failing card waits as not a card yet; badge = sidebar = list", async () => {
    const w = setup();
    const cards = (await w.read("/api/review-items", w.aTok)) as { ref: string; repo: string; milestoneId?: string }[];
    expect(cards.map((c) => `${c.repo} ${c.ref}`).sort()).toEqual(["home_repo E901-S1", "tax-assist-research E903-S1"]);
    expect(cards.find((c) => c.ref === "E903-S1")?.milestoneId).toBe(w.mTax.id);
    // nothing silently dropped: the card that fails the gate goes back to the agents
    const agents = (await w.get("/api/review-items?state=agents", w.aTok)) as { ref: string; repo: string }[];
    expect(agents.map((c) => `${c.repo} ${c.ref}`)).toContain("tax-assist-research E904-S1");
    expect(JSON.stringify([...cards, ...agents])).not.toMatch(/E909-S1|Z1-S1/);
    const goals = (await w.get("/api/review-goals", w.aTok)) as { goals?: { repo: string; code: string }[] } | { repo: string; code: string }[];
    const list = Array.isArray(goals) ? goals : (goals.goals ?? []);
    expect(list.map((g) => `${g.repo} ${g.code}`)).toContain("tax-assist-research EPIC-903");
    // the badge, the sidebar pills and the list count the same cards
    const c = await w.read("/api/counts", w.aTok);
    expect(c.review).toBe(cards.length);
    expect(Object.values(c.milestones as Record<string, { review?: number }>).reduce((n, m) => n + (m.review ?? 0), 0)).toBe(cards.length);
    expect(c.milestones[w.mTax.id].review).toBe(1);
    expect(c.milestones[w.mAt.id].review).toBe(1);
    expect(c.milestones[w.mZ.id]).toBeUndefined();
  });

  it("worlds stay apart: the other world sees only its own repo's card, from its child spine", async () => {
    const w = setup();
    const z = (await w.read("/api/review-items", w.zTok)) as { ref: string; repo: string }[];
    expect(z.map((c) => `${c.repo} ${c.ref}`)).toEqual(["social Z1-S1"]);
    const c = await w.read("/api/counts", w.zTok);
    expect(c.review).toBe(1);
    expect(Object.keys(c.milestones)).toEqual([w.mZ.id]);
    const a = (await w.read("/api/review-items", w.aTok)) as { ref: string }[];
    expect(a.map((x) => x.ref)).not.toContain("Z1-S1");
  });
});
