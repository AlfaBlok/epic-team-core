// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { AddButton } from "@/components/runControls";
import { AskedNoRow } from "@/components/askedNoRow";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/** the owner's Add is ready by default; "Just register it (draft)" keeps a draft; "Asked, no row yet". */
describe("Add: ready by default", () => {
  it("a plain Add is ready (no draft flag) and says the Delivery manager wakes", async () => {
    const add = vi.spyOn(api, "addToTree").mockResolvedValue({ kind: "row", path: "docs/spines/e.md", id: "T9-S3", ready: true });
    render(<AddButton milestoneId="ms_1" />);
    fireEvent.click(screen.getByTestId("tree-add"));
    expect(screen.getByText(/Your ask is ready \(root L-37\)/)).toBeTruthy();
    expect((screen.getByTestId("add-draft") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Snooze" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("ms_1", { kind: "row", title: "Snooze" }));
  });

  it("'Just register it (draft)' sends draft: true and the dialog says nobody works it", async () => {
    const add = vi.spyOn(api, "addToTree").mockResolvedValue({ kind: "done_means", path: "docs/spines/e.md", id: "E9-6", ready: false });
    render(<AddButton milestoneId="ms_1" />);
    fireEvent.click(screen.getByTestId("tree-add"));
    fireEvent.click(screen.getByLabelText(/Just register it \(draft\)/));
    expect(screen.getByText(/nobody works it until you stamp it ready/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "done_means" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Later" } });
    fireEvent.click(screen.getByRole("button", { name: "Add draft" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("ms_1", { kind: "done_means", title: "Later", draft: true }));
  });
});

describe("Team home: Asked, no row yet", () => {
  const item = (id: string, p = "docs/spines/epic-40.md") => ({ milestoneId: "ms_1", milestoneTitle: "home_repo", path: p, spineTitle: "PLAN-40", id, text: `${id} text` });
  const show = () =>
    render(
      <MemoryRouter>
        <AskedNoRow />
      </MemoryRouter>,
    );

  it("folded by default with its count; open lists each line under its spine, linked to the milestone", async () => {
    vi.spyOn(api, "listAskedNoRow").mockResolvedValue({ items: [item("E40-6"), item("E41-7", "docs/spines/epic-41.md")] });
    show();
    expect((await screen.findByTestId("asked-no-row-count")).textContent).toBe("2");
    expect(screen.getByText("Asked, no row yet")).toBeTruthy();
    expect(screen.queryByTestId("asked-no-row-item")).toBeNull();
    fireEvent.click(screen.getByTestId("asked-no-row-toggle"));
    expect(screen.getAllByTestId("asked-no-row-group")).toHaveLength(2);
    expect(screen.getAllByTestId("asked-no-row-item").map((e) => e.textContent)).toEqual(["E40-6 E40-6 text", "E41-7 E41-7 text"]);
    expect(screen.getByText(/PLAN-40 · docs\/spines\/epic-40.md/).closest("a")?.getAttribute("href")).toBe("/milestones/ms_1");
  });

  it("renders nothing when every line has a row, or when the world may not read it", async () => {
    vi.spyOn(api, "listAskedNoRow").mockResolvedValue({ items: [] });
    show();
    await waitFor(() => expect(api.listAskedNoRow).toHaveBeenCalled());
    expect(screen.queryByTestId("asked-no-row")).toBeNull();
    cleanup();
    vi.spyOn(api, "listAskedNoRow").mockRejectedValue(Object.assign(new Error("world_scope"), { status: 403 }));
    show();
    await waitFor(() => expect(api.listAskedNoRow).toHaveBeenCalled());
    expect(screen.queryByTestId("asked-no-row")).toBeNull();
  });
});
