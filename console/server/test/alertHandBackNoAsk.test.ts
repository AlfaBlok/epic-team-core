import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { readInbox } from "../src/desk/inbox.js";
import type { SpineWriter } from "../src/inbox/spineWrite.js";
import { alarmAlerts, createAlertHandBack, handBackNote } from "../src/status/alertHandBack.js";
import { milestoneStatus, type PendingItem, type StatusInput } from "../src/status/compute.js";

/**
 * The owner, on a yellow Monitoring line in Blocked on you, its check a day overdue and no ask in it: "I can't take
 * action on it so what's it doing there?". A Monitoring item with no ask for him is the team's: never in his Blocked
 * on you, handed back once to its repo's desk, whose Delivery Manager asks him a real question or clears it.
 */

const NOW = Date.parse("2026-11-15T19:30:00Z");
const node = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", children, flags: [], ...over,
});
const tree: Tree = {
  milestoneId: "ms_bots", root: node("ms_bots", { kind: "spine", status: "active", color: "blue" }, [node("ms_bots/E907-S3")]),
  counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, source: "spines", warnings: [], asks: {},
};
const MARKET_BOTS = "E907-S3: sample buyer bot built and ready (bots/sample-agent: status, dry-run, test modes), results pending";
const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  milestone: { id: "ms_bots", paused: false }, status: "active", tree, waiting: [], runs: [], assignments: [], personaName: () => "Delivery Manager", now: NOW,
  monitoring: [{ what: MARKET_BOTS, nextCheckAt: "2026-11-14T15:00:00.000Z" }],
  ...over,
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const checkout = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "handback-"));
  dirs.push(d);
  return d;
};
/** a writer that runs the scaffold in the checkout itself (the real one clones, commits and pushes). */
const writer = (calls: string[]): Pick<SpineWriter, "scaffold"> => ({
  scaffold: async (o) => {
    calls.push(o.msg);
    const r = await o.scaffold(o.repoDir);
    return r.ok ? { status: "written", sha: "abc1234" } : { status: "skipped", reason: r.error };
  },
});

describe("a Monitoring item with no ask for the owner goes back to its team", () => {
  it("the bots line, a day overdue and naming no ask, is an alarm: not open, not counted in Blocked on you", () => {
    const st = milestoneStatus(input());
    const alerts = alarmAlerts(st.items);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("sample buyer bot");
    expect(st.items.filter((i) => i.state === "open")).toHaveLength(0);
    expect(st.needsYou).toBe(0);
  });

  it("drops one desk note in the Bots repo, once, whatever the number of passes", async () => {
    const dir = checkout();
    const items = milestoneStatus(input()).items;
    const calls: string[] = [];
    const hb = createAlertHandBack({
      items: async () => items,
      target: () => ({ world: "home", checkout: dir, replyTo: "acme/bots", policyPath: "docs/spines/root.md", milestoneTitle: "Bots" }),
      writer: writer(calls),
      now: () => NOW,
    });
    const first = await hb.tick();
    expect(first.map((r) => r.state)).toEqual(["handed"]);
    const notes = readInbox(dir);
    expect(notes).toHaveLength(1);
    const n = notes[0];
    expect(n.file).toMatch(/^desk\/inbox\/2026-11-15-console-alert-/);
    expect(n.status).toBe("open");
    expect(n.kind).toBe("monitor-alert");
    expect(n.alert).toBe(items[0].id);
    expect(n.replyTo).toBe("acme/bots");
    expect(n.about).toContain("check overdue");
    expect(n.body).toContain("write ONE real coded ask");
    expect(n.body).toContain("clear it");
    // the same process: not retried; a restarted console: the note already there
    expect(await hb.tick()).toEqual([]);
    const again = createAlertHandBack({ items: async () => items, target: () => ({ world: "home", checkout: dir, replyTo: "acme/bots", policyPath: "docs/spines/root.md", milestoneTitle: "Bots" }), writer: writer(calls) });
    expect((await again.tick()).map((r) => r.state)).toEqual(["already"]);
    expect(readInbox(dir)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("an answered hand-back note still counts as made (the Delivery Manager closed it): never a second note", async () => {
    const dir = checkout();
    const items = milestoneStatus(input()).items;
    const note = handBackNote({ world: "home", replyTo: "acme/bots", milestoneTitle: "Bots", alert: items[0], day: "2026-11-15" });
    fs.mkdirSync(path.join(dir, "desk/inbox"), { recursive: true });
    fs.writeFileSync(path.join(dir, note.rel), note.text.replace("status: open", "status: answered"));
    const calls: string[] = [];
    const hb = createAlertHandBack({ items: async () => items, target: () => ({ world: "home", checkout: dir, replyTo: "x/y", policyPath: "p", milestoneTitle: "Bots" }), writer: writer(calls) });
    expect((await hb.tick()).map((r) => r.state)).toEqual(["already"]);
    expect(calls).toHaveLength(0);
  });

  it("an alert that names an open ask for him stays his (counted, no hand-back); a snoozed one follows his snooze", async () => {
    const open = { id: "mon_a", kind: "monitor_alert", state: "open", milestoneId: "ms_bots", title: "Monitor alert: x" } as PendingItem;
    const snoozed = { ...open, id: "mon_b", state: "snoozed" } as PendingItem;
    expect(alarmAlerts([open, snoozed])).toEqual([]);
    const calls: string[] = [];
    const hb = createAlertHandBack({ items: async () => [open, snoozed], target: () => ({ world: "home", checkout: checkout(), replyTo: "x/y", policyPath: "p", milestoneTitle: "m" }), writer: writer(calls) });
    expect(await hb.tick()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("the other product the same: an alarm alert of a social world milestone goes to that world's repo, from that world", async () => {
    const dir = checkout();
    const social = { id: "mon_s", kind: "monitor_alert", state: "alarm", milestoneId: "ms_social", title: "Monitor alert: always-on Reddit stopped", monitor: { why: ["stop"], asks: [], next: "No ask named" } } as unknown as PendingItem;
    const hb = createAlertHandBack({
      items: async () => [social],
      target: (id) => (id === "ms_social" ? { world: "social", checkout: dir, replyTo: "acme/social", policyPath: "docs/spines/root.md", milestoneTitle: "Reddit" } : undefined),
      writer: writer([]),
      now: () => NOW,
    });
    expect((await hb.tick()).map((r) => r.state)).toEqual(["handed"]);
    const [n] = readInbox(dir);
    expect(n.from).toBe("social");
    expect(n.about).toContain("(stopped)");
  });
});
