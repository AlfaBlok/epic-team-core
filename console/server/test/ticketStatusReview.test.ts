import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeStatus } from "../src/adapters/doc.js";
import { backlogFor } from "../src/adapters/milestone.js";
import { statusWordOf } from "../src/adapters/tree.js";
import { makeFixtureRoot } from "./fixtures.js";

// A ticket's own `Status: review` line, under a ledger row with no Status
// cell, showed as "no status" on the tree because doc.ts knew no review word. tree.ts already reads review as active.
let fx: ReturnType<typeof makeFixtureRoot>;
beforeEach(() => {
  fx = makeFixtureRoot();
});
afterEach(() => fx.cleanup());

describe("review, testing and verifying are active statuses", () => {
  it("normalizeStatus keeps the word as detail under the active group", () => {
    expect(normalizeStatus("review")).toEqual({ status: "active", statusDetail: "review" });
    expect(normalizeStatus("testing")).toEqual({ status: "active", statusDetail: "testing" });
    expect(normalizeStatus("verifying on host1")).toEqual({ status: "active", statusDetail: "verifying on host1" });
  });

  it("a ticket line 'Status: review' reaches the tree as review (blue), not as no status", () => {
    fx.write("ops/tickets/E905-fleet-observatory.md", "# E5: Fleet Observatory\n\nTicket ID: E5\nStatus: review\nOwner: worker\n");
    const b = backlogFor(fx.root, { id: "ms_1", repo: "ops", path: "docs/EPIC-900-VPS-FLEET.md", paused: false });
    const e5 = b.find((t) => t.id === "E5")!;
    expect(e5).toMatchObject({ status: "active", statusDetail: "review" });
    const raw = e5.status === "—" ? e5.statusDetail : e5.statusDetail ?? e5.status;
    expect(raw).toBe("review");
    expect(statusWordOf(raw!)).toBe("active");
  });
});
