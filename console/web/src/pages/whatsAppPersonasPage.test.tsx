// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Persona, type WhatsAppHolderView } from "@/api";
import { WhatsAppSender } from "@/pages/Personas";

// the Personas page shows who sends the owner WhatsApp, for which milestones, which path sends now,
// and lets him pick the one persona that holds the skill.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const personas = [
  { id: "pe_dm", name: "Delivery Manager", remit: "", skills: [], model: "m", mayWrite: true, createdAt: "" },
  { id: "pe_gap", name: "Gap finder", remit: "", skills: [], model: "m", mayWrite: false, createdAt: "" },
] as unknown as Persona[];
const view = (o: Partial<WhatsAppHolderView> = {}): WhatsAppHolderView => ({
  skill: "whatsapp-notify",
  holder: { id: "pe_dm", name: "Delivery Manager", explicit: false },
  milestones: [{ id: "ms_1", title: "Talk to the desk" }],
  sender: "console",
  configured: true,
  ...o,
});

describe("T42-S41 WhatsApp to Sam on the Personas page", () => {
  it("names the default sender, its milestones and that the console still sends", () => {
    render(<MemoryRouter><WhatsAppSender view={view()} personas={personas} /></MemoryRouter>);
    expect(screen.getByTestId("wa-holder").textContent).toContain("Nobody was picked, so the Delivery Manager does it.");
    expect(screen.getByTestId("wa-milestones").textContent).toContain("Talk to the desk");
    expect(screen.getByTestId("wa-path").textContent).toContain("The console still sends them until Delivery Manager sends one test message");
  });

  it("after the handover it says the persona sends; picking another persona saves and says so at the button", async () => {
    const set = vi.fn().mockResolvedValue(view({ holder: { id: "pe_gap", name: "Gap finder", explicit: true } }));
    (api as { setWhatsAppHolder?: unknown }).setWhatsAppHolder = set;
    render(<MemoryRouter><WhatsAppSender view={view({ holder: { id: "pe_dm", name: "Delivery Manager", explicit: true }, sender: "persona", handoverAt: "2026-11-09T19:00:00Z", milestones: [] })} personas={personas} /></MemoryRouter>);
    expect(screen.getByTestId("wa-path").textContent).toContain("Delivery Manager has sent them since");
    expect(screen.getByTestId("wa-milestones").textContent).toContain("not placed on any project");
    fireEvent.change(screen.getByTestId("wa-pick"), { target: { value: "pe_gap" } });
    fireEvent.click(screen.getByTestId("wa-set"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Gap finder now sends your WhatsApp messages"));
    expect(set).toHaveBeenCalledWith("pe_gap");
  });
});
