import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { buildTree, type Tree } from "../src/adapters/tree.js";
import { asksFor } from "../src/inbox/asks.js";
import { askItemId, askLegacyId, askLineIn, samePairKeep, waitingAndHeld, waitingOnJordi } from "../src/inbox/waiting.js";
import { reviewId, reviewLegacyId } from "../src/review/rows.js";
import { createStore, type Milestone } from "../src/store.js";

// E948-S182 (the owner 22 Nov 23:5xZ, his Urgent screenshot): the kernel plan ask E906-A16 showed twice, 2 and 13 min old,
// after E906-S228 moved its line from EPIC-906 to EPIC-9105. The console keyed an ask by its spine path: the old path's record
// (a tree read before the move) stayed next to the new one. A coded ask is one card per repo and code.
const Q = "You approve the kernel plan, or say what to change?";
const LINE = `- [ask E906-A16: approve @Sam since 2026-11-01] ${Q} — recommend: yes`;
const doc = (title: string, asks: string[]) => `# ${title}\n\n## Current State\n\nStatus: active\nWaiting on: none\n\n## Waiting on\n\n${asks.join("\n")}\n`;

let reposRoot: string;
let db: DB;
const repoDir = () => path.join(reposRoot, "home_repo");
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s182-"));
  fs.mkdirSync(path.join(repoDir(), ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoDir(), "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(repoDir(), ".git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/home_repo.git\n`);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

const spinesOf = (code: string) => [{ code, who: "Sam", ask: "approve", question: Q, since: "2026-11-01", state: "open" }];

describe("E948-S182 one ask is one card, even after its line moves to another epic", () => {
  it("a stale tree of the old epic still holding the moved line: one card, the new path's", async () => {
    // on disk the line now lives only in EPIC-9105; EPIC-906's tree was read before the move and still lists it
    fs.writeFileSync(path.join(repoDir(), "docs/spines/m906.md"), doc("EPIC-906: Team", []));
    fs.writeFileSync(path.join(repoDir(), "docs/spines/epic-9105.md"), doc("EPIC-9105: Alignment", [LINE]));
    db = openDb(path.join(reposRoot, "c.db"));
    const store = createStore(db);
    const old = store.createMilestone({ title: "EPIC-906", repo: "Acme/home_repo", path: "docs/spines/m906.md", owner: "", paused: false });
    const now = store.createMilestone({ title: "EPIC-9105", repo: "Acme/home_repo", path: "docs/spines/epic-9105.md", owner: "", paused: false });
    const treeFor = (m: Milestone): Tree => {
      const t = buildTree(reposRoot, m, undefined);
      t.asks = { [m.path]: asksFor(repoDir(), m.path, spinesOf("E906-A16")) };
      return t;
    };
    const deps = { store, reposRoot, treeFor: async (m: Milestone) => treeFor(m), blame: async () => undefined, firstAdded: async () => undefined };
    if (process.env.DBG) console.log(JSON.stringify((await waitingAndHeld(deps, now)).held));
    const items = await waitingOnJordi(deps, {});
    const cards = items.filter((i) => i.source === "ask" && i.code === "E906-A16");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.path).toBe("docs/spines/epic-9105.md");
    expect(cards[0]!.milestoneId).toBe(now.id);
    expect(cards[0]!.id).toBe(askItemId("home_repo", "docs/spines/epic-9105.md", null, Q, "E906-A16"));
    expect(cards[0]!.alsoIn ?? []).toContain(old.id);
  });

  it("the same code live in two spines is a real duplicate: both stay, for the census to name", async () => {
    fs.writeFileSync(path.join(repoDir(), "docs/spines/m906.md"), doc("EPIC-906: Team", [LINE]));
    fs.writeFileSync(path.join(repoDir(), "docs/spines/epic-9105.md"), doc("EPIC-9105: Alignment", [LINE]));
    db = openDb(path.join(reposRoot, "c.db"));
    const store = createStore(db);
    store.createMilestone({ title: "EPIC-906", repo: "Acme/home_repo", path: "docs/spines/m906.md", owner: "", paused: false });
    store.createMilestone({ title: "EPIC-9105", repo: "Acme/home_repo", path: "docs/spines/epic-9105.md", owner: "", paused: false });
    const treeFor = (m: Milestone): Tree => {
      const t = buildTree(reposRoot, m, undefined);
      t.asks = { [m.path]: asksFor(repoDir(), m.path, spinesOf("E906-A16")) };
      return t;
    };
    const items = await waitingOnJordi({ store, reposRoot, treeFor: async (m) => treeFor(m), blame: async () => undefined, firstAdded: async () => undefined }, {});
    const cards = items.filter((i) => i.source === "ask" && i.code === "E906-A16");
    expect(cards.map((c) => c.path).sort()).toEqual(["docs/spines/epic-9105.md", "docs/spines/m906.md"]);
  });

  it("the id is the repo and code, whatever the path, row or wording; an ask with no code keeps its path id", () => {
    expect(askItemId("home_repo", "docs/spines/m906.md", "E906-S1", Q, "E906-A16")).toBe(askItemId("home_repo", "docs/spines/epic-9105.md", null, "reworded", "e906-a16"));
    expect(askItemId("home_repo", "a.md", null, Q, "E906-A16")).not.toBe(askItemId("other_repo", "a.md", null, Q, "E906-A16"));
    expect(askItemId("home_repo", "a.md", null, Q)).toBe(askLegacyId("home_repo", "a.md", null, Q));
  });

  it("a review card is keyed by repo and row code; a bare row code keeps its path id", () => {
    expect(reviewId("home_repo", "docs/spines/m906.md", "E906-S228")).toBe(reviewId("home_repo", "docs/spines/epic-9105.md", "E906-S228"));
    expect(reviewId("home_repo", "a.md", "T6")).toBe(reviewLegacyId("home_repo", "a.md", "T6"));
    expect(reviewId("home_repo", "a.md", "T6")).not.toBe(reviewId("home_repo", "b.md", "T6"));
  });

  it("which record keeps the card: the one whose file holds the line now", () => {
    fs.writeFileSync(path.join(repoDir(), "new.md"), `${LINE}\n`);
    fs.writeFileSync(path.join(repoDir(), "old.md"), `- [answered E906-A160 2026-11-22 @Sam] other\n`);
    const live = (p: string) => askLineIn(repoDir(), p, "E906-A16");
    expect(live("new.md")).toBe(true);
    expect(live("old.md")).toBe(false); // E906-A160 is another code
    expect(samePairKeep({ path: "old.md" }, { path: "new.md" }, live)).toBe("b");
    expect(samePairKeep({ path: "new.md" }, { path: "old.md" }, live)).toBe("a");
    expect(samePairKeep({ path: "new.md" }, { path: "new.md" }, live)).toBe("both");
  });
});
