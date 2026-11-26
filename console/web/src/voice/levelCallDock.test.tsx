// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { VoiceApi } from "./engine";

// a level's own Call (the desk's senior partner, an objective's briefer) sits beside the page's title at every
// width, one tap; where it cannot call it is not drawn at all (never a greyed button he cannot press).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const api = { start: vi.fn(), beat: vi.fn(), usage: vi.fn(), end: vi.fn(), status: vi.fn(), ask: vi.fn(), askState: vi.fn() } as unknown as VoiceApi;

function Dock({ st, wide, hide }: { st: VoiceState; wide?: boolean; hide?: boolean }) {
  const d = useCallDock({ api, state: async () => st, wide, hideUnavailable: hide, callee: "the SocialApp partner", label: "Partner" });
  return (
    <>
      <header data-testid="head">{d.button}</header>
      {d.bar}
    </>
  );
}

describe("a Call at each level", () => {
  it("wide: the Call shows at every width, named for whom it calls", async () => {
    render(<Dock st={{ available: true, enabled: true }} wide hide />);
    const b = await screen.findByTestId("call-start-compact");
    expect(b.className).toMatch(/\binline-flex\b/);
    expect(b.className).not.toMatch(/\bhidden\b/);
    expect(b.getAttribute("aria-label")).toBe("Call the SocialApp partner");
    expect(b.textContent).toContain("Partner");
    expect((b as HTMLButtonElement).disabled).toBe(false);
  });

  it("where it cannot call: no button and no bar, never a greyed Call", async () => {
    render(<Dock st={{ available: false, enabled: false, reason: "only on the owner's console" }} wide hide />);
    await waitFor(() => expect(screen.getByTestId("head").innerHTML).toBe(""));
    expect(screen.queryByTestId("call-panel")).toBeNull();
    expect(screen.queryByTestId("call-start-compact")).toBeNull();
  });
});
