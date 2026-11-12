// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type MovingEpic, type Run } from "@/api";
import { isStill, MovingNow, movingWords } from "@/components/movingNow";
import { OutcomeBadge } from "@/components/common";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// the Team page's Moving now strip and the stalled flag on a run.
const NOW = Date.parse("2026-10-26T12:00:00Z");
const epic = (over: Partial<MovingEpic> = {}): MovingEpic => ({
  milestoneId: "ms_1",
  repo: "Acme/home_repo",
  path: "docs/spines/epic-14.md",
  title: "PLAN-14: Runnable epics",
  status: "active",
  workers: [],
  lastCommitAt: "2026-10-26T11:30:00Z",
  doneToday: [],
  ready: [],
  rows: [],
  ...over,
});

describe("Moving now", () => {
  it("words: worker running · last commit age · rows done today", () => {
    const w = movingWords(epic({ workers: [{ ticket: "T14-S8", runId: "r1", persona: "Delivery Manager" }], doneToday: ["T14-S7", "T14-S4"] }), NOW);
    expect(w.workers).toBe("1 worker (T14-S8)");
    expect(w.commit).toMatch(/^commit 30 min/);
    expect(w.done).toBe("2 rows done today");
    expect(movingWords(epic({ lastCommitAt: undefined }), NOW)).toMatchObject({ workers: "no worker", commit: "no commit", done: "0 rows done today" });
  });
  it("still = ready rows, no worker, no commit for 2 h", () => {
    expect(isStill(epic({ ready: ["E901"], lastCommitAt: "2026-10-26T09:00:00Z" }), NOW)).toBe(true);
    expect(isStill(epic({ ready: ["E901"] }), NOW)).toBe(false);
    expect(isStill(epic({ ready: [], lastCommitAt: "2026-10-26T09:00:00Z" }), NOW)).toBe(false);
    expect(isStill(epic({ ready: ["E901"], lastCommitAt: "2026-10-26T09:00:00Z", workers: [{ ticket: "E901", runId: "r", persona: "x" }] }), NOW)).toBe(false);
  });
  it("renders one line per epic, workers first, still epics flagged", async () => {
    vi.spyOn(api, "movingNow").mockResolvedValue({
      at: "2026-10-26T12:00:00Z",
      epics: [
        epic({ path: "a.md", title: "PLAN-21 lanes", ready: ["T21-S2"], lastCommitAt: "2026-10-26T08:00:00Z" }),
        epic({ path: "b.md", title: "PLAN-14", workers: [{ ticket: "T14-S8", runId: "r1", persona: "DM" }], doneToday: ["T14-S7"] }),
      ],
    });
    render(<MemoryRouter><MovingNow now={NOW} /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("moving-epic")).toHaveLength(2));
    const rows = screen.getAllByTestId("moving-epic");
    expect(rows[0].textContent).toMatch(/PLAN-14.*1 worker \(T14-S8\).*1 row done today/);
    expect(rows[1].textContent).toMatch(/PLAN-21 lanes.*no worker.*1 ready, nothing moving/);
    expect(rows[1].getAttribute("data-still")).toBe("true");
  });
  it("empty", async () => {
    vi.spyOn(api, "movingNow").mockResolvedValue({ at: "x", epics: [] });
    render(<MemoryRouter><MovingNow now={NOW} /></MemoryRouter>);
    expect(await screen.findByTestId("moving-now-empty")).toBeTruthy();
  });
});

// folds with its count (remembered), a scroll pane, Show 20 / 50 / all passed to the server.
describe("Moving now fold and limit", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => epic({ path: `e${i}.md`, title: `EPIC-${i}` }));
  it("asks the server for 20 by default; the count is the total; lines sit in the scroll pane", async () => {
    const spy = vi.spyOn(api, "movingNow").mockResolvedValue({ at: "x", epics: many(20), total: 64 });
    render(<MemoryRouter><MovingNow now={NOW} /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("moving-epic")).toHaveLength(20));
    expect(spy).toHaveBeenCalledWith(20);
    expect(screen.getByTestId("moving-now-count").textContent).toBe("64");
    expect(screen.getByTestId("moving-now-pane").className).toMatch(/max-h-\S+ .*overflow-y-auto|overflow-y-auto.*max-h-/);
    expect(screen.getByTestId("moving-now-more").textContent).toBe("20 of 64 shown");
  });
  it("Show 50 and all ask the server again and are remembered", async () => {
    const spy = vi.spyOn(api, "movingNow").mockImplementation(async (limit) => ({ at: "x", epics: many(limit ?? 64).slice(0, 64), total: 64 }));
    render(<MemoryRouter><MovingNow now={NOW} /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("moving-epic")).toHaveLength(20));
    fireEvent.click(screen.getByTestId("moving-now-limit-50"));
    await waitFor(() => expect(screen.getAllByTestId("moving-epic")).toHaveLength(50));
    expect(spy).toHaveBeenLastCalledWith(50);
    fireEvent.click(screen.getByTestId("moving-now-limit-all"));
    await waitFor(() => expect(screen.getAllByTestId("moving-epic")).toHaveLength(64));
    expect(spy).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByTestId("moving-now-more")).toBeNull();
    cleanup();
    render(<MemoryRouter><MovingNow now={NOW} /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("moving-epic")).toHaveLength(64));
    expect(screen.getByTestId("moving-now-limit-all").getAttribute("aria-pressed")).toBe("true");
  });
  it("folds to its heading line (count kept) and stays folded", async () => {
    vi.spyOn(api, "movingNow").mockResolvedValue({ at: "x", epics: many(3), total: 3 });
    render(<MemoryRouter><MovingNow now={NOW} /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("moving-epic")).toHaveLength(3));
    expect(screen.queryByTestId("moving-now-limit")).toBeNull(); // 3 lines: nothing to limit
    fireEvent.click(screen.getByTestId("moving-now-toggle"));
    expect(screen.queryAllByTestId("moving-epic")).toHaveLength(0);
    expect(screen.getByTestId("moving-now-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("moving-now-count").textContent).toBe("3");
    cleanup();
    render(<MemoryRouter><MovingNow now={NOW} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("moving-now-count").textContent).toBe("3"));
    expect(screen.queryAllByTestId("moving-epic")).toHaveLength(0);
  });
});

describe("stalled run flag", () => {
  it("an amber 'stalled' badge next to the outcome", () => {
    const run = { id: "r", assignmentId: "a", startedAt: "2026-10-26T11:00:00Z", outcome: "progressed", summary: "tidied", kind: "wake", stalled: "launched no worker and named no blocker while 2 rows read ready: E901, E902" } as Run;
    render(<OutcomeBadge outcome="progressed" run={run} />);
    expect(screen.getByTestId("run-stalled").getAttribute("title")).toMatch(/launched no worker/);
  });
});
