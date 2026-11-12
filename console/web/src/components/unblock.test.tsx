// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type NeedsOwner, type Run, type WaitingItem } from "@/api";
import { BlockedBy, ClampText, GrantWriteDialog, isWriteAsk, Linkified, shorten, waitingAnchor, WriteControl } from "@/components/unblock";
import { WaitingCard } from "@/components/waiting";

// Radix Switch measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

// The live E904 run, 2026-10-21: one long summary, blocked on two Needs the owner items.
const LONG =
  "Blocked: E904 needs git write to commit the one-logger branch and root on HOST1 for the logger unit (raised nj_f480d480-1111-2222-3333-444455556666 and nj_20839f54-aaaa-bbbb-cccc-ddddeeeeffff); " +
  "diagnosis: the market feed is observed twice because two loggers subscribe; /srv/poly/poly-maker/services/logger/one_logger_supervisor_with_a_very_long_path_name.py";
const run = (over: Partial<Run> = {}): Run => ({
  id: "run_1",
  assignmentId: "as_1",
  milestoneId: "ms_1",
  startedAt: "2026-10-21T20:00:00Z",
  outcome: "blocked",
  summary: LONG,
  ...over,
});
const nj = (over: Partial<NeedsOwner> = {}): NeedsOwner => ({
  id: "nj_f480d480",
  runId: "run_1",
  milestoneId: "ms_1",
  question: "I am diagnose-only (mayWrite=false). Grant git-only write scope so I can commit the one-logger branch and update the spine?",
  proposedAction: "Set write for git only: branches one-logger*, spine main-direct; no prod/root",
  status: "open",
  createdAt: "2026-10-21T20:05:00Z",
  ...over,
});
const ROOT = nj({ id: "nj_20839f54", question: "Run the root steps on HOST1 (systemd unit for the logger)?", proposedAction: "sudo systemctl enable --now one-logger.service on host1" });

describe("ClampText (M2-19 overflow)", () => {
  it("wraps long tokens and clamps; 'show more' only when clamped, toggles without following a surrounding link", () => {
    const sh = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
    const outer = vi.fn();
    wrap(
      <a href="/x" onClick={outer}>
        <ClampText text={LONG} milestoneId="ms_1" links={false} />
      </a>,
    );
    const body = screen.getByTitle(LONG);
    expect(body.className).toContain("line-clamp-2");
    expect(body.className).toContain("break-words");
    expect(body.className).toContain("[overflow-wrap:anywhere]");
    const more = screen.getByRole("button", { name: "show more" });
    fireEvent.click(more);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByTitle(LONG).className).not.toContain("line-clamp-2");
    fireEvent.click(screen.getByRole("button", { name: "show less" }));
    expect(screen.getByTitle(LONG).className).toContain("line-clamp-2");
    sh.mockReturnValue(40);
    cleanup();
    wrap(<ClampText text="short" />);
    expect(screen.queryByRole("button", { name: "show more" })).toBeNull();
  });

  it("turns bare nj_ ids into links to their Waiting-on-you card", () => {
    wrap(<Linkified text={LONG} milestoneId="ms_1" />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["nj_f480d480-1111-2222-3333-444455556666", "nj_20839f54-aaaa-bbbb-cccc-ddddeeeeffff"]);
    expect(links[0].getAttribute("href")).toBe("/milestones/ms_1?tab=waiting&item=nj_f480d480-1111-2222-3333-444455556666");
    cleanup();
    wrap(<Linkified text={LONG} milestoneId="ms_1" links={false} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("shorten cuts at a word boundary with an ellipsis", () => {
    expect(shorten("short")).toBe("short");
    const s = shorten(LONG, 80);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("BlockedBy (M2-19 blocked run shows how to unblock)", () => {
  it("lists each open Needs Sam item of the blocked run as a link with its question and a bold To unblock line", () => {
    wrap(<BlockedBy last={run()} runs={[run()]} needsOwner={[nj(), ROOT, nj({ id: "nj_done", status: "approved" }), nj({ id: "nj_other", runId: "run_x" })]} milestoneId="ms_1" />);
    const box = screen.getByTestId("blocked-by");
    expect(box.textContent).toContain("Blocked on you (2)");
    const links = within(box).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["nj_f480d480", "/milestones/ms_1?tab=waiting&item=nj_f480d480"],
      ["nj_20839f54", "/milestones/ms_1?tab=waiting&item=nj_20839f54"],
    ]);
    const unblock = within(box).getAllByText(/^To unblock:/);
    expect(unblock.map((u) => u.textContent)).toEqual([
      "To unblock: Set write for git only: branches one-logger*, spine main-direct; no prod/root",
      "To unblock: sudo systemctl enable --now one-logger.service on host1",
    ]);
    expect(unblock[0].className).toContain("font-semibold");
    // Only the write ask offers the grant.
    expect(within(box).getAllByRole("button", { name: /Approve and grant write/ })).toHaveLength(1);
  });

  it("after a later run moved on, still-open items stay listed (amber, not 'Blocked'); nothing when none are open", () => {
    const later = run({ id: "run_2", outcome: "progressed", startedAt: "2026-10-21T21:53:00Z" });
    wrap(<BlockedBy last={later} runs={[run(), later]} needsOwner={[nj(), ROOT]} milestoneId="ms_1" />);
    const box = screen.getByTestId("blocked-by");
    expect(box.textContent).toContain("Still open from earlier runs (2)");
    expect(box.textContent).not.toContain("Blocked on you");
    expect(within(box).getAllByText(/^To unblock:/)).toHaveLength(2);
    cleanup();
    const { container } = wrap(<BlockedBy last={later} runs={[run(), later]} needsOwner={[nj({ status: "approved" })]} milestoneId="ms_1" />);
    expect(container.textContent).toBe("");
  });

  it("write-ask heuristic", () => {
    expect(isWriteAsk(nj())).toBe(true);
    expect(isWriteAsk({ question: "allow write to git for E904?" })).toBe(true);
    expect(isWriteAsk({ question: "extend write scope", proposedAction: "" })).toBe(true);
    expect(isWriteAsk(ROOT)).toBe(false);
  });
});

describe("Approve and grant write (M2-20)", () => {
  it("dialog prefills the scope from proposedAction, lets Sam edit it, and approves with grantWrite", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_1", itemId: "nj_f480d480", kind: "approve", text: "", delivery: "sent", createdAt: "" });
    const onOpenChange = vi.fn();
    wrap(<GrantWriteDialog open onOpenChange={onOpenChange} itemId="nj_f480d480" milestoneId="ms_1" question={nj().question} proposedAction={nj().proposedAction} />);
    const scope = screen.getByLabelText("Write scope") as HTMLTextAreaElement;
    expect(scope.value).toBe(nj().proposedAction);
    fireEvent.change(scope, { target: { value: "git only: branches one-logger*; no prod/root" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: /Approve and grant write/ }));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(spy).toHaveBeenCalledWith("nj_f480d480", { kind: "approve", text: "ok", milestoneId: "ms_1", grantWrite: { scope: "git only: branches one-logger*; no prod/root" } });
  });

  it("an empty scope cannot be confirmed", () => {
    wrap(<GrantWriteDialog open onOpenChange={() => {}} itemId="nj_1" milestoneId="ms_1" question="q" proposedAction="" />);
    expect((screen.getByRole("button", { name: /Approve and grant write/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Waiting-on-you card: anchor id for links, and the extra action only on write asks (plain Approve stays)", () => {
    const item = (over: Partial<WaitingItem>): WaitingItem => ({
      id: "nj_f480d480",
      source: "needs_jordi",
      state: "open",
      milestoneId: "ms_1",
      milestoneTitle: "E904",
      title: "t",
      ask: "approve",
      question: nj().question,
      proposedAction: nj().proposedAction,
      contextLinks: [],
      owner: { kind: "assignment", label: "Delivery Manager" },
      decidable: true,
      needsJordiId: "nj_f480d480",
      ...over,
    });
    const { container } = wrap(<WaitingCard item={item({})} />);
    expect(container.querySelector(`#${waitingAnchor("nj_f480d480")}`)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Approve and grant write/ }));
    expect((screen.getByLabelText("Write scope") as HTMLTextAreaElement).value).toBe(nj().proposedAction);
    cleanup();
    wrap(<WaitingCard item={item({ id: "nj_20839f54", question: ROOT.question, proposedAction: ROOT.proposedAction })} />);
    expect(screen.queryByRole("button", { name: /Approve and grant write/ })).toBeNull();
  });
});

describe("WriteControl (M2-20 per-assignment write, revocable)", () => {
  const a: Assignment = { id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 240 }, enabled: true, writeEnabled: true, writeScope: "git only" };
  it("shows on + scope and turns it off", async () => {
    const spy = vi.spyOn(api, "updateAssignment").mockResolvedValue({ ...a, writeEnabled: false });
    wrap(<WriteControl a={a} />);
    const box = screen.getByTestId("write-control");
    expect(box.textContent).toContain("Write: on");
    expect(box.textContent).toContain("scope: git only");
    fireEvent.click(screen.getByRole("switch", { name: "Write on this project" }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("as_1", { writeEnabled: false }));
  });
  it("turning on with no scope asks for one first", async () => {
    const spy = vi.spyOn(api, "updateAssignment").mockResolvedValue(a);
    wrap(<WriteControl a={{ ...a, writeEnabled: false, writeScope: "" }} />);
    expect(screen.getByTestId("write-control").textContent).toContain("Write: off");
    fireEvent.click(screen.getByRole("switch", { name: "Write on this project" }));
    expect(spy).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Write scope"), { target: { value: "git only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and turn on" }));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("as_1", { writeScope: "git only", writeEnabled: true }));
  });
});
