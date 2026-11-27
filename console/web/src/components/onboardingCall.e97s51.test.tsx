// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { OnboardingCall, onboardingBase } from "./onboardingCall";
import { useOnboardingLeads } from "@/lib/onboardingLeads";

function Leads() {
  return <i data-testid="leads">{String(useOnboardingLeads())}</i>;
}

// (call_910685a3: "we should kind of guide the user towards a button at the beginning"): a new workspace's Home
// leads to one Call, its onboarding helper, while it has no objective of its own; after that the panel is gone.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stubState = (s: Record<string, unknown>) => {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (seen.push(String(url)), new Response(JSON.stringify(s), { status: 200, headers: { "content-type": "application/json" } }))));
  return seen;
};

describe(" the onboarding call on a new workspace's Home", () => {
  it("due: one Call button, named for the onboarding helper, on the workspace's own call routes", async () => {
    const seen = stubState({ available: true, enabled: true, due: true, limits: { monthCapUsd: 5, callMaxMin: 60 } });
    render(
      <>
        <Leads />
        <OnboardingCall world="et-ana-1" />
      </>,
    );
    const b = await screen.findByTestId("call-start-compact");
    // it leads: the pay note and Connect GitHub wait under it while it shows
    await waitFor(() => expect(screen.getByTestId("leads").textContent).toBe("true"));
    expect(b.getAttribute("aria-label")).toBe("Call your onboarding helper");
    expect(screen.getByTestId("onboarding-call").textContent).toContain("Start with a call");
    expect(screen.getByTestId("onboarding-call-answer").textContent).toContain("as long as you like");
    expect(seen[0]).toBe(`${onboardingBase("et-ana-1")}/state`);
    expect(onboardingBase("et-ana-1")).toBe("/api/tenants/et-ana-1/onboarding/voice");
  });

  it("not due (its first objective is written) or no call here: nothing at all", async () => {
    stubState({ available: true, enabled: true, due: false });
    const { container } = render(
      <div data-testid="box">
        <OnboardingCall world="et-ana-1" />
      </div>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("box").innerHTML).toBe("");
    expect(container.textContent).toBe("");
    cleanup();
    stubState({ available: false, enabled: false, due: true });
    const r2 = render(<OnboardingCall world="et-ana-1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(r2.container.innerHTML).toBe("");
  });
});
