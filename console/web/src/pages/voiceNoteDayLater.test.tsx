// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Assignment, type Persona } from "@/api";
import { GapFinderPage, askCounts, noteTally, runCounts, type NoteCheck } from "@/pages/GapFinder";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_gap", name: "Gap finder" } as Persona]);
  vi.spyOn(api, "listAssignments").mockResolvedValue([{ id: "as_gap", personaId: "pe_gap", milestoneId: "ms_1", enabled: true } as Assignment]);
});

/**
 * /gap-finder shows every voice note checked a day
 * later, ask by ask, and what is offered for a missed one.
 */
const NOTES: NoteCheck[] = [
  {
    id: "vn_365ac7cd",
    where: "Card answer on T92-A1",
    recordedAt: "2026-11-09T23:41:00Z",
    checkedAt: "2026-11-10T02:00:00Z",
    run: "2026-11-10",
    gist: "Voice notes in one place, a second look a day later, a demo video, group mailboxes.",
    asks: [
      { ask: "Every voice note lands in one place", words: "all my voice notes are landing in one place", state: "reflected", where: "T42-S42, done", link: "https://example.test/e42" },
      { ask: "A demo video of the catch", words: "I also really want to have a video", state: "partly", where: "T84-S16, ready", why: "Planned, not made yet." },
      { ask: "Post it", words: "why can we not post this?", state: "missed", why: "No row posts it.", followup: "Post the demo once it is made" },
    ],
  },
  { id: "e-2e8bc4", where: "WhatsApp", recordedAt: "2026-11-09T23:47:48Z", checkedAt: "2026-11-10T02:00:00Z", run: "2026-11-10", gist: "Background sound only.", asks: [] },
  { id: "e-7dec46", where: "WhatsApp", recordedAt: "2026-11-09T21:52:43Z", checkedAt: "2026-11-10T02:00:00Z", run: "2026-11-10", gist: "A private note.", private: true, asks: [{ ask: "Research rentals", words: "secret words", state: "reflected", where: "a row", link: "https://example.test/r" }] },
];

const at = (path: string, notes: unknown) => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/notes.json")) return new Response(JSON.stringify(notes), { status: 200 });
    return new Response(JSON.stringify({ runs: [{ date: "2026-11-10", title: "Every voice note, a day later", page: "2026-11-10.html", row: "T79-G20261110", gaps: 0, notes: 3, asks: 4, reflected: 2, partly: 1, missed: 1 }] }), { status: 200 });
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/gap-finder" element={<GapFinderPage />} />
      </Routes>
    </MemoryRouter>,
  );
};

describe("T79-S2 every voice note, a day later", () => {
  it("lists each checked note with its asks, their states, his words and what is offered", async () => {
    at("/gap-finder", { notes: NOTES });
    const section = await screen.findByTestId("gap-finder-notes");
    expect(within(section).getByTestId("gap-finder-notes-total").textContent).toContain("3 voice notes checked, 4 asks: 2 reflected, 1 partly, 1 missed");
    const notes = within(section).getAllByTestId("gap-finder-note");
    expect(notes).toHaveLength(3);
    const first = notes[0];
    expect(first.hasAttribute("open")).toBe(true); // a note with a missed ask opens by itself
    expect(within(first).getByTestId("gap-finder-note-tally").textContent).toBe("1 reflected1 partly1 missed");
    const asks = within(first).getAllByTestId("gap-finder-ask");
    expect(asks.map((a) => a.getAttribute("data-state"))).toEqual(["reflected", "partly", "missed"]);
    expect(asks[0].textContent).toContain("“all my voice notes are landing in one place”");
    expect(within(asks[0]).getByRole("link").getAttribute("href")).toBe("https://example.test/e42");
    expect(within(asks[2]).getByTestId("gap-finder-offered").textContent).toContain("Post the demo once it is made");
    expect(within(first).getByText(/In the run of/).getAttribute("href")).toBe("/gap-finder/2026-11-10#vn_365ac7cd");
    expect(notes[1].textContent).toContain("nothing for the team");
    expect(notes[2].textContent).not.toContain("secret words"); // a private note never shows his words
    expect((await screen.findByTestId("gap-finder-run")).textContent).toContain("3 voice notes checked a day later: 4 asks: 2 reflected, 1 partly, 1 missed");
  });

  it("shows nothing of it before any note was checked, or when the list cannot be read", async () => {
    at("/gap-finder", { notes: [] });
    await screen.findByTestId("gap-finder-run");
    expect(screen.queryByTestId("gap-finder-notes")).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_gap", name: "Gap finder" } as Persona]);
    vi.spyOn(api, "listAssignments").mockResolvedValue([{ id: "as_gap", personaId: "pe_gap", milestoneId: "ms_1", enabled: true } as Assignment]);
    at("/gap-finder", "not json {");
    await screen.findByTestId("gap-finder-run");
    expect(screen.queryByTestId("gap-finder-notes")).toBeNull();
  });

  it("counts asks by state", () => {
    expect(askCounts({ asks: 5, reflected: 4, missed: 1 })).toBe("5 asks: 4 reflected, 1 missed");
    expect(askCounts({ asks: 0 })).toBe("0 asks");
    expect(noteTally(NOTES[0])).toEqual({ asks: 3, reflected: 1, partly: 1, missed: 1 });
    expect(runCounts({ date: "d", title: "t", page: "p", row: "r", gaps: 0, notes: 1, asks: 1, reflected: 1 })).toBe("1 voice note checked a day later: 1 ask: 1 reflected");
  });
});
