// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/api";
import { PersonaDialog } from "@/components/dialogs";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("persona Host select (M2-27)", () => {
  it("defaults to MAIN and sends host worker when chosen", async () => {
    const create = vi.spyOn(api, "createPersona").mockResolvedValue({} as never);
    render(<PersonaDialog open onOpenChange={() => {}} />);
    const sel = screen.getByLabelText("Host") as HTMLSelectElement;
    expect(sel.value).toBe("main");
    fireEvent.change(sel, { target: { value: "worker" } });
    fireEvent.change(screen.getByPlaceholderText("infra-steward"), { target: { value: "dev" } });
    fireEvent.change(screen.getByRole("textbox", { name: /remit/i }), { target: { value: "do work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create persona" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ host: "worker" });
  });
});
