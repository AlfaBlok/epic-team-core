// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type OwnerResponse, type WaitingItem } from "@/api";
import { SAVED_ANSWER, SAVED_HOLD_MS, SecretBox, WaitingCard } from "@/components/waiting";

/**
 * the clicked answer button keeps its colour with a spinner, and "Updating task…" ("Saving…") shows until the
 * card updates. The clicked button itself says "Sending…" (no second line under the buttons).
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  code: "T9-A1",
  milestoneId: "ms_1",
  milestoneTitle: "Inbox",
  nodeKey: "ms_1/T4",
  path: "docs/spines/root.md",
  title: "Ship it",
  ask: "approve",
  question: "Ship the logger today?",
  contextLinks: [],
  owner: { kind: "assignment", assignmentId: "as_b", personaName: "Builder", label: "Builder" },
  decidable: true,
  ...over,
});
const response = (over: Partial<OwnerResponse> = {}): OwnerResponse => ({
  id: "jr_1",
  itemId: "wj_1",
  milestoneId: "ms_1",
  kind: "approve",
  text: "",
  delivery: "sent",
  createdAt: new Date().toISOString(),
  spine: { status: "written", sha: "abc1234" },
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
/** A promise the test resolves by hand, so the in-flight state can be looked at. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
const btn = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("Approve shows it is working", () => {
  it("spinner in the clicked button (colour kept), others disabled, status line; held after the POST until the item changes", async () => {
    const d = deferred<OwnerResponse>();
    vi.spyOn(api, "respondToWaiting").mockReturnValue(d.promise);
    const { rerender } = wrap(<WaitingCard item={item()} />);
    expect(screen.queryByRole("status")).toBeNull();
    const approve = btn(/Yes: go ahead/);
    fireEvent.click(approve);
    expect(approve.textContent).toBe("Sending…");
    expect(approve.getAttribute("aria-busy")).toBe("true");
    expect(approve.className).toContain("disabled:opacity-100");
    expect(approve.querySelector('[data-testid="button-spinner"]')).not.toBeNull();
    expect(approve.querySelector(".animate-spin")).not.toBeNull();
    // the second button of an approve card is "No" (was Decline)
    const deny = btn(/^No: drop it$/);
    expect(deny.disabled).toBe(true);
    expect(deny.getAttribute("aria-busy")).toBeNull();
    expect(deny.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    // The POST resolves: the card says Saved at once (no spinner, no greyed buttons) while the old card is still on
    // screen; the controls wait for the refresh, so there is no second answer meanwhile.
    await act(async () => d.resolve(response()));
    expect(screen.getByRole("status").textContent).toBe(SAVED_ANSWER);
    expect(screen.queryByTestId("button-spinner")).toBeNull();
    expect(screen.queryByRole("button", { name: /Yes: go ahead/ })).toBeNull();

    // The refresh brings the answered item: the controls go, and so do the spinner and the line.
    rerender(<MemoryRouter><WaitingCard item={item({ state: "answered", response: response() })} /></MemoryRouter>);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("button-spinner")).toBeNull();
  });

  it("an error stops the spinner and shows as before", async () => {
    vi.spyOn(api, "respondToWaiting").mockRejectedValue(new Error("spine write failed: push rejected"));
    wrap(<WaitingCard item={item()} />);
    fireEvent.click(btn(/Yes: go ahead/));
    await vi.waitFor(() => expect(screen.getByText("spine write failed: push rejected")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("button-spinner")).toBeNull();
    expect(btn(/Yes: go ahead/).disabled).toBe(false);
  });

  it("a refresh that never changes the card releases it after SAVED_HOLD_MS (T72-S3: was 15 s)", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "respondToWaiting").mockResolvedValue(response());
    wrap(<WaitingCard item={item()} />);
    fireEvent.click(btn(/Yes: go ahead/));
    await act(async () => {});
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(SAVED_ANSWER);
    await act(async () => vi.advanceTimersByTime(SAVED_HOLD_MS + 1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(btn(/Yes: go ahead/).disabled).toBe(false);
  });
});

describe("Answer (free text) shows it is working", () => {
  it("the Answer button spins and says Sending… (T72-S10; T33-S9 Saving… line, was Updating task…)", async () => {
    const d = deferred<OwnerResponse>();
    const spy = vi.spyOn(api, "respondToWaiting").mockReturnValue(d.promise);
    // a question that needs words (not a yes/no "?") shows the "Your answer" box with one Answer button
    wrap(<WaitingCard item={item({ ask: "decide", decidable: false, options: undefined, question: "Say when to ship the logger." })} />);
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "wait a week" } });
    const answer = btn(/^\s*Send$/);
    fireEvent.click(answer);
    expect(spy).toHaveBeenCalledWith("wj_1", { kind: "answer", text: "wait a week", milestoneId: "ms_1", wake: true });
    expect(answer.textContent).toBe("Sending…");
    expect(answer.getAttribute("aria-busy")).toBe("true");
    expect(answer.className).toContain("disabled:opacity-100");
    expect(answer.querySelector('[data-testid="button-spinner"]')).not.toBeNull();
    await act(async () => d.resolve(response({ kind: "answer", text: "wait a week" })));
  });

  it("an option's own button gets the spinner too", async () => {
    // E948-S69: each option is its own button; the pressed one sends and spins
    const spy = vi.spyOn(api, "respondToWaiting").mockReturnValue(new Promise(() => {}));
    wrap(<WaitingCard item={item({ ask: "decide", decidable: false, options: ["one", "two"] })} />);
    const send = screen.getAllByTestId("ask-option")[1] as HTMLButtonElement;
    fireEvent.click(send);
    expect(spy).toHaveBeenCalledWith("wj_1", expect.objectContaining({ kind: "answer", text: "two" }));
    expect(send.textContent).toBe("Sending…");
    expect(send.querySelector(".animate-spin")).not.toBeNull();
    // E948-S60: no Not now; the feedback block's Send waits while the pick is sending
    const other = screen.getByTestId("card-feedback-send") as HTMLButtonElement;
    expect(other.querySelector(".animate-spin")).toBeNull();
    expect(other.disabled).toBe(true);
  });
});

describe("Save key shows it is working", () => {
  it("spinner in Save key and a Saving key… line", async () => {
    vi.spyOn(api, "saveKey").mockReturnValue(new Promise(() => {}));
    wrap(<SecretBox item={{ ...item({ ask: "provide" }), secret: { app: "whatgpt", name: "OPENAI_API_KEY" } }} />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "sk-test" } });
    fireEvent.click(btn(/Save key/));
    const save = btn(/Save key/);
    expect(save.getAttribute("aria-busy")).toBe("true");
    expect(save.className).toContain("disabled:opacity-100");
    expect(save.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Saving key…/);
  });
});
