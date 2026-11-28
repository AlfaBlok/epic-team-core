// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Persona, type TeamSkillsView } from "@/api";
import { PersonaDialog } from "@/components/dialogs";
import { SKINS, SkinProvider } from "@/lib/skin";
import { TeamSkillsPage } from "@/pages/TeamSkills";

/**
 * the social product's Skills page (the team's base skills read-only with use-when and used-by; the world's
 * own skills with add and remove) and the persona editor's pick-list offering both kinds (ticked assigns, unticked unassigns).
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SHA = "0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1";
const SHA2 = "ca45fc496a3436251f191354091d557da31c15b5";
const WORLD_VIEW: TeamSkillsView = {
  skills: [
    {
      name: "diagram-design",
      useWhen: "a branded editorial diagram",
      source: { type: "github", repo: "cathrynlavery/diagram-design", commit: SHA, path: "skills/diagram-design" },
      usedBy: [{ id: "p1", name: "Writer" }],
      scope: "base",
      removable: false,
    },
    { name: "pdf", useWhen: "work with PDF files", source: { type: "github", repo: "anthropics/skills", commit: SHA2, path: "skills/pdf" }, usedBy: [], scope: "world", removable: true },
  ],
  unknown: [],
  canEdit: true,
  syncNote: "A skill you add lives in this world's repo (skills/world-skills.json) and only this world's personas get it.",
  world: { id: "social", repo: "social" },
};

const page = () =>
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter>
        <TeamSkillsPage />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("T53-S6 Skills page in a world", () => {
  it("shows the base skills read-only (use-when, used-by) and the world's own with remove", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(WORLD_VIEW);
    page();
    expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
    const base = await screen.findByTestId("base-skills-section");
    const row = within(base).getByTestId("skill-diagram-design");
    expect(row.textContent).toContain("a branded editorial diagram");
    expect(row.textContent).toContain("Writer");
    expect(within(base).queryByLabelText("Remove diagram-design")).toBeNull();
    const own = screen.getByTestId("world-skills-section");
    expect(within(own).getByTestId("skill-pdf").textContent).toContain("work with PDF files");
    expect(within(own).getByLabelText("Remove pdf")).toBeTruthy();
    expect(screen.getByTestId("add-skill")).toBeTruthy();
  });

  it("removes a world skill with the world's words; a non-owner sees no buttons", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(WORLD_VIEW);
    const remove = vi.spyOn(api, "removeTeamSkill").mockResolvedValue({ removed: "pdf", sha: "abc", detachedFrom: [], sync: [{ host: "main", ok: true, note: "linked in 1 checkout of this world" }], syncNote: "" });
    page();
    fireEvent.click(await screen.findByLabelText("Remove pdf"));
    expect(screen.getByText(/It leaves this workspace's skills/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("skill-remove-confirm"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("pdf", false));
    expect((await screen.findByTestId("skill-done")).textContent).toContain("pdf removed");
    cleanup();
    vi.spyOn(api, "listTeamSkills").mockResolvedValue({ ...WORLD_VIEW, canEdit: false, skills: WORLD_VIEW.skills.map((s) => ({ ...s, removable: false })) });
    page();
    await screen.findByTestId("world-skills-section");
    expect(screen.queryByTestId("add-skill")).toBeNull();
    expect(screen.queryByLabelText("Remove pdf")).toBeNull();
    expect(screen.getByText(/Only the workspace's owner adds or removes its skills/)).toBeTruthy();
  });
});

describe("T53-S6 persona editor in a world: base and the world's own skills", () => {
  const persona: Persona = { id: "p1", name: "Writer", remit: "r", skills: ["diagram-design"], model: "claude-sonnet-5-5", mayWrite: false, host: "main", createdAt: "2026-11-01" } as Persona;

  it("ticks the world's skill to assign it and unticks a base one to take it off", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(WORLD_VIEW);
    const update = vi.spyOn(api, "updatePersona").mockResolvedValue({} as never);
    render(<PersonaDialog open onOpenChange={() => {}} persona={persona} />);
    const picker = await screen.findByTestId("skill-picker");
    const pdf = (await within(picker).findByLabelText("pdf")) as HTMLInputElement;
    expect(pdf.checked).toBe(false);
    expect(within(picker).getByText("this world's")).toBeTruthy();
    expect((within(picker).getByLabelText("diagram-design") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(pdf);
    fireEvent.click(within(picker).getByLabelText("diagram-design"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].skills).toEqual(["pdf"]);
  });
});
