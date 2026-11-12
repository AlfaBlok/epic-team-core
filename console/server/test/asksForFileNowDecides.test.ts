import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asksFor } from "../src/inbox/asks.js";
import type { SpinesJson } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createRefresher } from "../src/readModel/refresher.js";
import { keyOf } from "../src/readModel/views.js";
import { readPayload } from "../src/readModel/table.js";
import type { WaitingItem } from "../src/inbox/waiting.js";

/**
 * Two causes, both in how the console reads a spine:
 *  - an ask's open or answered state came from the spines.py output, which on the main server can be minutes old and, for
 *    a social world repo, was never renewed (every run timed out at 90 s, the last good output kept): the status said open, the
 *    card list (with his answer) said answered, so the ask showed as a row with no button and was counted;
 *  - after his press (the console's own write) no view of that repo was rebuilt until its queued spines.py run landed.
 */

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e48s46-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const OPEN = (code: string, q: string) => `- [ask ${code}: decide @Sam since 2026-11-10] ${q} — options: yes | no — recommend: yes`;
const ANSWERED = (code: string, q: string) => `- [answered ${code} 2026-11-11 @Sam] ${q}`;
const SPINE = (...lines: string[]) => `# PLAN-0: Social\nSpine ID: PLAN-0\n\n## Current State\n\nOwner: Delivery manager\nStatus: active\n\n## Waiting on\n\n${lines.join("\n")}\n`;
const entry = (code: string, question: string, state = "open") => ({ code, who: "Sam", ask: "decide", question, state });
const put = (text: string) => {
  const f = path.join(tmp, "docs", "spines", "root.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (spines: unknown[]) => asksFor(tmp, "docs/spines/root.md", spines);

describe("T48-S46 asksFor: the file as it is now decides open or answered", () => {
  it("answered in the file, open in an older spines.py output: answered", () => {
    put(SPINE(ANSWERED("PLAN-0-A20", "May we run the giveaway?"), OPEN("PLAN-0-A25", "Switch on the Publisher?")));
    const asks = read([entry("PLAN-0-A20", "May we run the giveaway?"), entry("PLAN-0-A25", "Switch on the Publisher?")]);
    expect(asks.map((a) => [a.code, a.state])).toEqual([
      ["PLAN-0-A20", "answered"],
      ["PLAN-0-A25", "open"],
    ]);
  });

  it("open again in the file (an answer undone): open, with no done mark from the older output", () => {
    put(SPINE(OPEN("PLAN-0-A20", "May we run the giveaway?")));
    const [a] = read([entry("PLAN-0-A20", "May we run the giveaway?", "done")]);
    expect(a).toMatchObject({ code: "PLAN-0-A20", state: "open" });
    expect(a.doneAt).toBeUndefined();
  });

  it("answered in the file only: the card carries the answer's date and words from the file", () => {
    put(SPINE(`${ANSWERED("PLAN-0-A23", "May we pay for Decodo?")} — answer: no, queue and send`));
    const [a] = read([{ ...entry("PLAN-0-A23", "May we pay for Decodo?"), since: "2026-11-10" }]);
    expect(a).toMatchObject({ code: "PLAN-0-A23", state: "answered", since: "2026-11-11", answer: "no, queue and send" });
  });

  it("an older output that agrees keeps its fields (no duplicate from the file)", () => {
    put(SPINE(OPEN("PLAN-0-A25", "Switch on the Publisher?")));
    const asks = read([{ ...entry("PLAN-0-A25", "Switch on the Publisher?"), options: ["yes", "no"], recommend: "yes" }]);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ code: "PLAN-0-A25", state: "open", recommend: "yes" });
  });
});

describe("T48-S46 refresher: an answer leaves the views at once, not after the queued spines.py run", () => {
  const dbs: DB[] = [];
  afterEach(() => dbs.splice(0).forEach((d) => d.close()));

  it("after the console's write, the status and the list drop the answered ask while the scan still runs", async () => {
    const root = path.join(tmp, "repos");
    const repo = path.join(root, "social");
    const spine = path.join(repo, "docs", "spines", "root.md");
    fs.mkdirSync(path.dirname(spine), { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/Acme/social.git\n`);
    const Q = "May we run the giveaway?";
    fs.writeFileSync(spine, SPINE(OPEN("PLAN-0-A20", Q)));
    const db = openDb(path.join(tmp, "c.db"));
    dbs.push(db);
    createStore(db).createMilestone({ title: "Social", repo: "Acme/social", path: "docs/spines/root.md", owner: "", paused: false });
    // spines.py: the first run answers at once (the ask open, as v2 `waiting_on`); later runs hang until released
    const node = (state: string) => ({ path: "docs/spines/root.md", title: "PLAN-0: Social", dod: [], children: [], waiting_on: [entry("PLAN-0-A20", Q, state)] });
    const out = (state: string) => ({ root: "docs/spines/root.md", nodes: [node(state)], orphans: [], mismatches: [] }) as unknown as SpinesJson;
    let runs = 0;
    let release: (v: SpinesJson) => void = () => {};
    const spines = async () => (++runs === 1 ? out("open") : new Promise<SpinesJson>((r) => (release = r)));
    const r = createRefresher({ db, reposRoot: root, worlds: ["home"], log: () => {}, spines });
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        await r.tick();
        await new Promise((res) => setTimeout(res, 10));
      }
    };
    const state = () => {
      const row = readPayload(db, keyOf({ kind: "waiting", world: "home", includeSettled: false }));
      return row ? (JSON.parse(row.payload) as { items: WaitingItem[] }).items.find((x) => x.code === "PLAN-0-A20")?.state : undefined;
    };
    const needsYou = () => {
      const row = readPayload(db, keyOf({ kind: "status", world: "home", includeSettled: false }));
      return row ? (JSON.parse(row.payload) as { needsYou: number | null }).needsYou : undefined;
    };
    await settle();
    expect(state()).toBe("open");
    expect(needsYou()).toBe(1);

    // the owner answers: the console writes the line and marks the checkout dirty; the new scan is slow (the main server under load)
    fs.writeFileSync(spine, SPINE(ANSWERED("PLAN-0-A20", Q)));
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(spine, t, t);
    r.dirty(repo);
    await settle();
    expect(runs).toBe(2); // the scan is running, not done
    expect(state()).toBe("answered");
    expect(needsYou()).toBe(0);

    // the scan lands with the same answer: the views stay right
    release(out("answered"));
    await settle();
    await r.idle();
    expect(state()).toBe("answered");
    expect(needsYou()).toBe(0);
    r.stop();
  });
});
