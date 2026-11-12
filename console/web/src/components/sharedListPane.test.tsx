// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type WaitingItem } from "@/api";
import { LimitControl, ListPane, limitList, LIST_LIMITS, useListLimit } from "@/components/listPane";
import { MOVING_LIMITS } from "@/components/movingNow";
import { WaitingOnYou } from "@/components/waiting";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A list of `n` rows through the shared pane, as the Waiting-on-you lists use it (client-side cut). */
function Demo({ n, store = "demo" }: { n: number; store?: string }) {
  const [limit, setLimit] = useListLimit(store);
  const rows = Array.from({ length: n }, (_, i) => `row ${i + 1}`);
  const shown = limitList(rows, limit);
  return (
    <div>
      <LimitControl limit={limit} onChange={setLimit} total={rows.length} testId="demo" />
      <ListPane shown={shown.length} total={rows.length} testId="demo">
        {shown.map((r) => (
          <li key={r} data-testid="demo-row">
            {r}
          </li>
        ))}
      </ListPane>
    </div>
  );
}

describe("T48-S15 shared list pane", () => {
  it("default 20 rows in a fixed-height scroll pane, Show 20 / 50 / all, 'N of M shown' foot", () => {
    render(<Demo n={64} />);
    const pane = screen.getByTestId("demo-pane");
    expect(pane.className).toMatch(/max-h-\[30rem\]/);
    expect(pane.className).toMatch(/overflow-y-auto/);
    expect(screen.getAllByTestId("demo-row")).toHaveLength(20);
    expect(screen.getByTestId("demo-more").textContent).toBe("20 of 64 shown");
    expect(screen.getByTestId("demo-limit-20").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("demo-limit-50"));
    expect(screen.getAllByTestId("demo-row")).toHaveLength(50);
    expect(screen.getByTestId("demo-more").textContent).toBe("50 of 64 shown");
    fireEvent.click(screen.getByTestId("demo-limit-all"));
    expect(screen.getAllByTestId("demo-row")).toHaveLength(64);
    expect(screen.queryByTestId("demo-more")).toBeNull();
  });

  it("remembers the choice per list; no control and no foot when the list fits", () => {
    const { unmount } = render(<Demo n={64} />);
    fireEvent.click(screen.getByTestId("demo-limit-50"));
    unmount();
    render(<Demo n={64} />);
    expect(screen.getAllByTestId("demo-row")).toHaveLength(50);
    cleanup();
    render(<Demo n={64} store="other" />);
    expect(screen.getAllByTestId("demo-row")).toHaveLength(20);
    cleanup();
    render(<Demo n={7} />);
    expect(screen.queryByTestId("demo-limit")).toBeNull();
    expect(screen.queryByTestId("demo-more")).toBeNull();
    expect(screen.getAllByTestId("demo-row")).toHaveLength(7);
  });

  it("ignores a stored value that is not a choice; Moving now uses the same choices", () => {
    window.localStorage.setItem("teamHome.limit.demo", "33");
    render(<Demo n={64} />);
    expect(screen.getAllByTestId("demo-row")).toHaveLength(20);
    expect(MOVING_LIMITS).toBe(LIST_LIMITS);
    expect(limitList([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  it("an unknown total (still loading) shows no control", () => {
    function Loading() {
      const [l, set] = useState(20);
      return <LimitControl limit={l} onChange={set} total={undefined} testId="x" />;
    }
    render(<Loading />);
    expect(screen.queryByTestId("x-limit")).toBeNull();
  });
});

const base = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T4",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "T4 Pick the logger layout",
  ask: "decide",
  question: "Ship with one logger or two?",
  options: ["one", "two"],
  recommendation: "one",
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: new Date(Date.now() - 2 * 86400_000).toISOString(),
  decidable: false,
  ...over,
});
const answered = (n: number) => Array.from({ length: n }, (_, i) => base({ id: `wj_a${i}`, state: "answered", question: `Answered ask ${i + 1}?`, answer: "yes" }));
const coming = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    base({ id: `wj_c${i}`, source: "heuristic", signal: "needs_column", ask: "unknown", row: undefined, title: `Gate ${i + 1}`, question: `Gate ${i + 1}`, options: undefined, recommendation: undefined, gate: "future", gateReason: "pending" }),
  );
const superseded = (n: number) =>
  Array.from({ length: n }, (_, i) => base({ id: `nj_s${i}`, source: "needs_jordi", state: "superseded", supersededBy: "moot", question: `Old request ${i + 1} `.repeat(20), decidable: false }));
const wrap = () => render(<MemoryRouter><WaitingOnYou milestoneId="ms_1" /></MemoryRouter>);

describe("T48-S15 Waiting on you lists in the shared pane", () => {
  it("Answered (52) open: 20 one-line rows in the scroll pane, Show 20 / 50 / all, '20 of 52 shown'", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base(), ...answered(52)]);
    wrap();
    const section = await screen.findByTestId("answered-section");
    expect(within(section).queryByTestId("answered-limit")).toBeNull(); // folded: the one line only
    fireEvent.click(within(section).getByTestId("answered-section-toggle"));
    const pane = within(section).getByTestId("answered-pane");
    expect(pane.className).toMatch(/max-h-\[30rem\].*overflow-y-auto|overflow-y-auto.*max-h-\[30rem\]/);
    expect(within(pane).getAllByTestId("answered-row")).toHaveLength(20);
    expect(within(section).getByTestId("answered-more").textContent).toBe("20 of 52 shown");
    fireEvent.click(within(section).getByTestId("answered-limit-50"));
    expect(within(pane).getAllByTestId("answered-row")).toHaveLength(50);
    fireEvent.click(within(section).getByTestId("answered-limit-all"));
    expect(within(pane).getAllByTestId("answered-row")).toHaveLength(52);
    expect(within(section).queryByTestId("answered-more")).toBeNull();
    expect(window.localStorage.getItem("teamHome.limit.answered")).toBe("0");
  });

  it("Coming up open: 20 one-line rows in the pane with its own Show control", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base(), ...coming(30)]);
    wrap();
    const section = await screen.findByTestId("coming-up");
    fireEvent.click(within(section).getByTestId("coming-up-toggle"));
    const rows = within(within(section).getByTestId("coming-up-pane")).getAllByTestId("coming-row");
    expect(rows).toHaveLength(20);
    expect(rows[0].className).toMatch(/whitespace-nowrap/);
    expect(within(section).getByTestId("coming-up-more").textContent).toBe("20 of 30 shown");
    fireEvent.click(within(section).getByTestId("coming-up-limit-50"));
    expect(within(section).getAllByTestId("coming-row")).toHaveLength(30);
    expect(within(section).queryByTestId("coming-up-more")).toBeNull();
  });

  it("Superseded open: 20 truncated one-line rows (full text on hover) in the pane", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base(), ...superseded(25)]);
    wrap();
    const section = await screen.findByTestId("superseded");
    fireEvent.click(within(section).getByTestId("superseded-toggle"));
    const rows = within(within(section).getByTestId("superseded-pane")).getAllByTestId("superseded-row");
    expect(rows).toHaveLength(20);
    expect(rows[0].getAttribute("title")).toContain("Old request 1");
    expect(rows[0].querySelector(".truncate")).toBeTruthy();
    expect(within(section).getByTestId("superseded-more").textContent).toBe("20 of 25 shown");
    fireEvent.click(within(section).getByTestId("superseded-limit-all"));
    expect(within(section).getAllByTestId("superseded-row")).toHaveLength(25);
  });

  it("a short list keeps its rows in the pane with no Show control", async () => {
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([base(), ...answered(3)]);
    wrap();
    const section = await screen.findByTestId("answered-section");
    fireEvent.click(within(section).getByTestId("answered-section-toggle"));
    expect(within(section).getAllByTestId("answered-row")).toHaveLength(3);
    expect(within(section).queryByTestId("answered-limit")).toBeNull();
    expect(within(section).queryByTestId("answered-more")).toBeNull();
  });
});
