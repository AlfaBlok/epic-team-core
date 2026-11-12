import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { TreeNode } from "../src/adapters/tree.js";
import { citesRows, openForJordi, ownedByJordi, rowLabel, rowTitle } from "../src/inbox/freeText.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/**
 * free-text asks (the owner-owned open ledger row, a `Waiting on:` line naming the owner, with no coded ask) are
 * pending items of kind free_text_ask, counted in needsYou, the Team badge (/api/status) and the Tree red count.
 */

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

/** a social world repo docs/spines/root.md at 3162619 (2026-10-24): asks written as draft ledger rows assigned to the owner. */
const LEDGER = `| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| draft | Delivery manager | Delivery manager | T0-S1 console milestone on this spine, 4 personas, all DISABLED for Sam to review | draft | Sam says go | none | main | none | 2026-10-24 | create via console API when Sam asks |
| draft | Sam | Sam | T0-S2 [Which accounts do we post from?](../asks.md#e900-s2-which-accounts-do-we-post-from) | draft | none | none | none | plan deck slide 14 | 2026-10-24 | asked 2026-10-24; Sam answers, record in Decisions |
| draft | Sam | Sam | T0-S3 [Do you approve posts for the first 2 weeks?](../asks.md#e900-s3-do-you-approve-posts-for-the-first-2-weeks) | draft | none | none | none | plan deck slide 14 | 2026-10-24 | asked 2026-10-24; Sam answers, record in Decisions |
| draft | Sam | Sam | T0-S4 [How do we reply in other people's threads?](../asks.md#e900-s4-how-do-we-reply-in-other-peoples-threads) | draft | none | none | none | plan deck slide 14 | 2026-10-24 | asked 2026-10-24; Sam answers, record in Decisions |
| draft | Sam | Sam | T0-S5 [What should Memo say?](../asks.md#e900-s5-what-should-memo-say) | draft | none | none | none | data/message-house.md (empty) | 2026-10-24 | asked 2026-10-24; Sam sends points |
`;
const MEMO = (waitingOn: string, extra = "", ledger = LEDGER) => `# PLAN-0: Memo social presence

Spine ID: PLAN-0

## Current State

Owner: Delivery manager
Status: active
Waiting on: ${waitingOn}
Next action: on Sam's go, T0-S1
${extra}
## Issue Ledger

${ledger}`;
const MEMO_WAITING = "Sam T0-S2 (accounts), T0-S3 (approval), T0-S5 (message house); T0-S4 blocks only the Engager";

/** shape: nothing open for the owner, rows owned by agents. */
const EPIC2 = `# PLAN-2: HOST1 under control

Spine ID: PLAN-2

## Current State

Status: active
Waiting on: nothing open for Sam (PLAN-2-A9 answered)

## Waiting on

- [answered PLAN-2-A9 2026-10-24 @Sam] Rebuild the dashboard on HOST3? — answer: yes

## Issue Ledger

| Issue | Owner | Title | Status |
|---|---|---|---|
| S5 | Delivery manager | Memory limit on every container | done |
| S9 | worker | Agent load rule | active |
| S12 | Sam | Old row Sam closed | done |
`;

function setup(files: Record<string, string>, spine = "docs/spines/root.md", repo = "Acme/social") {
  const name = repo.split("/")[1];
  write(`${name}/.git/config`, `[remote "origin"]\n\turl = https://github.com/${repo}.git\n`);
  for (const [rel, text] of Object.entries(files)) write(`${name}/${rel}`, text);
  db = openDb(path.join(reposRoot, "c.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const m = createStore(db).createMilestone({ title: "PLAN-0", repo, path: spine, owner: "", paused: false });
  const get = async (url: string) => (await app.request(url)).json();
  return { m, get };
}
type Item = { id: string; kind: string; state: string; title: string; code?: string; url?: string; nodeKey?: string };
const walk = (n: TreeNode & { waiting?: number }, f: (n: TreeNode & { waiting?: number }) => void) => {
  f(n);
  n.children.forEach((c) => walk(c, f));
};

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s4-"));
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

describe("T13-S4 free-text asks (social PLAN-0)", () => {
  it("T13-S14: Sam-owned draft rows with no coded ask count nowhere (status, Team badge, Tree red 0); each is a defect for the owner, amber in the Tree", async () => {
    const { m, get } = setup({ "docs/spines/root.md": MEMO(MEMO_WAITING), "docs/asks.md": "# asks\n" });
    const st = await get(`/api/milestones/${m.id}/status`);
    const all = await get(`/api/status`);
    const t = await get(`/api/milestones/${m.id}/tree`);
    expect((st.items as Item[]).filter((i) => i.state === "open")).toEqual([]);
    expect([st.needsYou, all.needsYou, t.counts.red]).toEqual([0, 0, 0]);
    expect(st.flow.word).not.toBe("needs_you");
    const defects = st.defects as { kind: string; text: string; url?: string; nodeKey?: string }[];
    expect(defects.map((d) => d.kind)).toEqual(["free_text", "free_text", "free_text", "free_text"]);
    for (const d of defects) expect(d.text).toMatch(/^Sam named at docs\/spines\/root\.md:\d+ with no ask: write a coded ask or drop the line$/);
    // Each links to its spine line; its tree node is amber, not red.
    expect(defects[0].url).toMatch(/github\.com\/Acme\/social\/blob\/HEAD\/docs\/spines\/root\.md\?plain=1#L\d+/);
    const amber: string[] = [];
    walk(t.root, (n) => {
      if (defects.some((d) => d.nodeKey === n.key)) amber.push(n.color);
    });
    expect(amber).toEqual(["yellow", "yellow", "yellow", "yellow"]);
  });

  it("a coded ask on a row is the one item; the other Sam rows are defects, not counted", async () => {
    const asks = `\n## Waiting on\n\n- [ask PLAN-0-A1: decide @Sam since 2026-10-24 row T0-S2] Which accounts do we post from? — options: personal | brand — recommend: personal — unblocks: T0-S2\n`;
    const { m, get } = setup({ "docs/spines/root.md": MEMO("PLAN-0-A1 (accounts)", asks) });
    const st = await get(`/api/milestones/${m.id}/status`);
    expect((st.items as Item[]).filter((i) => i.state === "open").map((i) => [i.kind, i.code])).toEqual([["ask", "PLAN-0-A1"]]);
    expect(st.needsYou).toBe(1);
    expect((st.defects as { kind: string }[]).filter((d) => d.kind === "free_text")).toHaveLength(3);
  });

  it("rows done (asks answered) and a line naming no Sam row: the line is one defect, no item", async () => {
    const done = LEDGER.replace(/\| draft \| none \| none \| none \|/g, "| done | none | none | none |");
    const { m, get } = setup({ "docs/spines/root.md": MEMO("Sam to confirm the brand voice", "", done) });
    const st = await get(`/api/milestones/${m.id}/status`);
    expect((st.items as Item[]).filter((i) => i.state === "open")).toEqual([]);
    expect(st.needsYou).toBe(0);
    expect((st.defects as { kind: string }[]).map((d) => d.kind)).toEqual(["free_text"]);
  });
});

/** Live 2026-10-24 false positives: the owner steps that come later (whatgpt S4, memory ZAL-A1), a parked one. */
const LATER = (a0: string) => `# PLAN-3: Launch

Spine ID: PLAN-3

## Current State

Status: active
Waiting on: none

## Issue Ledger

| Issue | Role | Owner | Title | Status | Depends On | Next Action |
|---|---|---|---|---|---|---|
| A0 | Worker | worker | ZAL-A0 · pipeline green | ${a0} | none | build |
| A1 | Tester | Sam | ZAL-A1 · Sam's voice test | draft | A0 | Ask Sam once A0 is green. |
| S3 | Worker | worker | S3 images | active | none | build |
| S4 | Sam | Sam (later) | S4 launch walk on a real phone | draft | S3 | after S3 |
| VH-T7 | Ops | Sam | pg1 backup or confirm regenerable | deferred (parked 2026-10-12) | none | after stability |
`;

describe("T13-S4 later steps are Coming up, not counted (root L-13)", () => {
  it("a Sam row depending on an open sibling, an owner 'Sam (later)' and a deferred row: 0 open items", async () => {
    const { m, get } = setup({ "docs/spines/epic-3.md": LATER("active") }, "docs/spines/epic-3.md", "Acme/memo");
    const st = await get(`/api/milestones/${m.id}/status`);
    expect(st.needsYou).toBe(0);
    const waiting = (await get(`/api/waiting-on-owner?milestoneId=${m.id}`)) as { title: string; gate?: string; gateReason?: string }[];
    expect(waiting.map((w) => [w.title.split(" ")[0], w.gate, w.gateReason]).sort()).toEqual([
      ["A1", "future", "after A0 (not done)"],
      ["S4", "future", "later"],
    ]);
  });

  it("once the sibling is done, the Sam row (no coded ask) is a defect for the owner now, still no item (T13-S14)", async () => {
    const { m, get } = setup({ "docs/spines/epic-3.md": LATER("done") }, "docs/spines/epic-3.md", "Acme/memo");
    const st = await get(`/api/milestones/${m.id}/status`);
    expect(st.needsYou).toBe(0);
    expect((st.defects as { kind: string; text: string }[]).map((d) => [d.kind, d.text.replace(/:\d+ /, ":N ")])).toEqual([["free_text", "Sam named at docs/spines/epic-3.md:N with no ask: write a coded ask or drop the line"]]);
  });
});

describe("T13-S4 nothing open for Sam (ops PLAN-2)", () => {
  it("'nothing open for Sam' and a done Sam row → 0 open items, no red anywhere", async () => {
    const { m, get } = setup({ "docs/spines/epic-2.md": EPIC2 }, "docs/spines/epic-2.md", "Acme/ops");
    const st = await get(`/api/milestones/${m.id}/status`);
    const all = await get(`/api/status`);
    const t = await get(`/api/milestones/${m.id}/tree`);
    expect([st.needsYou, all.needsYou, t.counts.red]).toEqual([0, 0, 0]);
    expect((st.items as Item[]).filter((i) => i.state === "open")).toEqual([]);
    expect(st.flow.word).not.toBe("needs_you");
    walk(t.root, (n) => expect(n.color).not.toBe("red"));
  });
});

describe("T13-S4 helpers", () => {
  const n = (over: Partial<TreeNode>): TreeNode => ({ key: "k", id: "draft", kind: "ticket", title: "", status: "draft", color: "grey", children: [], flags: [], ...over });
  it("owner Sam first, open status", () => {
    expect(ownedByJordi("Sam")).toBe(true);
    expect(ownedByJordi("@Sam (Mac)")).toBe(true);
    expect(ownedByJordi("Delivery manager → Sam")).toBe(false);
    expect(openForJordi(n({ owner: "Sam" }))).toBe(true);
    expect(openForJordi(n({ owner: "Sam", status: "done", color: "green" }))).toBe(false);
    expect(openForJordi(n({ owner: "Sam", status: "superseded by T0-A5" }))).toBe(false);
    expect(openForJordi(n({ owner: "Author" }))).toBe(false);
  });
  it("row label from the Issue cell, else the title's leading id; Waiting on cites rows", () => {
    expect(rowLabel(n({ id: "S5", title: "Memory limit" }))).toBe("S5");
    expect(rowLabel(n({ title: "T0-S2 Which accounts?" }))).toBe("T0-S2");
    expect(rowTitle(n({ title: "T0-S2 Which accounts?" }))).toBe("T0-S2 Which accounts?");
    expect(rowLabel(n({ title: "Which accounts?" }))).toBeUndefined();
    expect(citesRows(MEMO_WAITING, ["T0-S4"])).toBe(true);
    expect(citesRows("Sam T0-S21", ["T0-S2"])).toBe(false);
  });
});
