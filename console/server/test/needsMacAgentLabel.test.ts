import { describe, expect, it } from "vitest";
import { fromSpinesEntry, parseAsks, unglueLabel, unglueSnooze } from "../src/inbox/asks.js";
import { pendingItems } from "../src/status/compute.js";
import type { WaitingItem } from "../src/inbox/waiting.js";

/**
 * work that needs his laptop carries one label, `needs Mac agent`: on a row it is the Role
 * `Mac agent` (never ready for a server worker, e14s9), on an ask the field `— label: needs Mac agent`. Such an ask stays
 * open in its spine but leaves the inbox count for the Mac list, where he runs every ticket in one sitting.
 */
const LINE =
  "- [ask T81-A6: do @Sam since 2026-11-09 row T81-S6] http://worker.tail.example:9196/t/T81-S6/ : paste this command in Claude on your Mac — context: Stripe — recommend: run it — unblocks: T81-S6 — label: needs Mac agent";

describe("T96-S5 the needs Mac agent label on an ask", () => {
  it("the markdown line: macAgent set, the field never glued to the others", () => {
    const [a] = parseAsks(`## Waiting on\n\n${LINE}\n- [ask T81-A7: do @Sam since 2026-11-09 row T81-S7] plain — unblocks: T81-S7\n`);
    expect(a.code).toBe("T81-A6");
    expect(a.macAgent).toBe(true);
    expect(a.unblocks).toBe("T81-S6");
    const [, b] = parseAsks(`## Waiting on\n\n${LINE}\n- [ask T81-A7: do @Sam since 2026-11-09 row T81-S7] plain — unblocks: T81-S7\n`);
    expect(b.macAgent).toBeUndefined();
  });

  it("spines.py glues it to the field before it (as it does a snooze): taken off, ask marked", () => {
    const glued = fromSpinesEntry({ code: "T81-A6", who: "Sam", ask: "do", question: "paste this", unblocks: "T81-S6 — label: needs Mac agent — snoozed until: 2026-12-01", state: "open" })!;
    const a = unglueLabel(unglueSnooze(glued));
    expect(a.unblocks).toBe("T81-S6");
    expect(a.macAgent).toBe(true);
    expect(unglueLabel(fromSpinesEntry({ code: "T1-A1", who: "Sam", ask: "do", question: "q", unblocks: "T1-S1 — label: something else", state: "open" })!).macAgent).toBeUndefined();
  });

  it("a question that starts with needs Mac agent counts too (the first form other worlds wrote)", () => {
    const [a] = parseAsks("## Waiting on\n\n- [ask TAX-A10: provide @Sam since 2026-11-10 row R1] needs Mac agent (a dashboard key) — bootstrap: claude --chrome \"open it\" — unblocks: R1\n");
    expect(a.macAgent).toBe(true);
    expect(unglueLabel(fromSpinesEntry({ code: "TAX-A10", who: "Sam", ask: "provide", question: "Needs Mac agent: a key", state: "open" })!).macAgent).toBe(true);
  });

  it("not pending: no count, no card (the inbox folds it under Needs Mac agent)", () => {
    const item = (id: string, over: Partial<WaitingItem> = {}) =>
      ({ id, source: "ask", state: "open", ask: "do", question: id, milestoneId: "ms_1", milestoneTitle: "m", repo: "home_repo", code: id, ...over }) as unknown as WaitingItem;
    const ids = pendingItems([item("T1-A1"), item("T1-A2", { macAgent: true })]).map((p) => p.id);
    expect(ids).toEqual(["T1-A1"]);
  });
});
