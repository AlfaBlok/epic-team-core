import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { buildTree, type Tree } from "../src/adapters/tree.js";
import { asksFor } from "../src/inbox/asks.js";
import { legacyDuplicateOf, waitingOnJordi } from "../src/inbox/waiting.js";
import { createStore, type Milestone } from "../src/store.js";

// a Needs the owner row with no code that restates an ask the Unblocker already
// answered in the spine stayed an open inbox card, because compared text only against OPEN asks.
const Q = "May the epicspine-skill Delivery Manager add persona files to ops and social so PLAN-5 can finish?";
const EPIC5 = `# PLAN-5: Personas

## Current State

Status: active
Waiting on: none

## Waiting on

- [answered PLAN-5-A1 2026-10-26 @Unblocker] ${Q} (console Needs Sam nj_958bad5c, raised 2026-10-25 by the Delivery Manager, row E5-6) — answer: yes, as proposed
- [answered PLAN-5-A2 2026-10-20 @Sam] Should the console show a weekly digest of persona runs to Sam? — answer: no
- [ask PLAN-5-A3: approve @Sam since 2026-10-25] Can the Delivery Manager rotate the seat2 login token tonight? — recommend: yes — unblocks: E5-7
`;

let reposRoot: string;
let db: DB;
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s28-"));
  fs.mkdirSync(path.join(reposRoot, "epicspine-skill/.git"), { recursive: true });
  fs.mkdirSync(path.join(reposRoot, "epicspine-skill/docs"), { recursive: true });
  fs.writeFileSync(path.join(reposRoot, "epicspine-skill/.git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/epicspine-skill.git\n`);
  fs.writeFileSync(path.join(reposRoot, "epicspine-skill/docs/epic5.md"), EPIC5);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

/** spines.py v2 `waiting_on` for EPIC5: it carries no answered date (`since` null); the markdown line has it. */
const spines = [
  { code: "PLAN-5-A1", who: "Unblocker", ask: null, question: `${Q} (console Needs Sam nj_958bad5c, raised 2026-10-25 by the Delivery Manager, row E5-6)`, since: null, state: "answered", answer: "yes" },
  { code: "PLAN-5-A2", who: "Sam", ask: null, question: "Should the console show a weekly digest of persona runs to Sam?", since: null, state: "answered", answer: "no" },
  { code: "PLAN-5-A3", who: "Sam", ask: "approve", question: "Can the Delivery Manager rotate the seat2 login token tonight?", since: "2026-10-25", state: "open" },
];
function treeFor(m: Milestone): Tree {
  const t = buildTree(reposRoot, m, undefined);
  t.asks = { ...(t.asks ?? {}), [m.path]: asksFor(path.join(reposRoot, "epicspine-skill"), m.path, spines) };
  return t;
}

function setup() {
  db = openDb(path.join(reposRoot, "c.db"));
  const store = createStore(db);
  const m = store.createMilestone({ title: "PLAN-5", repo: "Acme/epicspine-skill", path: "docs/epic5.md", owner: "", paused: false });
  const nj = (question: string, createdAt: string, proposedAction = "") => {
    const row = store.createNeedsJordi({ milestoneId: m.id, question, proposedAction, status: "open" });
    db.prepare("UPDATE needs_jordi SET created_at = ? WHERE id = ?").run(createdAt, row.id);
    return row;
  };
  // the inbox lists no Needs the owner rows any more; the old rule lives on in the carry-over (legacyDuplicateOf):
  // "shown" = the rows the carry would write into the spine, the rest it supersedes by the ask they restate.
  const shown = async () => {
    const view = await waitingOnJordi({ store, reposRoot, treeFor: async (x) => treeFor(x), blame: async () => undefined }, { includeSettled: true });
    expect(view.filter((i) => (i.source as string) === "needs_jordi")).toEqual([]);
    const tree = await treeFor(m);
    return store
      .listNeedsJordi({ status: "open", milestoneId: m.id })
      .filter((r) => !legacyDuplicateOf(r, view, undefined, { asks: tree.asks, repo: "epicspine-skill" }))
      .map((r) => r.id);
  };
  return { store, nj, shown };
}

describe("T8-S28 a Needs Sam row restating a settled ask", () => {
  it("(a) the nj_958bad5c shape: uncoded row, ask answered with the same text after it was raised → hidden, row untouched", async () => {
    const { store, nj, shown } = setup();
    const row = nj(Q, "2026-10-25T21:04:00.000Z", "Add personas/<name>.md files only; revert on a failed validate.");
    expect(await shown()).toEqual([]);
    // Mechanism, not cleanup (L-12): the row is still open, so approve/answer by id keeps working.
    expect(store.getNeedsJordi(row.id)!.status).toBe("open");
  });

  it("(b) a reworded restatement of the answered ask → hidden", async () => {
    const { nj, shown } = setup();
    nj("Can the Delivery Manager of epicspine-skill add the persona files to ops and social, so PLAN-5 can finish?", "2026-10-26T08:00:00.000Z");
    expect(await shown()).toEqual([]);
  });

  it("(c) an ask settled BEFORE the row was raised: a genuine re-ask, still shown", async () => {
    const { nj, shown } = setup();
    const reask = nj("Should the console show a weekly digest of persona runs to Sam?", "2026-10-25T10:00:00.000Z");
    const other = nj("Which region should the bot use?", "2026-10-25T10:00:00.000Z");
    expect((await shown()).sort()).toEqual([reask.id, other.id].sort());
  });

  it("(d) the open-ask duplicate rule is unchanged: a restatement of an open ask is hidden whatever its date", async () => {
    const { nj, shown } = setup();
    nj("Can the Delivery Manager rotate the seat2 login token tonight?", "2026-10-27T10:00:00.000Z");
    nj("Rotate the token (PLAN-5-A3)?", "2026-10-20T10:00:00.000Z");
    expect(await shown()).toEqual([]);
  });
});
