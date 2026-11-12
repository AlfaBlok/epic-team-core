// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, type Repo } from "@/api";
import { MilestoneDialog } from "@/components/dialogs";
import { filterRepos } from "@/components/pickers";

afterEach(cleanup);

const repos = (): HTMLElement => screen.getByRole("listbox", { name: "Repos" });
const files = (): HTMLElement => screen.getByRole("listbox", { name: "Spine files" });

async function pickRepo(name: string) {
  fireEvent.change(screen.getByLabelText("Search repos"), { target: { value: name } });
  const opt = await within(repos()).findByText(name);
  fireEvent.click(opt);
}

const pickMode = (label: RegExp) => fireEvent.click(screen.getByRole("radio", { name: label }));
const TRACK = /Track an existing spine/;
const CREATE = /Create a new epic/;

describe("filterRepos", () => {
  const list: Repo[] = [
    { name: "ops", path: "/g/ops", remote: "Acme/ops", hasEpicSpine: true },
    { name: "memo-cloud", path: "/g/memo-cloud", remote: "acme-ai/cloud", hasEpicSpine: false },
  ];
  it("matches name or remote, case-insensitive", () => {
    expect(filterRepos(list, "OPS").map((r) => r.name)).toEqual(["ops"]);
    expect(filterRepos(list, "acme-ai").map((r) => r.name)).toEqual(["memo-cloud"]);
    expect(filterRepos(list, " ")).toHaveLength(2);
  });
});

describe("Add-milestone dialog", () => {
  it("is titled 'Add milestone' and asks track vs create only after a repo is picked", async () => {
    render(<MilestoneDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "Add project" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Project source" })).toBeNull();
    await pickRepo("ops");
    const radios = within(screen.getByRole("radiogroup", { name: "Project source" })).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    // Nothing else until a mode is chosen; the doc picker no longer offers bootstrap.
    expect(screen.queryByRole("listbox", { name: "Spine files" })).toBeNull();
    expect(screen.queryByLabelText("Title")).toBeNull();
    pickMode(TRACK);
    expect(await within(files()).findByText(/Custom path/)).toBeTruthy();
    expect(within(files()).queryByText(/New epic/)).toBeNull();
    expect(screen.queryByLabelText("Goal")).toBeNull();
    expect(screen.getByRole("button", { name: "Add project" })).toBeTruthy();
    pickMode(CREATE);
    expect(screen.queryByRole("listbox", { name: "Spine files" })).toBeNull();
    expect(screen.getByLabelText("Goal")).toBeTruthy();
    expect(screen.getByLabelText("Kind")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create epic" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add project" })).toBeNull();
  });

  it("picks repo → doc (kind, title, DoD) and auto-fills the title, then creates the milestone", async () => {
    const onCreated = vi.fn();
    render(<MilestoneDialog open onOpenChange={() => {}} onCreated={onCreated} />);
    await within(repos()).findByText("home_repo");
    fireEvent.change(screen.getByLabelText("Search repos"), { target: { value: "ops" } });
    expect(within(repos()).queryByText("home_repo")).toBeNull();
    fireEvent.click(within(repos()).getByText("ops"));
    pickMode(TRACK);

    const e5 = await within(files()).findByText('E5: Fleet Observatory (milestone "M2")');
    const row = e5.closest('[role="option"]') as HTMLElement;
    expect(within(row).getByText("ticket")).toBeTruthy();
    expect(within(row).getByText("DoD 0/7")).toBeTruthy();
    // spines are listed first
    expect(within(files()).getAllByRole("option")[0].textContent).toMatch(/^spine/);

    expect((screen.getByRole("button", { name: "Add project" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe('ops · E5: Fleet Observatory (milestone "M2")');
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const m = onCreated.mock.calls[0][0];
    expect(m).toMatchObject({ repo: "Acme/ops", path: "tickets/E5-fleet-observatory.md", dod: { done: 0, total: 7 } });
    expect((await api.getMilestone(m.id)).title).toBe('ops · E5: Fleet Observatory (milestone "M2")');
  });

  it("keeps a title the user typed and supports a custom path", async () => {
    const onCreated = vi.fn();
    render(<MilestoneDialog open onOpenChange={() => {}} onCreated={onCreated} />);
    await pickRepo("home_repo");
    pickMode(TRACK);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My title" } });
    pickMode(TRACK);
    fireEvent.click(await within(files()).findByText("EPIC: Agent team"));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("My title");
    fireEvent.click(within(files()).getByText(/Custom path/));
    fireEvent.change(screen.getByLabelText("Custom path"), { target: { value: "docs/spines/new.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreated.mock.calls[0][0]).toMatchObject({ title: "My title", repo: "Acme/home_repo", path: "docs/spines/new.md" });
  });

  it("'Create a new epic' bootstraps the milestone in the picked repo", async () => {
    const onCreated = vi.fn();
    render(<MilestoneDialog open onOpenChange={() => {}} onCreated={onCreated} />);
    await pickRepo("ops");
    pickMode(CREATE);
    expect(screen.getByRole("radio", { name: CREATE }).getAttribute("aria-checked")).toBe("true");
    const submit = screen.getByRole("button", { name: "Create epic" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "ops · E6 Backups" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Nightly offsite backups" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "ticket" } });
    const spy = vi.spyOn(api, "bootstrapMilestone");
    fireEvent.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "Acme/ops", title: "ops · E6 Backups", goal: "Nightly offsite backups", kind: "ticket" }),
    );
    expect(onCreated.mock.calls[0][0]).toMatchObject({ repo: "Acme/ops", path: "" });
    spy.mockRestore();
  });
});

describe("Doc picker from spines.py", () => {
  it("lists the spine tree (indented, status word + rollup) and flags orphans with the reason", async () => {
    render(<MilestoneDialog open onOpenChange={() => {}} />);
    await pickRepo("home_repo");
    pickMode(TRACK);
    const m5 = (await within(files()).findByText("M5 — Unblocked web access")).closest('[role="option"]') as HTMLElement;
    expect(within(m5).getByText("draft")).toBeTruthy();
    const titles = within(files()).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(titles[0]).toMatch(/EPIC: Agent team/);
    expect(titles[1]).toMatch(/M2 — Team console/);
    const orphan = (await within(files()).findByText("Old plan")).closest('[role="option"]') as HTMLElement;
    expect(within(orphan).getByText("orphan")).toBeTruthy();
    expect(within(orphan).getByText(/not reachable from the root/)).toBeTruthy();
    expect(within(m5).queryByText("orphan")).toBeNull();
    expect(screen.queryByText(/^fallback:/)).toBeNull();
  });

  it("shows a fallback note when the server used path rules", async () => {
    render(<MilestoneDialog open onOpenChange={() => {}} />);
    await pickRepo("ops");
    pickMode(TRACK);
    await within(files()).findByText('E5: Fleet Observatory (milestone "M2")');
    expect(screen.getByText(/^fallback:/)).toBeTruthy();
  });
});
