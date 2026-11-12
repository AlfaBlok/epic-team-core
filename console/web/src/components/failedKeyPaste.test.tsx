// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { OwnerResponse, WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

/** a key paste that was not stored leaves the ask open with its key box and the reason, and no Retry. */

afterEach(cleanup);

const reason = "key not stored: secret: no Deployer application/compose named social; the ask is open again";
const failed = {
  id: "jr_7901041c",
  itemId: "wj_a9",
  milestoneId: "ms_z",
  kind: "answer",
  text: "key provided in the console (stored with secret put, value never shown)",
  delivery: "failed",
  deliveryError: reason,
  createdAt: "2026-10-25T05:28:52.246Z",
  spine: { status: "failed", reason },
} as unknown as OwnerResponse;

const item = { id: "wj_a9", source: "ask", state: "open", who: "Sam", code: "PLAN-0-A9", milestoneId: "ms_z", milestoneTitle: "Memo social", path: "docs/spines/epic-900.md", title: "Composio key", ask: "provide", question: "Paste the Composio API key", secret: { app: "social", name: "COMPOSIO_API_KEY" }, contextLinks: [], owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" }, decidable: false, response: failed } as unknown as WaitingItem;

describe("T6-S30: failed key paste", () => {
  it("shows the key box again, the reason, and no Retry button", () => {
    render(<MemoryRouter><WaitingCard item={item} /></MemoryRouter>);
    expect(screen.getByTestId("secret-box")).toBeTruthy();
    expect(screen.getByTestId("answer-state").textContent).toContain(`The key was not stored: ${reason}. Paste it again below.`);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});
