// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type LaptopView, type MacTask, type WaitingItem } from "@/api";
import { LaptopSwitch, laptopRows, plainTitle } from "@/components/laptopSwitch";

// "I'm on my laptop for 1 h / 2 h / until I say" on the Team home; while on,
// every needs Mac agent task comes first, red line first, then his priority, each with its minutes and Copy command.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const task = (row: string, ask: string | undefined, order: number, over: Partial<MacTask> = {}): MacTask => ({
  key: `home_repo#${row}`,
  repo: "home_repo",
  row,
  ...(ask ? { ask } : {}),
  title: `Ticket ${row}`,
  minutes: 15,
  order,
  url: `http://h/t/${row}/`,
  command: `claude --chrome '${row}'`,
  ...over,
});
const ask = (code: string, priority: number, over: Partial<WaitingItem> = {}) =>
  ({ id: `ask:${code}`, code, repo: "home_repo", priority, state: "open", macAgent: true, question: `Ask ${code}`, title: code, contextLinks: [], ...over }) as unknown as WaitingItem;

const tasks = [task("T81-S8", "T81-A6", 10, { minutes: 20 }), task("T86-S7", "T86-A4", 28), task("T88-S12", "T88-A1", 20), task("T88-S13", "T88-A1", 21, { minutes: 10 }), task("T5-S9", undefined, 40)];
// The inbox's Mac asks, as the server sorts them: on the red line (tier 0), then by level and milestone.
const mac = [
  ask("T86-A4", 3, { ownerPriority: { level: "normal", why: "x", ref: "T86-A4", redLine: { sentence: "s", state: "agreed" } } }),
  ask("T88-A1", 1_000_002),
  ask("T81-A6", 2_000_001),
  ask("T99-A1", 2_000_005, { contextLinks: [{ label: "ticket", url: "http://h/t/T99-S1/" }] }),
];

describe("T96-S7 the order", () => {
  it("red line first, then the inbox's priority; tasks of one ask in the Mac list's order; unmatched last; asks with no ticket keep their place", () => {
    const rows = laptopRows(tasks, mac);
    expect(rows.map((r) => r.code)).toEqual(["T86-S7", "T88-S12", "T88-S13", "T81-S8", "T99-A1", "T5-S9"]);
    expect(rows[0]).toMatchObject({ redLine: true, command: "claude --chrome 'T86-S7'", minutes: 15 });
    expect(rows[4]).toMatchObject({ title: "Ask T99-A1", url: "http://h/t/T99-S1/", redLine: false });
    expect(rows[4].command).toBeUndefined();
  });
});

describe("T96-S7 an ask finds its ticket", () => {
  it("by the ticket its link opens or the row it unblocks; the ask for the whole Mac list is no row; titles lose the link", () => {
    const rows = laptopRows(
      [task("T96-S3", undefined, 30, { title: "Make the Memo LinkedIn page" }), task("T5-S9", undefined, 40, { repo: "airbnb-observatory", key: "airbnb-observatory#T5-S9" })],
      [
        ask("T96-A1", 5, { question: "http://h/t/T96-S3/ : paste this command in Claude on your Mac" }),
        ask("T96-A2", 1, { question: "http://h/mac/ : Laptop session now: 24 tasks" }),
        ask("PLAN-5-A3", 9, { repo: "airbnb-observatory", row: "T5-S9", question: "Needs Mac agent: paste one command" }),
        ask("T98-A2", 7, { question: "http://h:9198/key/ : make a treg account and one key" }),
      ],
    );
    expect(rows.map((r) => [r.code, r.title, r.url])).toEqual([
      ["T96-S3", "Make the Memo LinkedIn page", "http://h/t/T96-S3/"],
      ["T98-A2", "Make a treg account and one key", "http://h:9198/key/"],
      ["T5-S9", "Ticket T5-S9", "http://h/t/T5-S9/"],
    ]);
    expect(plainTitle("Mac page: http://h/t/TAX-A10/ (Copy button, Done or Stuck)", "TAX-A10")).toBe("TAX-A10");
    expect(plainTitle("Needs Mac agent: a dashboard key", "x")).toBe("A dashboard key");
    expect(plainTitle("— needs Mac agent (T96-S5: a key) — make the Holded key", "x")).toBe("Make the Holded key");
  });
});

describe("T96-S7 the switch", () => {
  const view = (session: LaptopView["session"]): LaptopView => ({ session, tasks, listUrl: "http://h/mac/" });

  it("off: the three lengths and what turning it on does; no task list", () => {
    render(<LaptopSwitch view={view(null)} mac={mac} listUrl="http://h/mac/" />);
    expect(screen.getByTestId("laptop-switch").dataset.on).toBe("0");
    expect(["laptop-on-1h", "laptop-on-2h", "laptop-on-open"].map((id) => screen.getByTestId(id).textContent?.trim())).toEqual(["1 h", "2 h", "Until I say"]);
    expect(screen.getByTestId("laptop-summary").textContent).toContain("5 tasks for Claude on your Mac, about 75 minutes");
    expect(screen.queryByTestId("laptop-tasks")).toBeNull();
  });

  it("a length turns it on through the console", async () => {
    const set = vi.spyOn(api, "setLaptop").mockResolvedValue({ session: { id: "l", since: "x", until: null, by: "Sam" } });
    render(<LaptopSwitch view={view(null)} mac={mac} listUrl="http://h/mac/" />);
    fireEvent.click(screen.getByTestId("laptop-on-2h"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("2h"));
  });

  it("on: until when, every task in order with its minutes and Copy command, the red line marked; off through the console", async () => {
    const until = new Date(Date.now() + 90 * 60_000).toISOString();
    const off = vi.spyOn(api, "laptopOff").mockResolvedValue({ ended: true, session: null });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    render(<LaptopSwitch view={view({ id: "l", since: new Date().toISOString(), until, by: "Sam" })} mac={mac} listUrl="http://h/mac/" />);
    expect(screen.getByTestId("laptop-switch").dataset.on).toBe("1");
    expect(screen.getByTestId("laptop-left").textContent).toMatch(/^1 h (29|30) min left$/);
    const items = screen.getAllByTestId("laptop-task");
    expect(items).toHaveLength(6);
    expect(items[0].textContent).toContain("Red line");
    expect(items[0].textContent).toContain("15 min");
    expect(screen.getAllByTestId("laptop-red-line")).toHaveLength(1);
    expect(items[4].textContent).toContain("No text yet");
    fireEvent.click(screen.getAllByTestId("laptop-copy")[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("claude --chrome 'T86-S7'"));
    await waitFor(() => expect(screen.getAllByTestId("laptop-copy")[0].textContent).toContain("Copied"));
    fireEvent.click(screen.getByTestId("laptop-off"));
    await waitFor(() => expect(off).toHaveBeenCalled());
  });

  it("a session past its time reads as off at once", () => {
    render(<LaptopSwitch view={view({ id: "l", since: "2026-11-10T10:00:00Z", until: "2026-11-10T11:00:00Z", by: "Sam" })} mac={mac} listUrl="http://h/mac/" />);
    expect(screen.getByTestId("laptop-switch").dataset.on).toBe("0");
  });
});
