// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type OwnerResponse, type WaitingItem } from "@/api";
import { FyiCard, WaitingCard, wakeLine } from "@/components/waiting";

/** the answer card shows "Wake <persona>" (ticked by default) and, after sending, what reached the asker. */

afterEach(() => {
  cleanup();
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
  title: "Logger",
  ask: "decide",
  question: "Ship with one logger or two?",
  options: ["one", "two"],
  contextLinks: [],
  owner: { kind: "assignment", assignmentId: "as_b", personaName: "Builder", label: "Builder" },
  asker: { assignmentId: "as_dm", personaName: "Delivery Manager", via: "ask" },
  decidable: false,
  ...over,
});
const response = (over: Partial<OwnerResponse> = {}): OwnerResponse => ({
  id: "jr_1",
  itemId: "wj_1",
  milestoneId: "ms_1",
  kind: "answer",
  text: "two",
  delivery: "sent",
  createdAt: new Date().toISOString(),
  spine: { status: "written", sha: "abc1234" },
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
const toggle = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("Wake <persona> checkbox", () => {
  // the ask card has no Wake checkbox any more; every answer wakes the asker (wake: true).
  it("the ask card always wakes the asker: no checkbox, the answer is sent with wake: true", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue(response());
    wrap(<WaitingCard item={item()} />);
    expect(screen.queryByTestId("wake-toggle")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "two" }));
    fireEvent.click(screen.getByTestId("send-pick"));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", { kind: "answer", text: "two", milestoneId: "ms_1", wake: true }));
  });

  // "unticked: the answer is only recorded (wake: false)" removed: the card's Wake checkbox is gone (wake is always true).

  it("no persona to wake: no checkbox", () => {
    wrap(<WaitingCard item={item({ asker: undefined })} />);
    expect(screen.queryByTestId("wake-toggle")).toBeNull();
  });

  it("Reverse on a persona decision carries the box too", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue(response());
    wrap(<FyiCard item={item({ state: "answered", decidedBy: "Unblocker", answer: "one", asker: { assignmentId: "as_b", personaName: "Builder", via: "owner" } })} />);
    expect(screen.getByTestId("wake-toggle").textContent).toMatch(/Wake Builder/);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: /Reverse/ }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", expect.objectContaining({ wake: false })));
  });
});

describe("result line after sending", () => {
  const card = (wake: OwnerResponse["wake"]) => {
    wrap(<WaitingCard item={item({ state: "answered", answer: "two", response: response({ wake }) })} />);
    return screen.getByTestId("wake-note").textContent;
  };
  it("woken / steered / not woken (why)", () => {
    expect(card({ notified: "woken", runId: "run_9", persona: "Delivery Manager" })).toBe("Woken Delivery Manager (run run_9).");
    cleanup();
    expect(card({ notified: "steered", runId: "run_9", mode: "steer", persona: "Delivery Manager" })).toBe("Steered Delivery Manager's running session.");
    cleanup();
    expect(card({ notified: "skipped", reason: "the milestone is paused", persona: "Delivery Manager" })).toBe(
      "Not woken: the milestone is paused; Delivery Manager reads the answer at its next wake.",
    );
  });
  it("wakeLine: queued steer, unticked, failed", () => {
    expect(wakeLine({ notified: "steered", mode: "auto", persona: "Builder" })).toBe("Steered Builder's running session (queued after its current turn).");
    expect(wakeLine({ notified: "off", persona: "Builder" })).toBe("Not woken (Wake was unticked); Builder reads the answer at its next wake.");
    expect(wakeLine({ notified: "failed", reason: "could not steer the running session: t3 down" })).toBe(
      "Not woken: could not steer the running session: t3 down; the asker reads the answer at its next wake.",
    );
  });
  it("T15-S3: queued while the asker's session starts", () => {
    expect(card({ notified: "queued", runId: "run_9", persona: "Delivery Manager" })).toBe("Queued for Delivery Manager: delivered as soon as its session starts.");
  });
  it("an answer from before T15-S1 shows no line", () => {
    wrap(<WaitingCard item={item({ state: "answered", answer: "two", response: response() })} />);
    expect(screen.queryByTestId("wake-note")).toBeNull();
  });
});

describe("T15-S5: a refused spine write", () => {
  const reason = "Integration policy is “pr-approval”, not main-direct: the answer needs a PR, the console does not push";
  const refused = (wake: OwnerResponse["wake"]) =>
    response({ delivery: "queued", deliveryError: reason, spine: { status: "skipped", reason }, wake });
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("the asker is woken and writes the answer in itself; the reason shows once on the card", () => {
    wrap(<WaitingCard item={item({ response: refused({ notified: "woken", runId: "run_9", persona: "Delivery Manager" }) })} />);
    expect(screen.getByTestId("wake-note").textContent).toBe("Woken Delivery Manager (run run_9). It writes the answer into the spine itself (the console could not).");
    expect(screen.getByTestId("answer-state").textContent).toContain(`Saved here, not written to the spine (skipped): ${reason}.`);
    expect(count(document.body.textContent ?? "", reason)).toBe(1);
  });

  it("an older row (not woken: 'not in the spine yet (<reason>)') no longer repeats the reason", () => {
    wrap(<WaitingCard item={item({ response: refused({ notified: "skipped", reason: `the answer is not in the spine yet (${reason})`, persona: "Delivery Manager" }) })} />);
    expect(screen.getByTestId("wake-note").textContent).toBe("Not woken: the answer is not in the spine yet; Delivery Manager reads the answer at its next wake.");
    expect(count(document.body.textContent ?? "", reason)).toBe(1);
  });

  it("'reads the answer at its next wake' only where the wake prompt carries it", () => {
    expect(wakeLine({ notified: "skipped", reason: "no persona attached to wake" })).toBe(
      "Not woken: no persona attached to wake; the first persona attached to this project reads the answer at its first wake.",
    );
    expect(wakeLine({ notified: "off", persona: "Builder" }, undefined, { thread: true })).toBe("Not woken (Wake was unticked); the answer is in Builder's thread.");
  });
});

describe("Wake now (T15-S4)", () => {
  it("a skipped or failed wake of a delivered answer: Wake now re-runs the wake and shows the new result line", async () => {
    const spy = vi.spyOn(api, "redeliverResponse").mockResolvedValue(response({ wake: { notified: "woken", runId: "run_7", persona: "Delivery Manager" } }));
    wrap(<WaitingCard item={item({ state: "answered", answer: "two", response: response({ wake: { notified: "failed", reason: "t3 down", persona: "Delivery Manager" } }) })} />);
    expect(screen.getByTestId("wake-note").textContent).toBe("Not woken: t3 down; Delivery Manager reads the answer at its next wake.");
    fireEvent.click(screen.getByTestId("wake-now"));
    await vi.waitFor(() => expect(screen.getByTestId("wake-note").textContent).toBe("Woken Delivery Manager (run run_7)."));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("jr_1");
    expect(screen.queryByTestId("wake-now")).toBeNull();
  });

  it("no button for a final wake (woken / steered / off) or an undelivered answer", () => {
    for (const wake of [{ notified: "woken" }, { notified: "steered", mode: "steer" }, { notified: "off" }] as OwnerResponse["wake"][]) {
      wrap(<WaitingCard item={item({ state: "answered", answer: "two", response: response({ wake }) })} />);
      expect(screen.queryByTestId("wake-now")).toBeNull();
      cleanup();
    }
    wrap(<WaitingCard item={item({ state: "answered", answer: "two", response: response({ delivery: "failed", wake: { notified: "skipped", reason: "x" } }) })} />);
    expect(screen.queryByTestId("wake-now")).toBeNull();
  });
});
