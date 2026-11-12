// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type OwnerResponse, type WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

/** the card shows a stored answer's steps (Saved → Written → Woken), a failed try and Retry, and stays up until written. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  code: "T42-A3",
  repo: "home_repo",
  milestoneId: "ms_1",
  milestoneTitle: "home_repo",
  nodeKey: "ms_1/x",
  path: "docs/spines/epic-42-talk-to-desk.md",
  title: "Credits",
  ask: "do",
  question: "Add $10 of credits?",
  contextLinks: [],
  owner: { kind: "assignment", assignmentId: "as_dm", personaName: "Delivery Manager", label: "Delivery Manager" },
  asker: { assignmentId: "as_dm", personaName: "Delivery Manager", via: "ask" },
  decidable: false,
  ...over,
});
const response = (over: Partial<OwnerResponse> = {}): OwnerResponse => ({
  id: "jr_1",
  itemId: "wj_1",
  milestoneId: "ms_1",
  kind: "answer",
  text: "I just added $10",
  delivery: "queued",
  createdAt: new Date().toISOString(),
  job: { state: "pending", attempts: 0 },
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
const step = (id: string) => screen.getByTestId(`answer-step-${id}`);

describe("T33-S9 answer progress on the card", () => {
  it("saved, writing: the first step is ticked, the spine write spins; no Retry, no answer box", () => {
    wrap(<WaitingCard item={item({ response: response() } as Partial<WaitingItem>)} />);
    expect(step("saved").textContent).toMatch(/^Saved .*“I just added \$10”/);
    expect(step("saved").dataset.done).toBe("true");
    expect(step("written").textContent).toBe("Writing to the spine…");
    expect(step("written").dataset.done).toBeUndefined();
    expect(step("woken").textContent).toBe("Waking Delivery Manager…");
    expect(screen.queryByText(/Retry/)).toBeNull();
    expect(screen.queryByTestId("answer-state")).toBeNull();
    // No second answer while the first is being written: no answer box, no option buttons, no Snooze.
    expect(screen.queryByPlaceholderText(/write your own answer/i)).toBeNull();
    expect(screen.queryByTestId("wake-toggle")).toBeNull();
    expect(screen.queryByText(/Snooze/)).toBeNull();
  });

  it("written, then woken: each step ticked with the commit and the run", () => {
    wrap(<WaitingCard item={item({ response: response({ delivery: "sent", spine: { status: "written", sha: "abc1234" }, job: { state: "running", attempts: 1 } }) } as Partial<WaitingItem>)} />);
    expect(step("written").textContent).toBe("Written to the spine in abc1234");
    expect(step("woken").textContent).toBe("Waking Delivery Manager…");
    cleanup();
    wrap(
      <WaitingCard
        item={item({ state: "answered", response: response({ delivery: "sent", spine: { status: "written", sha: "abc1234" }, wake: { notified: "woken", runId: "run_9", persona: "Delivery Manager" }, job: { state: "done", attempts: 1 } }) } as Partial<WaitingItem>)}
      />,
    );
    expect(screen.queryByTestId("answer-progress")).toBeNull(); // done: the usual answered card
    expect(screen.getByTestId("wake-note").textContent).toBe("Woken Delivery Manager (run run_9).");
  });

  it("a failed try says why and when it is tried again", () => {
    const nextAt = new Date(Date.now() + 30_000).toISOString();
    wrap(<WaitingCard item={item({ response: response({ job: { state: "pending", attempts: 1, error: "git push failed: cannot lock ref", nextAt } }) } as Partial<WaitingItem>)} />);
    expect(screen.getByTestId("answer-retrying").textContent).toMatch(/^Try 1 failed: git push failed: cannot lock ref\. Trying again/);
  });

  it("failed for good: the card stays open with the reason and Retry, which runs the job again", async () => {
    const spy = vi.spyOn(api, "redeliverResponse").mockResolvedValue(response({ job: { state: "pending", attempts: 0 } }));
    wrap(<WaitingCard item={item({ response: response({ delivery: "failed", spine: { status: "failed", reason: "git push failed: x" }, job: { state: "failed", attempts: 5, error: "git push failed: x" } }) } as Partial<WaitingItem>)} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/not written to the spine \(failed\): git push failed: x/);
    fireEvent.click(screen.getByRole("button", { name: /Retry spine write/ }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("jr_1"));
  });

  it("an item the job could not find: the reason from the job, with Retry delivery", () => {
    wrap(<WaitingCard item={item({ response: response({ job: { state: "failed", attempts: 1, error: "the ask x is not in the spine any more" } }) } as Partial<WaitingItem>)} />);
    expect(screen.getByTestId("answer-state").textContent).toMatch(/Not delivered: the ask x is not in the spine any more\./);
  });

  it("a stored answer from the click is held as working (no 'not delivered' error)", async () => {
    vi.spyOn(api, "respondToWaiting").mockResolvedValue(response());
    wrap(<WaitingCard item={item({ ask: "decide", options: ["yes", "no"] })} />);
    // options are a radio list (the first pre-picked) sent with Send my pick
    fireEvent.click(screen.getByTestId("send-pick"));
    await vi.waitFor(() => expect(api.respondToWaiting).toHaveBeenCalledWith("wj_1", expect.objectContaining({ kind: "answer", text: "yes" })));
    expect(screen.queryByText(/not delivered/i)).toBeNull();
  });
});
