// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ApprovalsView, type GrantWriteResult, type Milestone } from "@/api";
import { ApprovalsTab, writeMessage } from "@/components/approvals";
import { tabFromParams } from "@/pages/Milestone";

/** the milestone Approvals tab: own then inherited grants, uses linked, add / edit / revoke forms. */

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

const M = { id: "ms_1", title: "Child", repo: "demo", path: "docs/spines/child.md", remote: "Acme/demo" } as Milestone;
const VIEW: ApprovalsView = {
  path: "docs/spines/child.md",
  nextCode: "T3-G3",
  grants: [
    { code: "T3-G1", who: "Sam", scope: "Restart the child worker", limits: "this host only", expires: "2099-01-01", since: "2026-10-23", state: "active", source: "docs/spines/child.md", inherited: false, uses: 1,
      useRows: [{ path: "docs/spines/child.md", line: 23, date: "2026-10-23", text: "restarted under T3-G1" }] },
    { code: "T3-G2", who: "Sam", scope: "Old backfill", state: "revoked", revoked: "2026-10-24", why: "done", source: "docs/spines/child.md", inherited: false, uses: 0, useRows: [] },
    { code: "T0-G1", who: "Sam", scope: "Deploy the test app", expires: "2026-01-01", since: "2025-12-01", state: "expired", source: "docs/spines/root.md", inherited: true, uses: 0, useRows: [] },
  ],
};
const RESULT = (code: string): GrantWriteResult => ({ code, line: "- [grant …]", sha: "abc1234", path: "docs/spines/child.md", view: VIEW, wake: { runId: "run_1" } });
const wrap = () => render(<MemoryRouter><ApprovalsTab m={M} /></MemoryRouter>);

describe("Approvals tab", () => {
  it("is a milestone tab (?tab=approvals)", () => {
    expect(tabFromParams(new URLSearchParams("tab=approvals"))).toBe("approvals");
  });

  it("lists own grants first, then inherited with their source; revoked and expired are greyed, not hidden", async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 24, 12, 0), toFake: ["Date"] });
    vi.spyOn(api, "getApprovals").mockResolvedValue(VIEW);
    wrap();
    const g1 = await screen.findByTestId("grant-T3-G1");
    expect(within(g1).getByText("Restart the child worker")).toBeTruthy();
    expect(within(g1).getByText("Limits: this host only")).toBeTruthy();
    // relative labels; the exact dates stay on hover.
    expect(g1.textContent).toContain("since 1 day ago by Sam · expires in 72 years");
    expect(g1.querySelector("[title]")!.getAttribute("title")).toBe("since 2026-10-23 · expires 2099-01-01");
    expect(g1.className).not.toContain("opacity-60");

    const revoked = screen.getByTestId("grant-T3-G2");
    expect(revoked.dataset.state).toBe("revoked");
    expect(revoked.className).toContain("opacity-60");
    expect(revoked.textContent).toContain("revoked today: done");
    expect(within(revoked).queryByRole("button", { name: "Edit" })).toBeNull();

    const inherited = screen.getByTestId("grant-T0-G1");
    expect(inherited.className).toContain("opacity-60");
    expect(inherited.textContent).toContain("expired 9 months ago");
    expect(within(inherited).getByRole("link", { name: "docs/spines/root.md" }).getAttribute("href")).toBe("https://github.com/Acme/demo/blob/HEAD/docs/spines/root.md");
    // Order: own before inherited.
    const order = screen.getAllByTestId(/^grant-/).map((e) => e.dataset.testid);
    expect(order).toEqual(["grant-T3-G1", "grant-T3-G2", "grant-T0-G1"]);
    expect(screen.getByText("T3-G3").className).toContain("font-mono");
  });

  it("use count opens links to each Decisions row", async () => {
    vi.spyOn(api, "getApprovals").mockResolvedValue(VIEW);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "used 1×" }));
    const link = within(screen.getByTestId("uses-T3-G1")).getByRole("link");
    expect(link.textContent).toBe("2026-10-23 restarted under T3-G1");
    expect(link.getAttribute("href")).toBe("https://github.com/Acme/demo/blob/HEAD/docs/spines/child.md#L23");
  });

  it("add: plain-language form, sends scope / limits / expiry, then clears and says the DM is woken", async () => {
    vi.spyOn(api, "getApprovals").mockResolvedValue(VIEW);
    const add = vi.spyOn(api, "addApproval").mockResolvedValue(RESULT("T3-G3"));
    wrap();
    const form = await screen.findByTestId("add-grant-form");
    const submit = within(form).getByRole("button", { name: "Add approval" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("What it covers"), { target: { value: " Rotate the child's own API key " } });
    fireEvent.change(within(form).getByLabelText("Limits"), { target: { value: "this app only" } });
    fireEvent.change(within(form).getByLabelText("Expires"), { target: { value: "2027-01-31" } });
    fireEvent.submit(form);
    await waitFor(() => expect(add).toHaveBeenCalledWith("ms_1", { scope: "Rotate the child's own API key", limits: "this app only", expires: "2027-01-31" }));
    expect((await within(form).findByRole("status")).textContent).toBe("T3-G3 added (commit abc1234). The Delivery Manager is woken to act on it.");
    expect((within(form).getByLabelText("What it covers") as HTMLTextAreaElement).value).toBe("");
    expect((within(form).getByLabelText("Limits") as HTMLInputElement).value).toBe("");
    expect((within(form).getByLabelText("Expires") as HTMLInputElement).value).toBe("");
  });

  it("add: an error keeps the fields and shows the reason", async () => {
    vi.spyOn(api, "getApprovals").mockResolvedValue(VIEW);
    vi.spyOn(api, "addApproval").mockRejectedValue(new Error("nothing written: the checkout has uncommitted changes"));
    wrap();
    const form = await screen.findByTestId("add-grant-form");
    fireEvent.change(within(form).getByLabelText("What it covers"), { target: { value: "x" } });
    fireEvent.submit(form);
    expect((await within(form).findByRole("status")).textContent).toContain("uncommitted changes");
    expect((within(form).getByLabelText("What it covers") as HTMLTextAreaElement).value).toBe("x");
  });

  it("edit is prefilled (without the edited marker) and keeps the code; revoke sends the reason", async () => {
    vi.spyOn(api, "getApprovals").mockResolvedValue({ ...VIEW, grants: [{ ...VIEW.grants[0], scope: "Restart the child worker (edited 2026-10-24)" }] });
    const edit = vi.spyOn(api, "editApproval").mockResolvedValue(RESULT("T3-G1"));
    const revoke = vi.spyOn(api, "revokeApproval").mockResolvedValue({ ...RESULT("T3-G1"), wake: undefined });
    wrap();
    const row = await screen.findByTestId("grant-T3-G1");
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const form = within(row).getByTestId("edit-form-T3-G1");
    expect((within(form).getByLabelText("What it covers") as HTMLTextAreaElement).value).toBe("Restart the child worker");
    expect((within(form).getByLabelText("Expires") as HTMLInputElement).value).toBe("2099-01-01");
    fireEvent.change(within(form).getByLabelText("What it covers"), { target: { value: "Restart and drain the child worker" } });
    fireEvent.submit(form);
    await waitFor(() => expect(edit).toHaveBeenCalledWith("ms_1", "T3-G1", { scope: "Restart and drain the child worker", limits: "this host only", expires: "2099-01-01" }));
    expect((await screen.findByTestId("approvals-notice")).textContent).toContain("T3-G1 saved");

    fireEvent.click(within(screen.getByTestId("grant-T3-G1")).getByRole("button", { name: "Revoke" }));
    const rf = screen.getByTestId("revoke-form-T3-G1");
    fireEvent.change(within(rf).getByLabelText("Why revoke"), { target: { value: "the app is retired" } });
    fireEvent.submit(rf);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("ms_1", "T3-G1", "the app is retired"));
    expect((await screen.findByTestId("approvals-notice")).textContent).toBe("T3-G1 revoked (commit abc1234). No Delivery Manager is switched on: it reads the grant on its next wake.");
  });

  it("wake messages", () => {
    expect(writeMessage("added", { ...RESULT("T1-G1"), wake: { error: "already running" } })).toContain("was not woken (already running)");
  });
});
