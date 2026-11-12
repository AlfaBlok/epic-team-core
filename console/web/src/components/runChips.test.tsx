// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Run } from "@/api";
import { OutcomeBadge, RunNote } from "@/components/common";

/** a run that skipped its note is flagged; its acknowledgement shows under the note. A failed pre-wake pull. */
afterEach(() => cleanup());

const base = { id: "r1", assignmentId: "a1", startedAt: "2026-10-25T00:00:00Z", outcome: "blocked", summary: "x", kind: "wake" } as Run;

describe("T6-S31 / T6-S32 run chips", () => {
  it("note skipped: amber chip with the note in its title", () => {
    render(<OutcomeBadge outcome="progressed" run={{ ...base, outcome: "progressed", instructions: "re-check reddit", noteSkipped: true }} />);
    const chip = screen.getByTestId("note-skipped");
    expect(chip.textContent).toBe("note skipped");
    expect(chip.getAttribute("title")).toContain("re-check reddit");
    expect(screen.queryByTestId("stale-checkout")).toBeNull();
  });

  it("stale checkout: amber chip when the pre-wake pull failed; none for a plain pull or a fresh session", () => {
    render(<OutcomeBadge outcome="progressed" run={{ ...base, outcome: "progressed", preWake: "pre-wake: pull failed on host3 (at abc): error: x.pyc" }} />);
    expect(screen.getByTestId("stale-checkout").getAttribute("title")).toContain("x.pyc");
    cleanup();
    render(<OutcomeBadge outcome="progressed" run={{ ...base, outcome: "progressed", preWake: "pre-wake: pulled host3 a→b · fresh session: repo tool code changed" }} />);
    expect(screen.queryByTestId("stale-checkout")).toBeNull();
  });

  it("the note shows its acknowledgement", () => {
    render(<RunNote text="re-check reddit" by="Sam" ack="done: whoami ok" />);
    expect(screen.getByTestId("run-note-ack").textContent).toBe("note: done: whoami ok");
  });
});
