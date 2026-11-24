// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem } from "@/api";
import { StatusItemRow } from "@/components/waiting";
import { sendFeedback } from "@/components/cardFeedback";

/**
 * the owner several times: "This card, I don't know exactly what it is to me and what I'm supposed
 * to reply to", and it refused his voice answer. The Ready to mark card asks one question and its first button answers it.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item: PendingItem = {
  id: "ready_to_mark:ms_b964026f-8161-45d6-bbad-90ca476e075d",
  kind: "ready_to_mark",
  state: "open",
  milestoneId: "ms_b964026f-8161-45d6-bbad-90ca476e075d",
  title: "Is Market entry signals finished?",
  detail: "The team says it is: Buying on unusual market days shows no alpha over lump sum. All 7 checks are ticked. Yes closes it and its team stops. Not yet: say what is missing.",
  url: "http://results.example.com/index.html",
};

describe("the Ready to mark card answers its own question", () => {
  it("shows the question, what Yes does, Yes and the results; Yes marks it finished", async () => {
    const mark = vi.spyOn(api, "markMilestone").mockResolvedValue({ verdict: "accomplished" } as never);
    render(
      <MemoryRouter>
        <StatusItemRow item={item} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Is Market entry signals finished?")).toBeTruthy();
    expect(screen.getByText(/Yes closes it and its team stops/)).toBeTruthy();
    expect(screen.queryByText(/Review and mark/)).toBeNull();
    expect(screen.getByTestId("ready-to-mark-results").getAttribute("href")).toBe(item.url);
    fireEvent.click(screen.getByTestId("ready-to-mark-yes"));
    await waitFor(() => expect(mark).toHaveBeenCalledWith(item.milestoneId, { verdict: "accomplished" }));
  });

  it("his words on a card with a long title go with a message id under 120 characters", async () => {
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({} as never);
    const page = `card ${item.id}: Review and mark the outcome: every Done means is ticked and the evidence table is written`;
    await sendFeedback({ kind: "desk", page }, "I don't know what this card is", [], "voice");
    const id = send.mock.calls[0][2] as string;
    expect(id.length).toBeLessThanOrEqual(120);
    expect(id).toMatch(/^feedback:\d+:card /);
  });
});
