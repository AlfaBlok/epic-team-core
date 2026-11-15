// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { VoiceNotesPage } from "@/components/voiceNotesIndex";
import type { VoiceNotesBody } from "@/api/pages-types";

/** His voice notes in one place, the first product's first, a product filter, each note linking to its rows. */
const NOTES: VoiceNotesBody["notes"] = [
  { ref: "Log/a#^e-aaaaaa", key: "e-aaaaaa", source: "whatsapp", app: "WhatsApp", at: "2026-11-12T19:23:00Z", words: "harmonize them", chars: 14, url: "https://example.com/Log/a", products: ["alpha", "beta"], state: "open", rows: [{ code: "E904-S1", repo: "team", spine: "docs/spines/e.md", epic: "EPIC-904", status: "active", title: "The tidy persona", via: "row" }] },
  { ref: "Log/a#^e-bbbbbb", key: "e-bbbbbb", source: "mcp", app: "Chat", at: "2026-11-12T18:00:00Z", words: "posts on time", chars: 13, products: ["beta"], state: "not linked", rows: [] },
];
const body = (product?: string): VoiceNotesBody => ({
  generatedAt: "2026-11-12T20:00:00Z",
  windowHours: 48,
  counts: {},
  products: { alpha: 1, beta: 2 },
  productNames: { alpha: "Alpha", beta: "Beta" },
  notes: NOTES.filter((n) => !product || product === "all" || n.products.includes(product)),
});

describe("voice notes page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens on the first product's notes, each with its rows linking to the epic deck, and filters by product", async () => {
    const spy = vi.spyOn(api, "listVoiceNotes").mockImplementation(async (p) => body(p));
    render(
      <MemoryRouter initialEntries={["/voice-notes"]}>
        <VoiceNotesPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("alpha"));
    let notes = await screen.findAllByTestId("voice-note");
    await waitFor(() => expect(screen.getAllByTestId("voice-note")).toHaveLength(1));
    notes = screen.getAllByTestId("voice-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("harmonize them");
    const row = within(notes[0]).getByRole("link", { name: "E904-S1" });
    expect(row.getAttribute("href")).toBe("/deck/team/EPIC-904");
    expect(within(notes[0]).getByRole("link", { name: "in your memory" }).getAttribute("href")).toBe("https://example.com/Log/a");
    expect(screen.getByTestId("voice-notes-filter-beta").textContent).toBe("Beta 2");
    fireEvent.click(screen.getByTestId("voice-notes-filter-beta"));
    await waitFor(() => expect(screen.getAllByTestId("voice-note")).toHaveLength(2));
    expect(spy).toHaveBeenLastCalledWith("beta");
    notes = screen.getAllByTestId("voice-note");
    expect(within(notes[1]).getByTestId("voice-note-state").textContent).toBe("not linked");
    expect(screen.getByTestId("voice-notes-summary").textContent).toContain("2 notes");
  });
});
