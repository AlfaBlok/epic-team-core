// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import type { CardFace } from "@/api/review-types";
import { PRESS, pressProps } from "@/components/cardActions";
import { WaitingForReview } from "@/components/review";
import { resetReviewGone } from "@/lib/inbox";
import { landed } from "@/lib/press";

/**
 * the pressed button spins with "Sending…" in the same frame as the tap, the
 * card's other buttons wait, the button says "Saved ✓" once the console has the press (its 202) and the card leaves; a
 * failure gives the buttons back with the reason, and a press that fails for good after the card left brings it back.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetReviewGone();
});

const FACE: CardFace = {
  project: { name: "TEST Epic Team", url: "https://team.example.com/" },
  goal: { text: "We want to see a pressed button spin at once.", code: "PLAN-990" },
  tasks: { done: 0, total: 1 },
  title: "A test card was put up to try Mark complete.",
  taskGoal: "We want to see a pressed button spin at once.",
  delivered: [{ ok: true, text: "The test card is there to press." }],
  evidence: { url: "https://team.example.com/", label: "Open the test page" },
  screenshot: "docs/status/test.png",
  tree: [],
  after: "",
  next: [],
  closesGoal: false,
  openInGoal: [],
};
const ITEM: ReviewItem = {
  id: "rv_t",
  title: "TEST card",
  liveUrl: "https://team.example.com/",
  ref: "T990-B2",
  repo: "e67-feedback-test",
  path: "docs/spines/spinner-test.md",
  github: "Acme/e67-feedback-test",
  cardPath: "docs/cards/T990-B2.md",
  milestoneId: "ms_t",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-08T17:00:00Z",
  createdAt: "2026-11-08",
  verdict: { kind: "card" },
  face: FACE,
};
const mount = () => {
  vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
  return render(
    <MemoryRouter>
      <WaitingForReview fold="review" />
    </MemoryRouter>,
  );
};
/** A press the console saved (202 "landing"); `then` decides how it ends (the press worker's landing or its failure). */
const saved202 = (then: Promise<{ state: "landed" | "failed"; reason?: string }>) => () =>
  landed<ReviewItem>({ press: { id: "pr_1", state: "landing" } }, `/review-items/${ITEM.id}/complete`, async () => ({ id: "pr_1", ...(await then), response: ITEM }), (m) => new Error(m));
// the main button reads "Mark complete" (was "✓ Mark this task complete")
const MARK = "Mark complete";

describe("T72-S10 a pressed card button answers in the frame of the tap", () => {
  it("the pressed button spins with Sending… at once and the other buttons wait", async () => {
    mount();
    vi.spyOn(api, "completeReviewItem").mockReturnValue(new Promise(() => {}));
    const c = await screen.findByTestId("review-card");
    const mark = within(c).getByRole("button", { name: MARK });
    fireEvent.click(mark);
    // no await: this is the render of the tap itself
    expect(mark.textContent).toBe(PRESS.sending);
    expect(mark.getAttribute("aria-busy")).toBe("true");
    expect(mark.getAttribute("data-press")).toBe("sending");
    expect(within(mark).getByTestId("button-spinner")).toBeTruthy();
    expect((mark as HTMLButtonElement).disabled).toBe(true);
    // two buttons on the card (Mark complete, Not yet); Decline sits under More
    for (const id of ["review-iteration"]) {
      const b = within(c).getByTestId(id) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-busy")).toBeNull();
    }
  });

  it("on the 202 the button says Saved ✓, then the card slides away and leaves (it does not wait for the landing)", async () => {
    mount();
    const landing = new Promise<{ state: "landed" }>(() => {}); // the press worker has not written it yet
    vi.spyOn(api, "completeReviewItem").mockImplementation(saved202(landing));
    const c = await screen.findByTestId("review-card");
    fireEvent.click(within(c).getByRole("button", { name: MARK }));
    const savedBtn = await within(c).findByText(PRESS.saved);
    expect(savedBtn.closest("button")!.getAttribute("data-press")).toBe("saved");
    expect(screen.getByTestId("review-feed-item").style.opacity).toBe("");
    await waitFor(() => expect(screen.getByTestId("review-feed-item").style.opacity).toBe("0"), { timeout: PRESS.savedMs + 500 });
    await waitFor(() => expect(screen.queryByTestId("review-card")).toBeNull(), { timeout: 1500 });
  });

  it("a refused press gives the buttons back with the reason next to them", async () => {
    mount();
    vi.spyOn(api, "completeReviewItem").mockRejectedValue(new Error("spine write failed: push rejected"));
    const c = await screen.findByTestId("review-card");
    fireEvent.click(within(c).getByRole("button", { name: MARK }));
    const err = await within(c).findByTestId("review-error");
    expect(err.textContent).toContain("spine write failed: push rejected");
    const mark = within(c).getByRole("button", { name: MARK }) as HTMLButtonElement;
    expect(mark.disabled).toBe(false);
    expect(mark.getAttribute("aria-busy")).toBeNull();
    expect((within(c).getByTestId("review-iteration") as HTMLButtonElement).disabled).toBe(false);
    expect(within(c).queryByTestId("button-spinner")).toBeNull();
  });

  it("a press that fails for good after the card left brings the card back, saying why", async () => {
    mount();
    let fail!: (v: { state: "failed"; reason: string }) => void;
    vi.spyOn(api, "completeReviewItem").mockImplementation(saved202(new Promise((r) => (fail = r))));
    const c = await screen.findByTestId("review-card");
    fireEvent.click(within(c).getByRole("button", { name: MARK }));
    await waitFor(() => expect(screen.queryByTestId("review-card")).toBeNull(), { timeout: PRESS.savedMs + 1500 });
    fail({ state: "failed", reason: "the row is not in review any more" });
    // landed asks again 700 ms after the 202
    const back = await screen.findByTestId("review-card", {}, { timeout: 4000 });
    expect(within(back).getByTestId("review-error").textContent).toContain("It was not written: the row is not in review any more. Press again.");
    expect((within(back).getByRole("button", { name: MARK }) as HTMLButtonElement).disabled).toBe(false);
  }, 10_000);

  it("Not yet (was Changes wanted) and Decline: the pressed send button spins with Sending…", async () => {
    mount();
    vi.spyOn(api, "relaunchReviewItem").mockReturnValue(new Promise(() => {}));
    const c = await screen.findByTestId("review-card");
    // Not yet's first press opens the note, its next press sends the words
    fireEvent.click(within(c).getByTestId("review-iteration"));
    fireEvent.change(within(c).getByLabelText("Your note"), { target: { value: "TEST words" } });
    const send = within(c).getByTestId("review-iteration");
    fireEvent.click(send);
    expect(send.textContent).toBe(PRESS.sending);
    expect(within(send).getByTestId("button-spinner")).toBeTruthy();
    cleanup();

    mount();
    vi.spyOn(api, "denyReviewItem").mockReturnValue(new Promise(() => {}));
    const d = await screen.findByTestId("review-card");
    // Decline lives under More (the heading opens it)
    fireEvent.click(within(d).getByTestId("review-title"));
    fireEvent.click(within(d).getByTestId("review-deny"));
    const confirm = within(d).getByTestId("review-deny-confirm");
    fireEvent.click(confirm);
    expect(confirm.textContent).toBe(PRESS.sending);
    expect(within(confirm).getByTestId("button-spinner")).toBeTruthy();
  });

  it("after the card left, a line says it is being written (seconds counting), then Done with how long it took", async () => {
    mount();
    let land!: (v: { state: "landed" }) => void;
    vi.spyOn(api, "completeReviewItem").mockImplementation(saved202(new Promise((r) => (land = r))));
    const c = await screen.findByTestId("review-card");
    fireEvent.click(within(c).getByRole("button", { name: MARK }));
    const line = await screen.findByTestId("press-progress-line");
    expect(line.getAttribute("data-state")).toBe("writing");
    expect(line.textContent).toContain(PRESS.writing);
    expect(line.textContent).toContain(FACE.title);
    await waitFor(() => expect(screen.queryByTestId("review-card")).toBeNull(), { timeout: PRESS.savedMs + 1500 });
    // the line stays while the card is gone
    expect(screen.getByTestId("press-progress-line").getAttribute("data-state")).toBe("writing");
    land({ state: "landed" });
    await waitFor(() => expect(screen.getByTestId("press-progress-line").getAttribute("data-state")).toBe("done"), { timeout: 3000 });
    expect(screen.getByTestId("press-progress-line").textContent).toMatch(/Done ✓ It is in the project in \d+\.\d s\./);
  }, 10_000);

  it("pressProps: only the pressed key spins or says Saved; every button waits while a press runs", () => {
    expect(pressProps(undefined, "a")).toMatchObject({ pending: false, saved: false, disabled: false });
    expect(pressProps(undefined, "a", true).disabled).toBe(true);
    expect(pressProps({ key: "a", phase: "sending" }, "a")).toMatchObject({ pending: true, saved: false, disabled: true });
    expect(pressProps({ key: "a", phase: "sending" }, "b")).toMatchObject({ pending: false, saved: false, disabled: true });
    expect(pressProps({ key: "a", phase: "saved" }, "a")).toMatchObject({ pending: false, saved: true, disabled: true });
  });
});
