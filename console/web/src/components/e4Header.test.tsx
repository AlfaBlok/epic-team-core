// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type MilestoneStatusView, type WaitingItem } from "@/api";
import { asksPhrase, MilestoneStrip } from "@/components/status";
import { WaitingOnYou } from "@/components/waiting";

/**
 * an agent-written Verdict + "the owner: verify the Outcome" + an answered persona request.
 * Header = "Needs you · 1 to mark"; the Waiting tab's open section = the status's open items (same ids, same count);
 * the answered request only under a collapsed Answered, marked answered (who / when), never an open decision card.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-10-25T12:00:00Z");
const E4_STATUS: MilestoneStatusView = {
  milestoneId: "ms_e4",
  outcome: { word: "ready_to_mark", source: "derived", note: "Verdict written by an agent, not marked by Sam" },
  flow: { word: "needs_you", reason: "1 to mark" },
  items: [{ id: "ready_to_mark:ms_e4", kind: "ready_to_mark", state: "open", milestoneId: "ms_e4", title: "Review and mark the outcome: Verdict written by an agent, not marked by Sam" }],
  needsYou: 1,
  reasons: ["1 to mark"],
};
const base = { milestoneId: "ms_e4", milestoneTitle: "E904", contextLinks: [], owner: { kind: "none" as const, label: "" }, decidable: false };
// The free-text line the server folded into Ready to mark (still in the waiting list as a guess).
const VERIFY: WaitingItem = {
  ...base, id: "wj_8de1b672755f63b8", source: "heuristic", signal: "waiting_on", state: "open", nodeKey: "ms_e4", path: "docs/one-logger/E904-ONE-LOGGER.md", line: 5,
  spine: { path: "docs/one-logger/E904-ONE-LOGGER.md", title: "E904: One logger" }, title: "E904: One logger", ask: "unknown", question: "verify the Outcome and set Status done",
} as WaitingItem;
// The persona request the owner approved; its run has acted on it since.
const RESTORE: WaitingItem = {
  ...base, id: "nj_2a1cbdff", source: "needs_jordi", state: "answered", nodeKey: "ms_e4", ask: "approve", answer: "approved", consumedAt: "2026-10-25T11:00:00Z",
  title: "Approve: Restore the stored settings (env) of the idle Deployer app ideascraper", question: "Approve: Restore the stored settings (env) of the idle Deployer app ideascraper?",
  response: { id: "jr_1", itemId: "nj_2a1cbdff", kind: "approve", text: "", delivery: "sent", createdAt: "2026-10-25T10:00:00Z" },
} as WaitingItem;

describe("T13-S10 E904 header", () => {
  it("counts by kind: Needs you · 1 to mark, never '1 question'", () => {
    render(
      <MemoryRouter>
        <MilestoneStrip status={E4_STATUS} now={NOW} timeZone="UTC" />
      </MemoryRouter>,
    );
    const strip = screen.getByTestId("state-strip");
    expect(strip.textContent).toContain("Needs you· 1 · 1 to mark");
    expect(strip.textContent).not.toMatch(/question/);
    expect(screen.getByTestId("review-and-mark")).toBeTruthy();
    expect(asksPhrase([{ kind: "ready_to_mark" }, { kind: "needs_jordi", ask: "approve" }, { kind: "free_text_ask", ask: "unknown" }])).toBe("1 to mark, 1 approval, 1 question");
  });
});

describe("T13-S10 E904 Waiting on you tab", () => {
  it("open section = the status's 1 item (ready_to_mark); the answered request only under Answered, collapsed", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([VERIFY, RESTORE]);
    vi.spyOn(api, "getMilestoneStatus").mockResolvedValue(E4_STATUS);
    render(
      <MemoryRouter>
        <WaitingOnYou milestoneId="ms_e4" />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId("status-item");
    expect(row.dataset.kind).toBe("ready_to_mark");
    expect(within(row).getByRole("link", { name: "Review and mark" })).toBeTruthy();
    expect(screen.getByTestId("waiting-on-you-count").textContent).toBe("1");
    // No open decision card, no guessed "question" card for the folded verify line.
    expect(screen.queryAllByTestId("waiting-card")).toHaveLength(0);
    expect(screen.queryAllByTestId("guessed-card")).toHaveLength(0);
    expect(screen.queryAllByTestId("blocking-now")).toHaveLength(0);
    const answered = screen.getByTestId("answered-section");
    expect(answered.textContent?.trim()).toBe("Answered1"); // folded = one line
    fireEvent.click(within(answered).getByTestId("answered-section-toggle"));
    const line = within(answered).getByTestId("answered-row");
    expect(line.textContent).toContain("Restore the stored settings");
    expect(line.textContent).toMatch(/answered by Sam .*ago/);
    expect(line.textContent).toContain("answered, done");
    // Clicked, it is the read-only answered card, never answer controls.
    fireEvent.click(within(line).getByRole("button"));
    const card = within(answered).getByTestId("waiting-card");
    expect(within(card).queryByRole("button", { name: /^Approve$/ })).toBeNull();
  });
});

describe("Answered order", () => {
  it("lists the most recent answer first, whether its work is pending or done", async () => {
    const OLD_PENDING: WaitingItem = {
      ...RESTORE, id: "nj_old", state: "answered", consumedAt: undefined, question: "Old pending ask?",
      response: { ...RESTORE.response!, id: "jr_old", itemId: "nj_old", createdAt: "2026-10-20T10:00:00Z" },
    } as WaitingItem;
    const NEW_DONE: WaitingItem = {
      ...RESTORE, id: "nj_new", question: "New done ask?",
      response: { ...RESTORE.response!, id: "jr_new", itemId: "nj_new", createdAt: "2026-10-25T11:59:00Z" },
    } as WaitingItem;
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([OLD_PENDING, RESTORE, NEW_DONE]);
    vi.spyOn(api, "getMilestoneStatus").mockResolvedValue(E4_STATUS);
    render(
      <MemoryRouter>
        <WaitingOnYou milestoneId="ms_e4" />
      </MemoryRouter>,
    );
    await screen.findByTestId("status-item");
    const answered = screen.getByTestId("answered-section");
    fireEvent.click(within(answered).getByTestId("answered-section-toggle"));
    const rows = within(answered).getAllByTestId("answered-row").map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("New done ask?");
    expect(rows[1]).toContain("Restore the stored settings");
    expect(rows[2]).toContain("Old pending ask?");
  });
});
