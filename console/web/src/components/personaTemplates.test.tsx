// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type Persona, type PersonaTemplate } from "@/api";
import { PersonaDialog } from "@/components/dialogs";

/** the New persona dialog lists the generic templates and fills the form from one. */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tpl = (name: string, model = "claude-sonnet-5-5"): PersonaTemplate => ({
  name, template: name, model, host: "main", remit: `${name} remit`, reads: "r", writes: "w", prompt: `${name} remit\n\nReads: r\n\nWrites: w`,
});
const TEMPLATES = [tpl("author", "claude-opus-5-5"), tpl("engager"), tpl("listener"), tpl("responder")];

describe("T34-S13 persona template picker", () => {
  it("lists listener, author, responder and engager; picking one fills name, remit and model; creates with them", async () => {
    vi.spyOn(api, "listPersonaTemplates").mockResolvedValue(TEMPLATES);
    const create = vi.spyOn(api, "createPersona").mockResolvedValue({} as never);
    render(<PersonaDialog open onOpenChange={() => {}} />);
    const sel = (await screen.findByLabelText("Start from")) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Blank", "author", "engager", "listener", "responder"]);
    fireEvent.change(sel, { target: { value: "author" } });
    expect((screen.getByPlaceholderText("infra-steward") as HTMLInputElement).value).toBe("author");
    expect((screen.getByRole("textbox", { name: /remit/i }) as HTMLTextAreaElement).value).toBe("author remit\n\nReads: r\n\nWrites: w");
    // switching template replaces a name that came from the previous one
    fireEvent.change(sel, { target: { value: "listener" } });
    expect((screen.getByPlaceholderText("infra-steward") as HTMLInputElement).value).toBe("listener");
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ name: "listener", remit: "listener remit\n\nReads: r\n\nWrites: w", model: "claude-sonnet-5-5", host: "main" });
  });

  it("a name Sam typed is kept when he picks a template", async () => {
    vi.spyOn(api, "listPersonaTemplates").mockResolvedValue(TEMPLATES);
    render(<PersonaDialog open onOpenChange={() => {}} />);
    const sel = await screen.findByLabelText("Start from");
    fireEvent.change(screen.getByPlaceholderText("infra-steward"), { target: { value: "zen-listener" } });
    fireEvent.change(sel, { target: { value: "listener" } });
    expect((screen.getByPlaceholderText("infra-steward") as HTMLInputElement).value).toBe("zen-listener");
  });

  it("editing a persona shows no picker; no templates: no picker", async () => {
    const list = vi.spyOn(api, "listPersonaTemplates").mockResolvedValue(TEMPLATES);
    const p = { id: "p1", name: "x", remit: "r", skills: [], model: "claude-sonnet-5-5", mayWrite: false, host: "main" } as unknown as Persona;
    render(<PersonaDialog open onOpenChange={() => {}} persona={p} />);
    await screen.findByText("Edit x");
    expect(screen.queryByLabelText("Start from")).toBeNull();
    expect(list).not.toHaveBeenCalled();
    cleanup();
    list.mockResolvedValue([]);
    render(<PersonaDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByLabelText("Start from")).toBeNull();
  });
});
