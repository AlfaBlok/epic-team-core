import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpinesJson } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { activeGrantsFor, GRANT_BRIEF_RULE, GRANT_USE_RULE, grantsSection } from "../src/cycle/grants.js";
import { WORKER_TIER_RULE, wakeProtocol } from "../src/cycle/prompts.js";
import { createCycle } from "../src/cycle/service.js";
import { ASK_LEAD_RULE, ASK_TIER_ITEMS, ASK_TYPE_RULES, ASK_WRITING_RULE, KICKOFF_RULE, isUnblocker, TIER_ASK } from "../src/inbox/asks.js";
import { createStore } from "../src/store.js";

/** asks written right at the source (root L-13/L-14); grants and the Unblocker in the prompts. */
const grant = (code: string, state: string, extra: Record<string, unknown> = {}) => ({
  code, who: "Sam", scope: `scope of ${code}`, limits: null, expires: null, context: null, since: "2026-10-24", state,
  revoked: null, why: null, source: "docs/PLAN-0-ROOT.md", inherited: false, uses: 0, ...extra,
});
const fixture: SpinesJson = {
  root: "docs/PLAN-0-ROOT.md",
  orphans: [],
  mismatches: [],
  nodes: [
    {
      id: "PLAN-0", path: "docs/PLAN-0-ROOT.md", title: "Root", parent: null, status: "active", rollup_status: "active", dod: [], children: [],
      grants: [
        grant("T0-G1", "active"),
        grant("T0-G2", "revoked"),
        grant("T0-G3", "expired", { expires: "2026-01-01" }),
        grant("T0-G7", "active", { limits: "EUR 25 per wave", expires: "2027-01-01", source: "docs/parent.md", inherited: true }),
      ],
    } as never,
    { id: "PLAN-1", path: "docs/e1.md", title: "E1", parent: "docs/PLAN-0-ROOT.md", status: "active", rollup_status: "active", dod: [], children: [] },
  ],
};

const protocol = (personaName: string, extra: Record<string, unknown> = {}) =>
  wakeProtocol({
    base: "http://c",
    run: { id: "run_1" },
    assignment: { id: "asg_1", writeEnabled: true, writeScope: "spine" },
    milestone: { id: "ms_1" },
    persona: { id: "p_1", name: personaName },
    ...extra,
  } as never);

describe("T8-S4 ask tier and ask-writing rules", () => {
  it("the tier names one-way doors and spend beyond a grant; the unrecorded preference is gone", () => {
    expect(ASK_TIER_ITEMS).toContain("a one-way door the goal and recorded answers do not settle");
    expect(ASK_TIER_ITEMS).toContain("money: spend beyond a standing approval or a limit recorded in the spine");
    expect(ASK_TIER_ITEMS).not.toContain("preference");
    expect(TIER_ASK).toContain(ASK_TIER_ITEMS);
  });

  it("L-13/L-14 writing rules reach every persona (ASK_TYPE_RULES) and every worker (WORKER_TIER_RULE)", () => {
    expect(ASK_WRITING_RULE).toContain("ask only for the step that blocks now, never a later step");
    expect(ASK_WRITING_RULE).toContain("Lead with the decision in plain words: what, why it matters, your recommendation");
    expect(ASK_WRITING_RULE).toContain("One decision per ask; never fold non-blocking extras into a blocking ask.");
    expect(ASK_TYPE_RULES).toContain(ASK_WRITING_RULE);
    // every persona's ask opens with one line by kind and a one-line why.
    expect(ASK_TYPE_RULES).toContain(ASK_LEAD_RULE);
    expect(ASK_LEAD_RULE).toContain("`You approve: <one thing>`, `You decide: <A or B>`, `You do: <one action>`");
    expect(ASK_LEAD_RULE).toContain("`Why: <one line>`");
    expect(WORKER_TIER_RULE).toContain(ASK_WRITING_RULE);
    const p = protocol("archivist");
    expect(p).toContain(ASK_WRITING_RULE);
    expect(p).toContain(WORKER_TIER_RULE);
  });
});

describe("T8-S4 grants in the wake", () => {
  it("activeGrantsFor keeps only active grants of the node, own then inherited", () => {
    const g = activeGrantsFor(fixture, "docs/PLAN-0-ROOT.md");
    expect(g.map((x) => x.code)).toEqual(["T0-G1", "T0-G7"]);
    expect(g[1]).toMatchObject({ source: "docs/parent.md", inherited: true, limits: "EUR 25 per wave", expires: "2027-01-01" });
    expect(activeGrantsFor(fixture, "docs/e1.md")).toEqual([]);
    expect(activeGrantsFor(fixture, "missing.md")).toEqual([]);
  });

  it("the protocol lists grants (code, scope, source) with the use rule and the brief rule", () => {
    const p = protocol("archivist", { grants: activeGrantsFor(fixture, "docs/PLAN-0-ROOT.md") });
    expect(p).toContain("F. Standing approvals in force");
    expect(p).toContain("- T0-G1: scope of T0-G1 — source: docs/PLAN-0-ROOT.md");
    expect(p).toContain("- T0-G7: scope of T0-G7 — limits: EUR 25 per wave — expires: 2027-01-01 — source: docs/parent.md");
    expect(p).not.toContain("T0-G2");
    expect(p).not.toContain("T0-G3");
    expect(p).toContain(GRANT_USE_RULE);
    expect(GRANT_USE_RULE).toContain("An action inside an active grant is not an ask: do it and cite `under <code>` in a Decisions row");
    expect(p).toContain(GRANT_BRIEF_RULE);
  });

  it("no grants → no section, no brief rule", () => {
    const p = protocol("archivist");
    expect(p).not.toContain("Standing approvals in force");
    expect(p).not.toContain(GRANT_BRIEF_RULE);
    expect(grantsSection([])).toEqual([]);
  });

  it("kickoff look-ahead: a Delivery Manager without grants proposes one bundled approve ask; with grants it does not", () => {
    expect(protocol("Delivery Manager")).toContain(KICKOFF_RULE);
    expect(KICKOFF_RULE).toContain("ONE `approve` ask");
    expect(KICKOFF_RULE).toContain("accounts, infra it owns, spend or test-only side effects");
    expect(protocol("Delivery Manager", { grants: [{ code: "T0-G1", scope: "s", source: "x.md" }] })).not.toContain(KICKOFF_RULE);
    expect(protocol("archivist")).not.toContain(KICKOFF_RULE);
  });
});

describe("T8-S4 Unblocker", () => {
  it("is matched by name", () => {
    expect(isUnblocker("Unblocker")).toBe(true);
    expect(isUnblocker("the unblocker v2")).toBe(true);
    expect(isUnblocker("Delivery Manager")).toBe(false);
    expect(isUnblocker(undefined)).toBe(false);
  });

  it("its wake carries the answering rules and no ask-raising duty except SPLIT remainders", () => {
    const p = protocol("Unblocker", { managerAssignmentId: "asg_dm" });
    expect(p).toContain("   Unblocker: you only ANSWER open asks");
    expect(p).toContain("never rewrite or rephrase an ask");
    expect(p).toContain("C. You raise no ask of your own (see U), except the remainder of a SPLIT");
    expect(p).not.toContain("C. Drive to green; ask Sam only in the ask tier");
    expect(p).toContain("ANSWER when the score is at least 75, no factor is below 1, and the ask is outside the hard floor"); // rubric (was: 75% confident)
    expect(p).toContain("[answered <CODE> <YYYY-MM-DD> @Unblocker]");
    expect(p).toContain("curl -sS -X POST 'http://c/api/assignments/asg_dm/run-now'");
    expect(p).not.toContain("G. Delivery Manager triage");
    expect(protocol("Unblocker")).toContain("no switched-on Delivery Manager assignment: wake no one");
    expect(protocol("Delivery Manager")).not.toContain("U. Read this whole prompt");
  });
});

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("T8-S4 wake wiring", () => {
  it("the cycle lists the milestone's grants and finds the switched-on Delivery Manager for an Unblocker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s4-"));
    const db: DB = openDb(path.join(dir, "c.db"));
    const store = createStore(db);
    const cycle = createCycle(db, store, {
      enabled: true,
      publicUrl: "http://x",
      grants: async () => activeGrantsFor(fixture, "docs/PLAN-0-ROOT.md"),
    });
    cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    const m = store.createMilestone({ title: "M", repo: "/r", path: "", owner: "", paused: false });
    const persona = (name: string) => store.createPersona({ name, remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
    const assign = (pid: string, enabled: boolean) =>
      store.createAssignment({ milestoneId: m.id, personaId: pid, cadence: { type: "interval", everyMinutes: 240 }, enabled });
    const ub = assign(persona("Unblocker").id, true);
    let w = await cycle.wake(ub.id);
    expect(w.prompt).toContain("- T0-G1: scope of T0-G1");
    expect(w.prompt).toContain("no switched-on Delivery Manager assignment");
    const dm = assign(persona("Delivery Manager").id, true);
    store.updateRun(w.run!.id, { outcome: "idle", endedAt: new Date().toISOString() });
    w = await cycle.wake(ub.id);
    expect(w.prompt).toContain(`/api/assignments/${dm.id}/run-now`);
  });
});
