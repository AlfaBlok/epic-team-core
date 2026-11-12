// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch } from "@/api";
import { PendingSelector } from "@/components/pending";
import { SidebarNav } from "@/components/Layout";
import { groupPending, openItems, pendingAction } from "@/lib/pending";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const it_ = (over: Partial<PendingItem>): PendingItem => ({ id: "x", kind: "ask", state: "open", milestoneId: "ms_z", title: "t", ...over });
/** three the owner rows in free text, one coded ask elsewhere, an answer pending, S2/S3 kinds. */
const ITEMS: PendingItem[] = [
  it_({ id: "wj_s2", kind: "free_text_ask", title: "T0-S2 Which accounts do we post from?", repo: "social", path: "docs/spines/root.md", url: "https://github.com/Acme/social/blob/HEAD/docs/spines/root.md?plain=1#L40", since: "2026-10-24T18:27:00Z" }),
  it_({ id: "wj_s3", kind: "free_text_ask", title: "T0-S3 Do you approve posts?", repo: "social", path: "docs/spines/root.md" }),
  it_({ id: "wj_s5", kind: "free_text_ask", title: "T0-S5 What should Memo say?", repo: "social", path: "docs/spines/root.md" }),
  it_({ id: "wj_a", kind: "ask", code: "T4-A1", title: "Rotate the key", milestoneId: "ms_p", repo: "poly-maker" }),
  it_({ id: "wj_done", kind: "answered", state: "answered", title: "Answer received" }),
  it_({ id: "rm_1", kind: "ready_to_mark", state: "open", title: "PLAN-2 ready to mark", milestoneId: "ms_i" }),
  it_({ id: "st_1", kind: "stalled", state: "answered", title: "PLAN-15 stalled", milestoneId: "ms_v" }),
  it_({ id: "fr_1", kind: "failed_run", state: "answered", title: "wake ended without report", milestoneId: "ms_v" }),
];
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.filter((i) => i.state === "open").length, at: "2026-10-24T22:00:00Z" });
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("T13-S4 lib/pending", () => {
  it("groups Needs you / Ready to mark / Stalled / Failed runs, in that order; answered items are not listed", () => {
    const g = groupPending(ITEMS);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ["Needs you", ["wj_s2", "wj_s3", "wj_s5", "wj_a"]],
      ["Ready to mark", ["rm_1"]],
      ["Stalled", ["st_1"]],
      ["Failed or unreported runs", ["fr_1"]],
    ]);
  });
  it("one action per kind", () => {
    expect(pendingAction(ITEMS[0])).toEqual({ label: "Rewrite as a coded ask", rewrite: { milestoneId: "ms_z", path: "docs/spines/root.md" } });
    expect(pendingAction(ITEMS[3])).toEqual({ label: "Answer", to: "/milestones/ms_p?tab=waiting&item=wj_a" });
    expect(pendingAction(ITEMS[5])).toMatchObject({ label: "Review and mark" });
    expect(pendingAction(ITEMS[6])).toMatchObject({ label: "Switch on", to: "/milestones/ms_v?tab=personas" });
    expect(pendingAction(ITEMS[7])).toMatchObject({ label: "Open run", to: "/milestones/ms_v?tab=activity" });
  });
  it("open items scoped to a node's subtree", () => {
    const xs = [it_({ id: "1", nodeKey: "m/E901" }), it_({ id: "2", nodeKey: "m/E901/S2" }), it_({ id: "3", nodeKey: "m/E910" }), it_({ id: "4", state: "answered", nodeKey: "m/E901" })];
    expect(openItems(xs, "m/E901").map((i) => i.id)).toEqual(["1", "2"]);
    expect(openItems(xs).map((i) => i.id)).toEqual(["1", "2", "3"]);
  });
});

describe("T13-S4 Pending selector", () => {
  it("lists the groups with project, title, age and one action each; free-text asks are amber 'ask not in console format' with the spine link", async () => {
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(ITEMS));
    wrap(<PendingSelector />);
    const needs = await screen.findByTestId("pending-group-needs_you");
    expect(needs.textContent).toMatch(/^Needs you \(4\)/);
    expect(screen.getByTestId("pending-count").textContent).toBe("5"); // open items: 3 free text + 1 ask + 1 ready to mark
    const rows = within(needs).getAllByTestId("pending-item");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["free_text_ask", "free_text_ask", "free_text_ask", "ask"]);
    const s2 = rows[0];
    expect(s2.className).toContain("border-amber-500/40");
    expect(within(s2).getByTestId("free-text-badge").textContent).toBe("ask not in console format");
    expect(s2.textContent).toContain("social");
    expect(s2.querySelector("time")).toBeTruthy();
    expect((within(s2).getByText("open spine").closest("a") as HTMLAnchorElement).href).toMatch(/root\.md\?plain=1#L40$/);
    expect(within(s2).getByRole("button", { name: /Rewrite as a coded ask/ })).toBeTruthy();
    // A coded ask: no amber badge, Answer opens its card.
    expect(within(rows[3]).queryByTestId("free-text-badge")).toBeNull();
    expect(within(rows[3]).getByRole("link", { name: "Answer" }).getAttribute("href")).toBe("/milestones/ms_p?tab=waiting&item=wj_a");
    expect(within(screen.getByTestId("pending-group-ready_to_mark")).getByRole("link", { name: "Review and mark" })).toBeTruthy();
    expect(within(screen.getByTestId("pending-group-stalled")).getByRole("link", { name: "Switch on" })).toBeTruthy();
    expect(within(screen.getByTestId("pending-group-runs")).getByRole("link", { name: "Open run" })).toBeTruthy();
    expect(screen.queryByText("Answer received")).toBeNull();
  });

  it("Rewrite as a coded ask sends the rewrite instruction to the Delivery Manager for that spine", async () => {
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(ITEMS.slice(0, 1)));
    const spy = vi.spyOn(api, "requestAsks").mockResolvedValue({ id: "msg_1", milestoneId: "ms_z", kind: "ask_for_asks", text: "", delivery: "sent", createdAt: "2026-10-24T22:00:00Z" });
    wrap(<PendingSelector />);
    fireEvent.click(await screen.findByRole("button", { name: /Rewrite as a coded ask/ }));
    expect(await screen.findByText("Sent to the Delivery Manager.")).toBeTruthy();
    expect(spy).toHaveBeenCalledWith({ milestoneId: "ms_z", path: "docs/spines/root.md", to: "delivery-manager" });
  });

  it("nothing pending: an empty note and a 0 count", async () => {
    vi.spyOn(api, "listStatus").mockResolvedValue(batch([]));
    wrap(<PendingSelector />);
    expect(await screen.findByText("Nothing pending.")).toBeTruthy();
    expect(screen.getByTestId("pending-count").textContent).toBe("0");
  });

  it("the Team badge shows the same number as the selector (both read GET /api/status needsYou)", async () => {
    vi.spyOn(api, "listStatus").mockResolvedValue(batch(ITEMS));
    wrap(
      <>
        <SidebarNav />
        <PendingSelector />
      </>,
    );
    const badge = await screen.findByTestId("waiting-count");
    expect(badge.textContent).toBe(screen.getByTestId("pending-count").textContent);
    expect(badge.textContent).toBe("5");
  });
});
