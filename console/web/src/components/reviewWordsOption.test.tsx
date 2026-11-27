// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CARD_TYPES } from "@/components/cardInventory";
import { resetSent } from "@/lib/sentRows";
import { api } from "@/api";

// (the owner 26 Nov 01:14Z, after pressing it: "the button no say what to cahgne didn't work"):
// a card option that asks for his words opens the card's words box, writes nothing, and the card stays open until he
// sends; his words then go to the team as changes wanted, with the option he chose.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  resetSent();
  vi.restoreAllMocks();
});

const card = CARD_TYPES.find((c) => c.id === "review-words-option")!;

describe("No: say what to change opens the box", () => {
  it("the press writes nothing and opens the words box; Send gives his words with the option", async () => {
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ state: "approved" } as never);
    const relaunch = vi.spyOn(api, "relaunchReviewItem").mockResolvedValue({ state: "active" } as never);
    const { container } = render(<MemoryRouter>{card.render()}</MemoryRouter>);
    const box = () => within(container).getByTestId("card-feedback");
    expect(box().dataset.open).toBe("no");
    const no = within(container).getAllByTestId("review-choice").find((b) => b.textContent?.trim() === "No: say what to change")!;
    expect(no.dataset.words).toBe("yes");
    fireEvent.click(no);
    // nothing written, the card still open, the box open and asking for his words
    expect(complete).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(within(container).queryByTestId("sent-row")).toBeNull();
    expect(box().dataset.open).toBe("yes");
    expect(box().textContent).toContain("You chose No: say what to change");
    // Send waits for words
    const send = within(container).getByTestId("card-feedback-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(box()).getByRole("textbox"), { target: { value: "we shouldn't create the server for the user" } });
    fireEvent.click(within(container).getByTestId("card-feedback-send"));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
    expect(relaunch.mock.calls[0][0]).toBe("sample_words_option");
    expect(relaunch.mock.calls[0][1]).toBe('You chose "No: say what to change": we shouldn\'t create the server for the user');
    expect(complete).not.toHaveBeenCalled();
    const row = await within(container).findByTestId("sent-row");
    expect(within(row).getByTestId("sent-row-said").textContent).toBe("No: say what to change");
  });

  it("Yes: keep it still closes the card at once", async () => {
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ state: "approved" } as never);
    const { container } = render(<MemoryRouter>{card.render()}</MemoryRouter>);
    const yes = within(container).getAllByTestId("review-choice").find((b) => b.textContent?.trim() === "Yes: keep it")!;
    expect(yes.dataset.words).toBeUndefined();
    fireEvent.click(yes);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0][1]).toMatchObject({ choice: "Yes: keep it" });
  });
});
