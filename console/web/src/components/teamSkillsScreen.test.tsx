// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Persona, type TeamSkillsView } from "@/api";
import { PersonaDialog } from "@/components/dialogs";
import { TeamSkillsPage } from "@/pages/TeamSkills";

/** the Team skills screen (list, add by URL with a preview, remove with a warning) and the persona editor's pick-list. */
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
const VIEW: TeamSkillsView = {
  skills: [
    { name: "diagram", useWhen: "one clean diagram image", source: { type: "local", path: "skills/diagram" }, url: "https://github.com/Acme/home_repo/tree/main/skills/diagram", usedBy: [] },
    {
      name: "diagram-design",
      useWhen: "a branded editorial diagram",
      source: { type: "github", repo: "cathrynlavery/diagram-design", commit: SHA, path: "skills/diagram-design" },
      url: `https://github.com/cathrynlavery/diagram-design/tree/${SHA}/skills/diagram-design`,
      usedBy: [{ id: "p1", name: "Writer" }],
    },
  ],
  unknown: [{ skill: "gh", persona: { id: "p2", name: "Steward" } }],
  canEdit: true,
  syncNote: "host1 at once; host3 within 10 min",
};

const page = () =>
  render(
    <MemoryRouter>
      <TeamSkillsPage />
    </MemoryRouter>,
  );

describe("T53-S4 Team skills screen", () => {
  it("lists each skill with use-when, source link, pinned commit and used-by; flags persona skills the library lacks", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(VIEW);
    page();
    const row = await screen.findByTestId("skill-diagram-design");
    expect(row.textContent).toContain("a branded editorial diagram");
    expect(row.textContent).toContain("Writer");
    expect(screen.getByTestId("commit-diagram-design").textContent).toBe("0cf73c3");
    expect(within(row).getByRole("link").getAttribute("href")).toBe(VIEW.skills[1].url);
    expect(screen.getByTestId("skill-diagram").textContent).toContain("no persona yet");
    expect(screen.getByTestId("unknown-skills").textContent).toContain("Steward: gh");
    expect(screen.getByText(/within 10 min/)).toBeTruthy();
  });

  it("Add skill: paste a URL, see name, description and commit, then confirm with that commit", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(VIEW);
    const preview = vi.spyOn(api, "previewTeamSkill").mockResolvedValue({
      skill: { name: "pdf", use_when: "PDF work", source: { type: "github", repo: "anthropics/skills", commit: "ca45fc496a3436251f191354091d557da31c15b5", path: "skills/pdf" } },
      description: "Read and write PDF files.",
      action: "added",
      skillMdName: "pdf",
    });
    const add = vi.spyOn(api, "addTeamSkill").mockResolvedValue({
      action: "added",
      skill: { name: "pdf", use_when: "PDF work", source: { type: "github", repo: "anthropics/skills" } },
      sha: "abc1234",
      sync: [{ host: "main", ok: true, note: "synced" }, { host: "worker", ok: false, note: "not synced now (off); its timer syncs it within 10 min" }],
    });
    page();
    fireEvent.click(await screen.findByTestId("add-skill"));
    fireEvent.change(screen.getByLabelText("GitHub URL"), { target: { value: "https://github.com/anthropics/skills/tree/main/skills/pdf" } });
    fireEvent.click(screen.getByTestId("skill-preview-btn"));
    const box = await screen.findByTestId("skill-preview");
    expect(preview).toHaveBeenCalledWith({ url: "https://github.com/anthropics/skills/tree/main/skills/pdf" });
    expect(box.textContent).toContain("Read and write PDF files.");
    expect(screen.getByTestId("preview-commit").textContent).toBe("ca45fc4");
    fireEvent.click(screen.getByTestId("skill-confirm"));
    await waitFor(() => expect(add).toHaveBeenCalledWith({ url: "https://github.com/anthropics/skills/tree/main/skills/pdf", commit: "ca45fc496a3436251f191354091d557da31c15b5" }));
    const done = await screen.findByTestId("skill-done");
    expect(done.textContent).toContain("pdf added (commit abc1234)");
    expect(done.textContent).toContain("its timer syncs it within 10 min");
  });

  it("Remove warns which personas still use it and removes from them on confirm", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(VIEW);
    const remove = vi.spyOn(api, "removeTeamSkill").mockResolvedValue({ removed: "diagram-design", detachedFrom: [{ id: "p1", name: "Writer" }], sync: [], syncNote: "" });
    page();
    fireEvent.click(await screen.findByLabelText("Remove diagram-design"));
    expect((await screen.findByTestId("remove-warning")).textContent).toContain("Writer");
    fireEvent.click(screen.getByTestId("skill-remove-confirm"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("diagram-design", true));
    expect((await screen.findByTestId("skill-done")).textContent).toContain("taken off Writer");
  });

  it("not Sam: no Add or Remove", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue({ ...VIEW, canEdit: false });
    page();
    await screen.findByTestId("skill-diagram");
    expect(screen.queryByTestId("add-skill")).toBeNull();
    expect(screen.queryByLabelText("Remove diagram")).toBeNull();
    expect(screen.getByText(/Only Sam adds or removes skills/)).toBeTruthy();
  });
});

describe("T53-S4 persona editor: skills from the library only", () => {
  const persona: Persona = { id: "p2", name: "Steward", remit: "r", skills: ["diagram", "gh"], model: "claude-sonnet-5-5", mayWrite: false, host: "main", createdAt: "2026-11-01" } as Persona;

  it("is a pick-list of the library (no free text); a held skill the library lacks is flagged, kept until taken off", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(VIEW);
    const update = vi.spyOn(api, "updatePersona").mockResolvedValue({} as never);
    render(<PersonaDialog open onOpenChange={() => {}} persona={persona} />);
    const picker = await screen.findByTestId("skill-picker");
    await within(picker).findByLabelText("diagram-design");
    expect(within(picker).queryByRole("textbox")).toBeNull();
    expect((within(picker).getByLabelText("diagram") as HTMLInputElement).checked).toBe(true);
    expect((within(picker).getByLabelText("diagram-design") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("unknown-skill-gh").textContent).toContain("not in the library");
    fireEvent.click(within(picker).getByLabelText("diagram-design"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1].skills).toEqual(["diagram", "gh", "diagram-design"]);
    fireEvent.click(screen.getByLabelText("Remove gh"));
    expect(screen.queryByTestId("unknown-skill-gh")).toBeNull();
  });

  it("a new persona from a template starts with the template's skills", async () => {
    vi.spyOn(api, "listTeamSkills").mockResolvedValue(VIEW);
    vi.spyOn(api, "listPersonaTemplates").mockResolvedValue([{ name: "writer", template: "writer", model: "claude-opus-5-5", host: "host1", skills: ["diagram-design"], remit: "w", reads: "r", writes: "w", prompt: "w" }]);
    render(<PersonaDialog open onOpenChange={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Start from"), { target: { value: "writer" } });
    const picker = screen.getByTestId("skill-picker");
    await waitFor(() => expect((within(picker).getByLabelText("diagram-design") as HTMLInputElement).checked).toBe(true));
  });
});
