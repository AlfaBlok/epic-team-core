// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Me, type Persona } from "@/api";
import { PersonasPage } from "@/pages/Personas";

// a tester world's personas do not wake on the shared hosts until its own box
// exists; its Personas page says why (`wakeHold` from /api/me). the home world and a social world repo see no note.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HOLD = "worlds other than acme do not run agents on shared hosts yet (PLAN-23): this world's personas stay asleep until its own isolated box exists; its console, drafts and approvals keep working";
const me = (tenant: string, wakeHold?: string): Me =>
  ({ mode: "on", identity: { kind: "session", tenantId: tenant, email: "t@example.com", name: "", role: "owner" }, tenant: null, worlds: [], ...(wakeHold ? { wakeHold } : {}) }) as unknown as Me;

function mount(m: Me) {
  vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_w", name: "Writer", remit: "w", skills: [], model: "opus", mayWrite: true, createdAt: "" } as Persona]);
  vi.spyOn(api, "listAssignments").mockResolvedValue([]);
  vi.spyOn(api, "listMilestones").mockResolvedValue([]);
  vi.spyOn(api, "listRuns").mockResolvedValue([]);
  (api as { getMe?: () => Promise<Me> }).getMe = vi.fn(async () => m);
  render(
    <MemoryRouter>
      <PersonasPage />
    </MemoryRouter>,
  );
}

describe("T59-S4 Personas page: the world wake gate's reason", () => {
  it("a held tester world sees why its personas do not wake", async () => {
    mount(me("es-tina-1a2b", HOLD));
    const note = await screen.findByTestId("wake-hold");
    expect(note.textContent).toContain("These personas do not wake yet");
    expect(note.textContent).toContain("PLAN-23");
    expect(await screen.findByText("Writer")).toBeTruthy();
  });

  it("acme (or social) gets no note", async () => {
    mount(me("acme"));
    expect(await screen.findByText("Writer")).toBeTruthy();
    expect(screen.queryByTestId("wake-hold")).toBeNull();
  });
});
