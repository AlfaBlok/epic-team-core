// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type SaveKeyResult, type WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

/** a key ask has a private paste box; the value is cleared right after Save key. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_key",
  source: "ask",
  state: "open",
  who: "Sam",
  code: "T0-A13",
  milestoneId: "ms_1",
  milestoneTitle: "whatgpt",
  nodeKey: "ms_1/T6",
  path: "docs/PLAN-0-ROOT.md",
  title: "Checkout",
  ask: "provide",
  question: "Create a restricted Stripe key with write on Checkout",
  secret: { app: "whatgpt-service", name: "STRIPE_SECRET_KEY" },
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  decidable: false,
  ...over,
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
const VALUE = "sk_live_web_test_value";
const ok: SaveKeyResult = {
  id: "jr_1",
  itemId: "wj_key",
  kind: "answer",
  text: "key provided in the console (stored with secret put, value never shown)",
  delivery: "sent",
  createdAt: new Date().toISOString(),
  stored: { app: "whatgpt-service", name: "STRIPE_SECRET_KEY" },
  wake: { notified: "woken", runId: "run_1", persona: "Delivery Manager" },
};

describe("WaitingCard: key ask paste box", () => {
  it("only key asks get a password field (no echo, no autofill); other asks do not", () => {
    wrap(<WaitingCard item={item()} />);
    const input = screen.getByLabelText("Key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(screen.getByTestId("secret-box").textContent).toMatch(/whatgpt-service.*STRIPE_SECRET_KEY/);
    expect(screen.getByTestId("card-feedback").textContent).toMatch(/Never paste the key here/);
    cleanup();
    wrap(<WaitingCard item={item({ secret: undefined })} />);
    expect(screen.queryByTestId("secret-box")).toBeNull();
    expect(screen.queryByLabelText("Key")).toBeNull();
    cleanup();
    wrap(<WaitingCard item={item({ state: "answered", answer: ok.text })} />);
    expect(screen.queryByTestId("secret-box")).toBeNull();
  });

  it("Save key sends the value once, clears the field and shows the ack", async () => {
    const spy = vi.spyOn(api, "saveKey").mockResolvedValue(ok);
    wrap(<WaitingCard item={item()} />);
    const input = screen.getByLabelText("Key") as HTMLInputElement;
    const save = screen.getByRole("button", { name: /Save key/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: VALUE } });
    fireEvent.click(save);
    expect(input.value).toBe("");
    await waitFor(() => expect(screen.getByTestId("sent-row-detail").textContent).toMatch(/Saved: whatgpt-service STRIPE_SECRET_KEY is stored.*Woken Delivery Manager \(run run_1\)/));
    // (the owner, vn_e00f1134: "I pasted a key ... then the card disappeared"): the card is one green Sent row in its place
    expect(screen.getByTestId("sent-row-said").textContent).toBe("Key saved");
    expect(screen.getByTestId("sent-row-comment")).toBeTruthy();
    expect(screen.queryByTestId("secret-box")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("wj_key", { value: VALUE, milestoneId: "ms_1", wake: true });
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("T8-S21: an app with no Deployer app: the ack says stored in the secret store, not set in Deployer", async () => {
    vi.spyOn(api, "saveKey").mockResolvedValue({ ...ok, stored: { app: "social", name: "COMPOSIO_API_KEY", deployed: false } });
    wrap(<WaitingCard item={item({ secret: { app: "social", name: "COMPOSIO_API_KEY" } })} />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: VALUE } });
    fireEvent.submit(screen.getByTestId("secret-box"));
    await waitFor(() =>
      expect(screen.getByTestId("sent-row-detail").textContent).toMatch(/Saved: social COMPOSIO_API_KEY is stored in the secret store \(no Deployer app for social, so not set in an env\)/),
    );
    expect(screen.getByTestId("sent-row-detail").textContent).not.toContain("set in Deployer");
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("failure: the field is cleared too and the tool's error is shown", async () => {
    vi.spyOn(api, "saveKey").mockRejectedValue(new Error("key not stored: class money … --approved T0-A13 is not one; the ask is open again"));
    wrap(<WaitingCard item={item()} />);
    const input = screen.getByLabelText("Key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: VALUE } });
    fireEvent.submit(screen.getByTestId("secret-box"));
    expect(input.value).toBe("");
    await waitFor(() => expect(screen.getByTestId("secret-note").textContent).toMatch(/Not saved: key not stored: .*open again/));
    expect(document.body.textContent).not.toContain(VALUE);
  });
});

describe("a failed paste says why in plain words and keeps saying it", () => {
  it("a restart the card could not wait out: plain words, and the note survives the card being drawn again", async () => {
    vi.spyOn(api, "saveKey").mockRejectedValue(new TypeError("Failed to fetch"));
    const first = wrap(<WaitingCard item={item()} />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: VALUE } });
    fireEvent.submit(screen.getByTestId("secret-box"));
    await waitFor(() => expect(screen.getByTestId("secret-note").textContent).toMatch(/console was restarting.*Nothing was stored.*Paste the key again/));
    first.unmount();
    wrap(<WaitingCard item={item()} />);
    expect(screen.getByTestId("secret-note").textContent).toMatch(/console was restarting/);
    expect(document.body.textContent).not.toContain(VALUE);
  });
});
