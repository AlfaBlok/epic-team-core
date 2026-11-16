// @vitest-environment jsdom
// His briefing (the owner, 16 Nov: "it gives me at some point a briefing where it's telling me, these are your
// objectives and key results, one by one. And I can just talk about it"): one objective at a time, two plain lines each
// with its number and its time, his words filed on that one, then the next.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode } from "@/api/pursuit-types";
import { Briefing, keyResultLines, objectiveLines } from "@/components/briefing";
import { isBriefMe } from "@/lib/briefing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const hour = new Date(Date.now() - 3 * 3600_000).toISOString();
const node = (id: string, name: string, krs: ScorecardNode["keyResults"]): ScorecardNode => ({ id, kind: "pursuit", name, greens: 0, total: 0, spines: [], children: [], rows: [], keyResults: krs });
const A = node("memo-live", "Memo: 5 testers", [
  { label: "Testers using it every day", kind: "key-result", state: "red", value: "1", target: "5", measuredAt: hour },
  { label: "Each tester gets a reply on WhatsApp", kind: "key-result", state: "unknown", value: "I don't know" },
]);
const B = node("team-browser", "EpicTeam: team browser fully operational", [{ label: "Reddit posts go out", kind: "key-result", state: "green", value: "yes", measuredAt: hour }]);

describe("the lines", () => {
  it("an objective: its place and name, then green of total and when measured", () => {
    expect(objectiveLines(A, 1)).toEqual(["1. Memo: 5 testers", "0 of 2 key results green. Measured 3 h ago."]);
  });
  it("a key result: its name, then its number now, its target and its time", () => {
    expect(keyResultLines(A.keyResults![0])).toEqual(["Testers using it every day", "Now: 1. Target: 5. Measured 3 h ago."]);
    expect(keyResultLines(A.keyResults![1])[1]).toBe("Now: I don't know. Nothing measures this yet.");
  });
  it("'brief me' opens it, a longer message does not", () => {
    expect(["brief me", "Brief me.", "briefing", "give me my briefing", "start the briefing please"].every(isBriefMe)).toBe(true);
    expect(["brief me on the Reddit post", "what is a briefing?"].some(isBriefMe)).toBe(false);
  });
});

describe("the walk-through", () => {
  it("one at a time; his words filed on that one, then the next; Next skips; the end counts", async () => {
    const spy = vi.spyOn(api, "briefingAnswer").mockResolvedValue({ ok: true, filed: ["docs/his-words.json"] });
    const close = vi.fn();
    render(
      <MemoryRouter>
        <Briefing nodes={[A, B]} kind="objective" onClose={close} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("briefing-title").textContent).toBe("Briefing · 1 of 2");
    expect(screen.getByTestId("briefing-objective").textContent).toBe("1. Memo: 5 testers");
    expect(screen.getAllByTestId("briefing-kr")).toHaveLength(2);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Push Reddit harder this week." } });
    fireEvent.click(screen.getByTestId("briefing-file"));
    await waitFor(() => expect(screen.getByTestId("briefing-objective").textContent).toBe("2. EpicTeam: team browser fully operational"));
    expect(spy).toHaveBeenCalledWith({ kind: "objective", id: "memo-live", name: "Memo: 5 testers", words: "Push Reddit harder this week." });
    fireEvent.click(screen.getByTestId("briefing-skip"));
    expect(screen.getByTestId("briefing-end-count").textContent).toMatch(/You answered 1: each answer is filed on its objective/);
    fireEvent.click(screen.getByTestId("briefing-finish"));
    expect(close).toHaveBeenCalled();
  });
  it("a failed filing stays on the objective and says why", async () => {
    vi.spyOn(api, "briefingAnswer").mockRejectedValue(new Error("not saved: git failed"));
    render(
      <MemoryRouter>
        <Briefing nodes={[A, B]} kind="objective" onClose={() => undefined} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("briefing-file"));
    await waitFor(() => expect(screen.getByTestId("briefing-failed").textContent).toBe("Not filed: not saved: git failed"));
    expect(screen.getByTestId("briefing-objective").textContent).toBe("1. Memo: 5 testers");
  });
});
