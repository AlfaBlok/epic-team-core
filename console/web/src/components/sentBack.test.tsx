// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { SentBackCard } from "@/api/review-types";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";
import { LandFolded } from "./homeSection";
import { InboxSentBack, SENT_BACK_SECTION, workerLine } from "./sentBack";

/**
 * (the owner 2026-11-22 23:07Z: "Why is it not on my inbox if it doesn't come back to me, then it gets lost ... so that
 * I can keep giving input until it gets built?"): a card he sent back stays on his Inbox, marked in progress with its
 * worker, and its Voice and Text block still sends his words to the row.
 */
const card = (o: Partial<SentBackCard>): SentBackCard => ({ id: "rv_1", ref: "E907-S3", repo: "sample", path: "docs/spines/sample.md", milestoneId: "ms_1", title: "The sample page was made clearer.", state: "in_progress", iteration: 3, words: "Where is the kernel thing?", since: new Date(Date.now() - 3_600_000).toISOString(), worker: { run: "run_sample", persona: "Ticket worker", host: "host1", startedAt: "2026-11-22T22:52:00Z", live: true }, ...o });
const CARDS = [card({}), card({ id: "rv_2", ref: "E907-S4", title: "A queued one.", state: "waiting", iteration: 2, worker: undefined, words: undefined }), card({ id: "rv_3", ref: "E907-S5", title: "A folded one.", state: "closed_by_team", worker: undefined, why: "done (folded into E907-S9)" })];

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const draw = (inbox = false) =>
  render(
    <SkinProvider skin={SKINS.console}>
      <MemoryRouter>
        <ProjectProvider>
          <LandFolded.Provider value={inbox}>
            <InboxSentBack />
          </LandFolded.Provider>
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
/** E948-S208: the section starts folded; his tap on its heading opens it */
const openIt = async () => fireEvent.click(await screen.findByTestId("sent-back-toggle"));

describe("Sent back, in progress", () => {
  it("lists only work truly in progress: its worker, the round and his own words; a waiting one or one the team closed never shows", async () => {
    vi.spyOn(api as Required<typeof api>, "listSentBackCards").mockResolvedValue(CARDS);
    draw();
    const section = await screen.findByTestId("sent-back");
    expect(section.textContent).toContain(SENT_BACK_SECTION);
    expect(within(section).getByTestId("sent-back-count").textContent).toBe("1");
    await openIt();
    const cards = within(section).getAllByTestId("sent-back-card");
    expect(cards.map((c) => [c.getAttribute("data-ref"), c.getAttribute("data-state")])).toEqual([["E907-S3", "in_progress"]]);
    expect(within(cards[0]).getByTestId("sent-back-state").textContent).toBe("In progress");
    expect(within(cards[0]).getByTestId("sent-back-worker").textContent).toMatch(/^Ticket worker on host1, since \d/);
    expect(cards[0].textContent).toContain("round 3");
    expect(within(cards[0]).getByTestId("sent-back-words").textContent).toBe("You said: Where is the kernel thing?");
    expect(section.textContent).not.toContain("Closed by the team");
    expect(section.textContent).not.toContain("Waiting for a worker");
    for (const c of cards) expect(within(c).getByTestId("card-feedback-text")).toBeTruthy();
  });

  it("he takes a card off the list with its x; it stays off after a reload and returns only when he sends it back again", async () => {
    const list = vi.spyOn(api as Required<typeof api>, "listSentBackCards").mockResolvedValue(CARDS);
    draw();
    await openIt();
    const [first] = await screen.findAllByTestId("sent-back-card");
    fireEvent.click(within(first).getByTestId("sent-back-away"));
    await waitFor(() => expect(screen.queryByTestId("sent-back")).toBeNull());
    cleanup();
    draw();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("sent-back")).toBeNull();
    cleanup();
    list.mockResolvedValue([card({ since: new Date().toISOString() })]);
    draw();
    // the home kept his open tap from before (per viewer)
    expect(await screen.findAllByTestId("sent-back-card")).toHaveLength(1);
  });

  it("his words on a card in progress go to its row, said as input for the round in work", async () => {
    vi.spyOn(api as Required<typeof api>, "listSentBackCards").mockResolvedValue(CARDS);
    const sent = vi.spyOn(api, "commentClosedCard").mockResolvedValue({ sha: "abc1234" });
    draw();
    await openIt();
    const [first] = await screen.findAllByTestId("sent-back-card");
    fireEvent.click(within(first).getByTestId("card-feedback-text"));
    fireEvent.change(within(first).getByRole("textbox"), { target: { value: "Also show it on the phone" } });
    fireEvent.click(within(first).getByTestId("card-feedback-send"));
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent.mock.calls[0][0]).toEqual({ kind: "review", repo: "sample", path: "docs/spines/sample.md", ref: "E907-S3", title: "The sample page was made clearer.", milestoneId: "ms_1", text: "Also show it on the phone", via: "text", stage: "in_work" });
    // the card stays where it is, and says his words went
    await waitFor(() => expect(first.textContent).toContain("Sent ✓"));
    expect(screen.getAllByTestId("sent-back-card")).toHaveLength(1);
  });

  it("E948-S208 (vn_7a378324): starts folded with its count, on the Inbox and the home alike, even a card sent back a minute ago; his tap opens it and the home keeps his choice", async () => {
    vi.spyOn(api as Required<typeof api>, "listSentBackCards").mockResolvedValue([card({ since: new Date(Date.now() - 60_000).toISOString() }), card({ id: "rv_4", ref: "E907-S6" })]);
    for (const inbox of [true, false]) {
      draw(inbox);
      const section = await screen.findByTestId("sent-back");
      expect(within(section).getByTestId("sent-back-count").textContent).toBe("2");
      expect(within(section).getByTestId("sent-back-toggle").getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByTestId("sent-back-section")).toBeNull();
      expect(screen.queryAllByTestId("sent-back-card")).toHaveLength(0);
      await openIt();
      expect(await screen.findAllByTestId("sent-back-card")).toHaveLength(2);
      cleanup();
    }
    // the home keeps his own tap (per viewer, this browser); the Inbox lands folded on every visit
    draw(false);
    expect(await screen.findAllByTestId("sent-back-card")).toHaveLength(2);
    cleanup();
    draw(true);
    await screen.findByTestId("sent-back");
    expect(screen.queryAllByTestId("sent-back-card")).toHaveLength(0);
  });

  it("nothing sent back: no section at all", async () => {
    const list = vi.spyOn(api as Required<typeof api>, "listSentBackCards").mockResolvedValue([]);
    draw();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByTestId("sent-back")).toBeNull();
  });

  it("workerLine says a held claim and a plain worker", () => {
    expect(workerLine({ state: "in_progress", worker: { run: "run_abcdef123456", live: false } })).toBe("Held by a worker (run_abcdef12).");
    expect(workerLine({ state: "in_progress" })).toBe("A worker is on it.");
    expect(workerLine({ state: "in_progress", continuesIn: "E907-S9", worker: { run: "run_x", host: "host1", live: true } })).toBe("A worker on host1. It continues as E907-S9 and comes back as that card.");
    expect(workerLine({ state: "waiting", checkAt: "2026-11-23T08:30Z" })).toMatch(/^It waits on a timed check, due .+\. No worker is needed until then\.$/);
  });
});
