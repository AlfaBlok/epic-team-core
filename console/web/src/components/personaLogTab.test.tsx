// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { PersonaLogTab } from "./personaLogTab";

// the owner, 24 Nov 05:11Z: "I want to see a list of all the things that happened that I didn't necessarily
// articulate ... we should be able to label, was this ... a correct one or an incorrect one?"
const step = (id: string, asked: boolean, label?: "correct" | "incorrect") => ({
  id: `run_${id}0000000-0000-0000-0000-000000000000`, at: "2026-11-24T04:00:00Z", persona: "Delivery Manager", worker: false,
  objective: "alignment", kr: "No card of mine was lost", row: "E907-S3", from: "Cards reach his inbox", did: `did ${id}`, why: "", asked, outcome: "progressed", ...(label ? { label } : {}),
});

describe("a wheel's Log tab", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens on the count of correct steps nobody asked for, lists the chosen ones, and labels one in one tap", async () => {
    vi.spyOn(api, "getPersonaLog").mockResolvedValue({ wheel: "alignment", days: 7, file: "docs/persona-log", steps: [step("a", false, "correct"), step("b", false), step("c", true)], counts: { steps: 3, unasked: 2, correct: 1, incorrect: 0, unlabelled: 1 } });
    const label = vi.spyOn(api, "labelStep").mockResolvedValue({ id: "x", label: "incorrect" });
    render(<PersonaLogTab wheel="alignment" />);
    expect((await screen.findByTestId("persona-log-answer")).textContent).toContain("1 correct step nobody asked for");
    expect(screen.getAllByTestId("persona-step").map((s) => s.getAttribute("data-asked"))).toEqual(["false", "false"]);
    fireEvent.click(screen.getAllByTestId("label-incorrect")[1]!);
    await waitFor(() => expect(label).toHaveBeenCalledWith(step("b", false).id, "incorrect"));
    expect(screen.getAllByTestId("persona-step")[1]!.getAttribute("data-label")).toBe("incorrect");
    fireEvent.click(screen.getByRole("tab", { name: /Every step/ }));
    expect(screen.getAllByTestId("persona-step")).toHaveLength(3);
  });
});
