// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { OwnerResponse, WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

/** an answer a PR policy kept out of the spine, whose asker has it, reads "delivered", never "queued" with Retry. */

afterEach(cleanup);

const reason = "Integration policy mentions a PR or CI (“main-direct via self-merged CI-gated PR”): the console does not push";
const item: WaitingItem = {
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  code: "PLAN-6-A1",
  milestoneId: "ms_1",
  milestoneTitle: "Memo",
  nodeKey: "ms_1",
  path: "docs/PLAN-6-HEALTH-DASHBOARD.md",
  title: "health",
  ask: "decide",
  question: "Should `health.memo.example.com` be public?",
  options: [],
  contextLinks: [],
  owner: { kind: "assignment", assignmentId: "as_h", personaName: "Epic Spine health", label: "Epic Spine health" },
  asker: { assignmentId: "as_h", personaName: "Epic Spine health", via: "owner" },
  decidable: false,
};
const response = (over: Partial<OwnerResponse>): OwnerResponse => ({
  id: "jr_1",
  itemId: "wj_1",
  milestoneId: "ms_1",
  kind: "answer",
  text: "no, internal only",
  delivery: "queued",
  deliveryError: reason,
  createdAt: new Date().toISOString(),
  spine: { status: "skipped", reason },
  wake: { notified: "woken", runId: "run_9", persona: "Epic Spine health" },
  ...over,
});
const wrap = (r: OwnerResponse) => render(<MemoryRouter><WaitingCard item={{ ...item, response: r }} /></MemoryRouter>);

describe("T6-S40 delivered, spine line pending in the repo's PR", () => {
  it("delivered: names the repo PR; T62-S4: not answered until the line is in the spine, so Retry stays (state lines are plain grey, no amber); the wake note says the asker writes it", () => {
    wrap(response({ delivery: "delivered", deliveryError: "delivered, spine line pending in memo PR" }));
    const state = screen.getByTestId("answer-state");
    expect(state.textContent).toContain("Delivered to the asker; spine line pending in memo PR (the console does not push there). Still open until that line is in the spine.");
    expect(state.textContent).not.toContain("Saved here, not written");
    expect(state.className).toContain("text-muted-foreground");
    expect(state.className).not.toContain("amber");
    expect(screen.getByRole("button", { name: /Retry spine write/ })).toBeTruthy();
    expect(screen.getByTestId("wake-note").textContent).toContain("It writes the answer into the spine itself");
  });

  it("still queued (asker not reached): not written, with Retry, as before (plain grey, was amber)", () => {
    wrap(response({ wake: { notified: "off", persona: "Epic Spine health" } }));
    expect(screen.getByTestId("answer-state").textContent).toContain("Saved here, not written to the spine (skipped)");
    expect(screen.getByTestId("answer-state").className).not.toContain("amber");
    expect(screen.getByRole("button", { name: /Retry spine write/ })).toBeTruthy();
  });
});
