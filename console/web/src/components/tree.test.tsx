// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MilestoneTree, TreeNode } from "@/api";
import { useState } from "react";
import { EpicTree, needsWork, parseTreeFilter, READY_IDLE_LABEL, TreeLegend, treeTally, type TreeFilterKey } from "@/components/tree";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const n = (id: string, color: TreeNode["color"], children: TreeNode[] = [], flags: string[] = [], kind: TreeNode["kind"] = "ticket"): TreeNode => ({
  key: `k/${id}`,
  id,
  kind,
  title: `title ${id}`,
  status: color === "green" ? "done" : color,
  color,
  children,
  flags,
  ...(flags.length ? { notes: [`note for ${id}`] } : {}),
});

// root (blue) → DONE-A (green, all green below: collapsed) · OPEN (blue → red leaf) · LIAR (green, dishonest) · loop ref
const tree = (): MilestoneTree => {
  const root = n("ROOT", "blue", [
    n("DONE-A", "green", [n("DONE-A1", "green"), n("DONE-A2", "green")]),
    n("OPEN", "blue", [n("SAM", "red"), n("WAITS", "yellow")]),
    n("LIAR", "green", [], ["dishonest-green"]),
    n("LOOP", "blue", [], ["cycle"]),
  ], [], "spine");
  return { milestoneId: "ms_1", root, counts: { grey: 0, blue: 2, yellow: 1, red: 1, green: 4 }, nonGreen: 4, closed: 0, flagged: 1, source: "spines", warnings: [] };
};

describe("EpicTree", () => {
  it("shows one row of dot · count · short label, long meaning in the tooltip, no separate legend row", () => {
    render(<EpicTree tree={tree()} />);
    expect(screen.getByText("4 to turn green")).toBeTruthy();
    expect(screen.getByTestId("count-red").textContent).toBe("1waiting on you");
    expect(screen.getByTestId("count-red").getAttribute("title")).toBe("an open item for Sam (one per item; the same count as Waiting on you)");
    expect(screen.getByTestId("count-yellow").textContent).toBe("1blocked on a dependency");
    expect(screen.getByTestId("count-blue").textContent).toBe("2in progress");
    expect(screen.getByTestId("count-grey").textContent).toBe("0draft");
    expect(screen.getByTestId("count-green-value").textContent).toBe("4");
    expect(screen.getByTestId("count-green").textContent).toBe("4done");
    expect(screen.getByTestId("count-flagged").textContent).toBe("1flagged");
    expect(screen.queryByTestId("legend-ready-idle")).toBeNull();
    expect(screen.queryByText("blocked on Sam")).toBeNull();
  });

  it("treeTally moves ready rows from grey to open", () => {
    const t = tree();
    t.root.children.push({ ...n("RDY", "grey"), status: "ready", ready: true });
    t.counts.grey = 2;
    expect(treeTally(t)).toEqual({ grey: 1, blue: 3, yellow: 1, red: 1, green: 4 });
  });

  it("only the root and its children show; each node unfolds on its own click; Expand / Collapse all", () => {
    render(<EpicTree tree={tree()} />);
    expect(screen.getByText("title OPEN")).toBeTruthy();
    expect(screen.queryByText("title SAM")).toBeNull(); // non-green below level 1 is folded too
    expect(screen.queryByText("title DONE-A1")).toBeNull();
    expect(screen.getAllByTestId("collapsed-summary").map((s) => s.textContent)).toEqual(["2", "11"]);
    fireEvent.click(screen.getByLabelText("Expand DONE-A"));
    expect(screen.getByText("title DONE-A1")).toBeTruthy();
    expect(screen.queryByText("title SAM")).toBeNull(); // one at a time
    fireEvent.click(screen.getByLabelText("Expand OPEN"));
    expect(screen.getByText("title SAM")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Collapse OPEN"));
    expect(screen.queryByText("title SAM")).toBeNull();
    fireEvent.click(screen.getByText("Expand all"));
    expect(screen.getByText("title SAM")).toBeTruthy();
    fireEvent.click(screen.getByText("Collapse all"));
    expect(screen.queryByText("title OPEN")).toBeNull();
  });

  it("a node's fold is kept per node key and survives a reload; the root always opens", () => {
    const { unmount } = render(<EpicTree tree={tree()} />);
    fireEvent.click(screen.getByLabelText("Expand OPEN"));
    expect(window.localStorage.getItem("epicTree.open.k/OPEN")).toBe("open");
    fireEvent.click(screen.getByLabelText("Collapse ROOT"));
    expect(window.localStorage.getItem("epicTree.open.k/ROOT")).toBeNull();
    unmount();
    render(<EpicTree tree={tree()} />);
    expect(screen.getByText("title SAM")).toBeTruthy();
    expect(screen.queryByText("title DONE-A1")).toBeNull();
    fireEvent.click(screen.getByText("Collapse all"));
    expect(window.localStorage.getItem("epicTree.open.k/OPEN")).toBe("closed");
    cleanup();
    render(<EpicTree tree={tree()} />);
    expect(screen.getByText("title OPEN")).toBeTruthy();
    expect(screen.queryByText("title SAM")).toBeNull();
    fireEvent.click(screen.getByText("Expand all"));
    cleanup();
    render(<EpicTree tree={tree()} />);
    expect(screen.getByText("title DONE-A1")).toBeTruthy();
  });

  it("a row reads code + label; full title and path are the tooltip, no path line", () => {
    const t = tree();
    t.root.children[1] = { ...t.root.children[1], code: "EPIC-909", label: "Open work", title: "Open work: the long internal name", path: "docs/spines/epic-909-open.md", kind: "spine" };
    const { container } = render(<EpicTree tree={t} />);
    const row = container.querySelector('[data-key="k/OPEN"] > div') as HTMLElement;
    expect(row.querySelector('[data-testid="tree-label"]')!.textContent).toBe("Open work");
    expect(row.textContent!.startsWith("EPIC-909Open work")).toBe(true); // the code, not the node id
    expect(row.textContent).not.toContain("the long internal name");
    expect(row.textContent).not.toContain("docs/spines");
    expect(row.getAttribute("title")).toBe("Open work: the long internal name\ndocs/spines/epic-909-open.md");
    expect(screen.getByText("title DONE-A")).toBeTruthy(); // an older server without label: the title
  });

  it("colors dots by status; a flagged green renders with a ring and its flag + note", () => {
    const { container } = render(<EpicTree tree={tree()} />);
    fireEvent.click(screen.getByText("Expand all"));
    const row = (id: string) => container.querySelector(`[data-key="k/${id}"] [data-testid="tree-dot"]`) as HTMLElement;
    expect(row("SAM").dataset.color).toBe("red");
    expect(row("WAITS").dataset.color).toBe("yellow");
    expect(row("LIAR").dataset.flagged).toBe("true");
    expect(row("LIAR").className).toMatch(/ring-amber-500/);
    expect(row("DONE-A").dataset.flagged).toBeUndefined();
    expect(screen.getByText("dishonest green")).toBeTruthy();
    expect(screen.getByText("note for LIAR")).toBeTruthy();
    expect(screen.getByText("cycle")).toBeTruthy();
  });

  it("needsWork ignores refs and sees flagged greens", () => {
    expect(needsWork(n("x", "green", [n("y", "green")]))).toBe(false);
    expect(needsWork(n("x", "green", [n("y", "blue", [], ["repeat"])]))).toBe(false);
    expect(needsWork(n("x", "green", [n("y", "green", [], ["stale"])]))).toBe(true);
    expect(needsWork(n("x", "green", [n("y", "green", [n("z", "grey")])]))).toBe(true);
  });
});

describe("ready · nobody on it", () => {
  const readyTree = (): MilestoneTree => {
    const ready = (id: string): TreeNode => ({ ...n(id, "grey"), status: "ready", ready: true });
    const root = n("ROOT", "blue", [ready("S2"), ready("S3"), n("S4", "yellow"), n("S5", "grey")], [], "spine");
    return { milestoneId: "ms_1", root, counts: { grey: 3, blue: 1, yellow: 1, red: 0, green: 0 }, nonGreen: 5, closed: 0, flagged: 0, source: "spines", warnings: [] };
  };
  const dot = (c: HTMLElement, id: string) => c.querySelector(`[data-key="k/${id}"] [data-testid="tree-dot"]`) as HTMLElement;

  it("a ready row with no runner gets a hollow blue dot + label; a running one a solid blue dot; blocked stays amber, draft grey", () => {
    const { container } = render(<EpicTree tree={readyTree()} worked={new Set(["S3"])} />);
    expect(dot(container, "S2").dataset.ready).toBe("idle");
    expect(dot(container, "S2").className).toMatch(/border-sky-500/);
    expect(dot(container, "S2").className).toMatch(/bg-transparent/);
    expect(dot(container, "S3").dataset.ready).toBe("worked");
    expect(dot(container, "S3").className).toMatch(/bg-sky-500/);
    expect(dot(container, "S4").dataset.color).toBe("yellow");
    expect(dot(container, "S4").dataset.ready).toBeUndefined();
    expect(dot(container, "S5").dataset.color).toBe("grey");
    expect(container.querySelectorAll('[data-testid="ready-idle"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="ready-worked"]')).toHaveLength(1);
    expect(screen.getByTestId("count-ready-idle").textContent).toBe(`1${READY_IDLE_LABEL}`);
  });

  it("ready rows count as open, not grey; with no run data both are idle", () => {
    render(<EpicTree tree={readyTree()} />);
    expect(screen.getByTestId("count-blue-value").textContent).toBe("3");
    expect(screen.getByTestId("count-grey-value").textContent).toBe("1");
    expect(screen.getByTestId("count-grey").getAttribute("title")).toBe("draft / deferred / superseded / unknown");
    expect(screen.getByTestId("count-ready-idle-value").textContent).toBe("2");
  });

  it("TreeLegend (Spines page) uses the short labels with the ready entry", () => {
    render(<TreeLegend />);
    expect(screen.getByTestId("legend-ready-idle").textContent).toBe(READY_IDLE_LABEL);
    expect(screen.getByText("waiting on you").closest("span")!.getAttribute("title")).toBe("an open item for Sam (one per item; the same count as Waiting on you)");
  });
});

describe("legend as filter", () => {
  // ROOT → DONE-A (green → DONE-A1, DONE-A2) · OPEN (blue → OWNER red, WAITS yellow) · LIAR (green, dishonest) · RDY (ready) · DRAFT (grey) · loop ref
  const filterTree = (): MilestoneTree => {
    const t = tree();
    t.root.children.push({ ...n("RDY", "grey"), status: "ready", ready: true }, n("DRAFT", "grey"));
    t.counts.grey = 2;
    return t;
  };
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll("li[data-key]")).map((li) => `${li.getAttribute("data-key")!.slice(2)}:${li.getAttribute("data-filter")}`);
  const press = (id: string) => fireEvent.click(screen.getByTestId(id));

  it("counts are toggle buttons: one filter shows matches + ancestors (muted context), counts unchanged", () => {
    const { container } = render(<EpicTree tree={filterTree()} />);
    const red = screen.getByTestId("count-red");
    expect(red.tagName).toBe("BUTTON");
    expect(red.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("tree-filter-clear")).toBeNull();
    press("count-red");
    expect(red.getAttribute("aria-pressed")).toBe("true");
    expect(rows(container)).toEqual(["ROOT:context", "OPEN:context", "SAM:match"]);
    expect(container.querySelector('[data-key="k/OPEN"] > div')!.className).toMatch(/text-muted-foreground/);
    expect(screen.getByTestId("count-red-value").textContent).toBe("1");
    expect(screen.getByTestId("count-green-value").textContent).toBe("4");
  });

  it("several filters = union; ancestors of a collapsed done subtree are forced open", () => {
    const { container } = render(<EpicTree tree={filterTree()} />);
    expect(screen.queryByText("title DONE-A1")).toBeNull(); // unfiltered: the all-green branch starts collapsed
    press("count-yellow");
    press("count-green");
    expect(rows(container)).toEqual(["ROOT:context", "DONE-A:match", "DONE-A1:match", "DONE-A2:match", "OPEN:context", "WAITS:match", "LIAR:match"]);
    expect(screen.getByText("title DONE-A1")).toBeTruthy();
    expect(screen.getByLabelText("Collapse DONE-A")).toBeTruthy();
  });

  it("clicking an active item again turns it off; Show all clears every filter", () => {
    const { container } = render(<EpicTree tree={filterTree()} />);
    press("count-red");
    press("count-red");
    expect(screen.getByTestId("count-red").getAttribute("aria-pressed")).toBe("false");
    expect(rows(container)).toContain("DRAFT:null");
    press("count-red");
    press("count-grey");
    expect(rows(container)).toEqual(["ROOT:context", "OPEN:context", "SAM:match", "DRAFT:match"]);
    press("tree-filter-clear");
    expect(screen.queryByTestId("tree-filter-clear")).toBeNull();
    expect(screen.getByText("title DRAFT")).toBeTruthy();
    expect(screen.queryByText("title WAITS")).toBeNull(); // back to the folded default
  });

  it("ready · nobody on it filters ready rows nobody works on; ready rows match open, not draft", () => {
    const t = filterTree();
    t.root.children.push({ ...n("RDY2", "grey"), status: "ready", ready: true });
    t.counts.grey = 3;
    const { container } = render(<EpicTree tree={t} worked={new Set(["RDY2"])} />);
    press("count-ready-idle");
    expect(rows(container)).toEqual(["ROOT:context", "RDY:match"]);
    press("count-ready-idle");
    press("count-grey");
    expect(rows(container)).toEqual(["ROOT:context", "DRAFT:match"]);
    press("count-grey");
    press("count-blue");
    expect(rows(container)).toEqual(["ROOT:match", "OPEN:match", "RDY:match", "RDY2:match"]); // the cycle ref never matches
  });

  it("flagged filter shows honesty-flagged nodes; zero counts are disabled; no match → empty line", () => {
    const t = filterTree();
    t.root.children = t.root.children.filter((c) => c.id !== "OPEN");
    const { container } = render(<EpicTree tree={t} />);
    press("count-flagged");
    expect(rows(container)).toEqual(["ROOT:context", "LIAR:match"]);
    expect((screen.getByTestId("count-yellow") as HTMLButtonElement).disabled).toBe(false); // the count is a total (1)
    const zero = filterTree();
    zero.counts.yellow = 0;
    cleanup();
    render(<EpicTree tree={zero} filter={["yellow"]} onFilterChange={() => {}} />);
    expect((screen.getByTestId("count-red") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("count-yellow").getAttribute("aria-pressed")).toBe("true");
    cleanup();
    const none = filterTree();
    none.root.children = [n("ONLY", "green")];
    render(<EpicTree tree={none} filter={["red"]} onFilterChange={() => {}} />);
    expect(screen.getByTestId("tree-filter-empty")).toBeTruthy();
    expect(screen.getByText("title ROOT")).toBeTruthy();
    cleanup();
    const t0 = filterTree();
    t0.counts.red = 0;
    render(<EpicTree tree={t0} />);
    expect((screen.getByTestId("count-red") as HTMLButtonElement).disabled).toBe(true);
  });

  it("controlled filter reports keys in legend order; parseTreeFilter drops unknown keys", () => {
    let seen: TreeFilterKey[] = [];
    function Host() {
      const [f, setF] = useState<TreeFilterKey[]>([]);
      return <EpicTree tree={filterTree()} filter={f} onFilterChange={(k) => { seen = k; setF(k); }} />;
    }
    render(<Host />);
    press("count-green");
    press("count-red");
    expect(seen).toEqual(["red", "green"]);
    expect(parseTreeFilter("blue,bogus,flagged,red")).toEqual(["red", "blue", "flagged"]);
    expect(parseTreeFilter(null)).toEqual([]);
  });
});

describe("finished epics fold, superseded is closed", () => {
  // ROOT → LIVE (running, blue → L-1 ready) · R-1 superseded (closed) · OLD-1, OLD-2 (finished; OLD-1 has an open row)
  const folded = (): MilestoneTree => {
    const live = { ...n("LIVE", "blue", [{ ...n("L-1", "grey"), status: "ready", ready: true as const }], [], "spine"), runState: "running" };
    const old1 = { ...n("OLD-1", "green", [{ ...n("O-1", "grey"), status: "ready" }], ["done-open-descendants"], "spine"), runState: "finished" };
    const old2 = { ...n("OLD-2", "grey", [], [], "spine"), status: "superseded", runState: "finished" };
    const sup = { ...n("R-1", "grey"), status: "superseded", closed: true as const };
    const root = n("ROOT", "blue", [old1, live, sup, old2], [], "spine");
    return { milestoneId: "ms_f", root, counts: { grey: 2, blue: 2, yellow: 0, red: 0, green: 0 }, nonGreen: 3, closed: 1, flagged: 0, finished: 2, source: "spines", warnings: [] };
  };
  afterEach(() => window.localStorage.clear());

  it("folds finished children into one line after the live ones by default; their rows are not rendered", () => {
    const { container } = render(<EpicTree tree={folded()} />);
    const items = [...container.querySelectorAll('[data-key="k/ROOT"] > ul > li')];
    expect(items.map((li) => li.getAttribute("data-key") ?? li.textContent)).toEqual(["k/LIVE", "k/R-1", "2 closed · show"]);
    expect(screen.queryByText("title OLD-1")).toBeNull();
    expect(screen.queryByText("title O-1")).toBeNull();
    expect(screen.queryByText("title L-1")).toBeNull(); // below level 1 is folded
  });

  it("expands in place on click, remembers the choice per parent, and folds again", () => {
    const { unmount } = render(<EpicTree tree={folded()} />);
    fireEvent.click(screen.getByTestId("finished-fold"));
    expect(screen.getByTestId("finished-fold").textContent).toBe("2 closed · hide");
    expect(screen.getByText("title OLD-1")).toBeTruthy();
    expect(screen.getByText("title OLD-2")).toBeTruthy();
    expect(window.localStorage.getItem("epicTree.fold.k/ROOT")).toBe("shown");
    unmount();
    render(<EpicTree tree={folded()} />);
    expect(screen.getByText("title OLD-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("finished-fold"));
    expect(screen.queryByText("title OLD-1")).toBeNull();
    expect(window.localStorage.getItem("epicTree.fold.k/ROOT")).toBe("folded");
  });

  it("Expand all shows finished epics too; Collapse all folds them", () => {
    render(<EpicTree tree={folded()} />);
    fireEvent.click(screen.getByText("Expand all"));
    expect(screen.getByText("title O-1")).toBeTruthy();
    fireEvent.click(screen.getByText("Collapse all"));
    expect(screen.queryByText("title OLD-1")).toBeNull();
  });

  it("superseded renders closed (muted, grey, no ready badge) and does not keep a parent open", () => {
    const { container } = render(<EpicTree tree={folded()} />);
    const row = container.querySelector('[data-key="k/R-1"] > div') as HTMLElement;
    expect(row.dataset.closed).toBe("true");
    expect(row.className).toMatch(/opacity-60/);
    expect((row.querySelector('[data-testid="tree-dot"]') as HTMLElement).dataset.color).toBe("grey");
    expect(row.querySelector('[data-testid="ready-idle"]')).toBeNull();
    // a parent whose only non-green children are closed rows or finished epics needs no work
    const p = n("P", "green", [{ ...n("X", "grey"), status: "superseded", closed: true }, { ...n("F", "grey", [n("F-1", "grey")], [], "spine"), runState: "finished" }]);
    expect(needsWork(p)).toBe(false);
  });

  it("filters skip finished epics (they are not counted either)", () => {
    render(<EpicTree tree={folded()} filter={["grey"]} />);
    expect(screen.queryByText("title O-1")).toBeNull();
    expect(screen.queryByTestId("finished-fold")).toBeNull();
    expect(screen.getByText("title R-1")).toBeTruthy();
  });
});
