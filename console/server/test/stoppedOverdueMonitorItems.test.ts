import { describe, expect, it } from "vitest";
import { parseMonitoring } from "../src/adapters/monitoring.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import type { LocatedAsk } from "../src/inbox/asks.js";
import type { Assignment, Milestone } from "../src/store.js";
import { milestoneStatus, type StatusInput } from "../src/status/compute.js";
import { askLookupIn, askRefs, monitorAlerts, monitorAlertSection, refKey, type ResolvedAsk } from "../src/status/monitorAlert.js";
import { STATE_RULE } from "../src/wakePrompt.js";

/** a monitor that sees something stopped is an alert in Waiting on you, not a blue Monitoring line. */

const NOW = Date.parse("2026-11-02T15:00:00Z");
const iso = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const node = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "ready", color: "grey", children, flags: [], ...over,
});
const tree = (id: string, asks: Record<string, LocatedAsk[]> = {}): Tree => ({
  milestoneId: id, root: node(id, { kind: "spine", status: "active", color: "blue" }, [node(`${id}/S1`, { ready: true })]),
  counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, source: "spines", warnings: [], asks,
});
const assignment: Assignment = {
  id: "a1", milestoneId: "zs", personaId: "p1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true, writeEnabled: false, writeScope: "", createdAt: iso(-100), nextRunAt: iso(1), nextWakeAt: iso(1),
};
const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  milestone: { id: "zs", paused: false }, status: "active", tree: tree("zs"), waiting: [], runs: [], assignments: [assignment], personaName: () => "Delivery Manager", now: NOW, ...over,
});

// a social world repo's line as the owner saw it on 2026-11-02 (the Reddit item since 2026-10-27, next check 2026-10-28).
const ZS_LINE =
  "laptop egress for Reddit DM sends since 2026-10-26T00:16Z · next check when it is back (console wakes on egress) · then the Responder sends the DM drafts ; " +
  "Reddit writing stopped after a 429 on `reddit_reply` since 2026-10-27T15:39Z until 2026-10-28T15:39Z · next check 2026-10-28T15:40Z Responder sends draft P-0042 if the thread is still live · then Reddit replies resume at the usual limits";

describe("E908-S35 (a) stopped or overdue monitor items are alerts", () => {
  it("social's stale 429 item is an alert item (age, overdue check); with no ask it is the DM's (E908-S36), not Needs you", () => {
    const st = milestoneStatus(input({ monitoring: parseMonitoring(ZS_LINE) }));
    expect(st.flow.word).not.toBe("needs_you");
    expect(st.needsYou).toBe(0);
    const [a] = st.items;
    expect(a.kind).toBe("monitor_alert");
    expect(a.state).toBe("alarm");
    expect(a.title).toBe("Monitor alert: Reddit writing stopped after a 429 on reddit_reply");
    expect(a.detail).toContain("since 2026-10-27 15:39Z (6 days)");
    expect(a.detail).toContain("next check (Responder sends draft P-0042 if the thread is still live) was due 2026-10-28 15:40Z, 5 days overdue");
    expect(a.monitor?.why).toEqual(["stop", "overdue"]);
    expect(a.monitor?.next).toMatch(/^No ask named: the Delivery Manager writes a coded ask/);
    // With an open ask named it is the owner's: counted.
    const open = milestoneStatus(input({ monitoring: parseMonitoring(ZS_LINE.replace("on `reddit_reply`", "on `reddit_reply`, waits on E946-A4")), monitorAsks: new Map([["/E946-A4", { code: "E946-A4", repo: "", state: "open" as const }]]) }));
    expect(open.flow.word).toBe("needs_you");
    expect(open.needsYou).toBe(1);
    expect(open.flow.reason).toBe("1 monitor alert");
  });

  it("a stop word alone (next check still ahead) is an alert", () => {
    const st = milestoneStatus(input({ monitoring: [{ what: "X replies held: laptop egress offline", since: iso(-3), nextCheckAt: iso(2) }] }));
    expect(st.items[0].kind).toBe("monitor_alert");
    expect(st.items[0].monitor?.why).toEqual(["stop"]);
  });

  it("a calm wait whose next check is more than a day overdue is an alert; less than a day is still monitoring", () => {
    const late = milestoneStatus(input({ monitoring: [{ what: "7-day hold on the archive", nextCheckAt: iso(-25) }] }));
    expect(late.items[0].kind).toBe("monitor_alert");
    expect(late.items[0].monitor?.why).toEqual(["overdue"]);
    const fresh = milestoneStatus(input({ monitoring: [{ what: "7-day hold on the archive", nextCheckAt: iso(-2) }] }));
    expect(fresh.flow.word).toBe("monitoring");
    expect(fresh.items).toEqual([]);
  });

  it("ordinary healthy monitoring stays blue Monitoring, no item", () => {
    const st = milestoneStatus(input({ monitoring: [{ what: "E946-A4/A5 snooze", since: iso(-6), until: iso(42), nextCheckAt: iso(18) }] }));
    expect(st.flow.word).toBe("monitoring");
    expect(st.needsYou).toBe(0);
  });

  it("the calm items of the same line still read monitoring behind the alert (they leave the alert out)", () => {
    const st = milestoneStatus(input({ milestone: { id: "zs", paused: false }, monitoring: [{ what: "Reddit logged out", nextCheckAt: iso(3) }, { what: "slot window", nextCheckAt: iso(5) }] }));
    expect(st.items.map((x) => x.kind)).toEqual(["monitor_alert"]);
  });
});

describe("E908-S35 (b) the alert links the ask that unblocks it", () => {
  const snoozed: ResolvedAsk = { code: "E946-A4", repo: "home_repo", state: "open", snoozedUntil: "2026-11-04", question: "Approve about $11/month for a Mexico proxy?", milestoneId: "e46", milestoneTitle: "EPIC-946", href: "https://team.example.com/milestones/e46?tab=waiting" };
  const line = "Reddit always-on writing stopped: waits on home_repo/E946-A4 since 2026-10-27T15:39Z · next check 2026-11-04T09:00Z E946-A4 answered";

  it("reads the qualified code from the item", () => {
    expect(askRefs(parseMonitoring(line)[0])).toEqual([{ repo: "home_repo", code: "E946-A4" }]);
    expect(askRefs({ what: "Reddit stopped (E946-A4/A5)" })).toEqual([{ code: "E946-A4" }]);
  });

  it("a snoozed ask shows on the alert with its link; the alert follows the snooze (E908-S36)", () => {
    const monitorAsks = new Map([[refKey({ repo: "home_repo", code: "E946-A4" }), snoozed]]);
    const st = milestoneStatus(input({ monitoring: parseMonitoring(line), monitorAsks }));
    expect(st.flow.word).not.toBe("needs_you");
    const a = st.items[0];
    expect(a.state).toBe("snoozed");
    expect(a.monitor?.asks).toEqual([snoozed]);
    expect(a.monitor?.next).toBe("Waits on home_repo/E946-A4, snoozed by you until 2026-11-04");
    expect(st.reasons.some((r) => r.includes("names no open ask"))).toBe(false);
  });

  it("an unknown code reads missing, and the Delivery Manager is told to write a coded ask", () => {
    const st = milestoneStatus(input({ monitoring: parseMonitoring(line) }));
    expect(st.items[0].monitor?.asks).toEqual([{ code: "E946-A4", repo: "home_repo", state: "missing" }]);
    expect(st.items[0].monitor?.next).toMatch(/No ask named/);
    expect(st.reasons).toContain("defect for the Delivery Manager: a stopped or overdue Monitoring item names no open ask: write a coded ask or clear the item");
  });

  it("askLookupIn finds the ask in another repo and world, snoozed, with an absolute link to that world's host", async () => {
    const ms: Milestone[] = [
      { id: "zs", title: "EPIC-900: Memo social presence", repo: "social", path: "docs/spines/root.md", owner: "", paused: false, createdAt: iso(-1000) },
      { id: "e46", title: "EPIC-946", repo: "/srv/agent/github/home_repo", path: "docs/spines/epic-946.md", owner: "", paused: false, createdAt: iso(-1000) },
    ];
    const worlds: Record<string, string> = { zs: "social", e46: "acme" };
    const askLine = { code: "E946-A4", question: "Mexico proxy?", state: "open", snoozedUntil: "2999-01-01", ask: "approve", options: [] } as unknown as LocatedAsk;
    const trees: Record<string, Tree> = { zs: tree("zs"), e46: tree("e46", { "docs/spines/epic-946.md": [askLine] }) };
    const lookup = askLookupIn({ listMilestones: () => ms, worldOfMilestone: (id) => worlds[id] }, async (m) => trees[m.id], (w) => (w === "acme" ? "https://team.example.com" : "https://social.example.com"));
    const got = await lookup(ms[0], [{ repo: "home_repo", code: "E946-A4" }]);
    expect(got.get(refKey({ repo: "home_repo", code: "E946-A4" }))).toMatchObject({
      code: "E946-A4", repo: "home_repo", state: "open", snoozedUntil: "2999-01-01", question: "Mexico proxy?", milestoneId: "e46", milestoneTitle: "EPIC-946", href: "https://team.example.com/milestones/e46?tab=waiting", world: "acme",
    });
    // Two the code repo milestones list it (the root's tree holds's asks too): the one whose own spine holds it wins.
    const root: Milestone = { ...ms[1], id: "root", title: "home_repo", path: "docs/spines/root.md" };
    const both = askLookupIn({ listMilestones: () => [ms[0], root, ms[1]], worldOfMilestone: (id) => worlds[id] ?? "acme" }, async (m) => (m.id === "root" ? tree("root", { "docs/spines/epic-946.md": [askLine] }) : trees[m.id]), () => "https://team.example.com");
    expect((await both(ms[0], [{ repo: "home_repo", code: "E946-A4" }])).get("home_repo/E946-A4")?.milestoneId).toBe("e46");
    // Same world: a console-relative link.
    const same = await askLookupIn({ listMilestones: () => ms, worldOfMilestone: () => "acme" }, async (m) => trees[m.id], () => "https://x")(ms[0], [{ repo: "home_repo", code: "E946-A4" }]);
    expect(same.get("home_repo/E946-A4")?.href).toBe("/milestones/e46?tab=waiting");
  });
});

describe("E908-S35 the Delivery Manager's rule", () => {
  it("the wake prompt's state rule says a stopped item is an alert, not monitoring", () => {
    expect(STATE_RULE).toContain("Monitor alert in Waiting on you");
    expect(STATE_RULE).toContain("write the coded ask that unblocks it");
  });
  it("the DM wake section lists each alert with what to do", () => {
    const alerts = monitorAlerts(parseMonitoring(ZS_LINE), NOW);
    const s = monitorAlertSection(alerts, NOW)!;
    expect(s).toContain("## Monitoring alerts");
    expect(s).toContain("- Reddit writing stopped after a 429 on reddit_reply — since 2026-10-27 15:39Z (6 days)");
    expect(s).toContain("rewrite or remove the item so it reads true");
    expect(monitorAlertSection([], NOW)).toBeUndefined();
  });
});
