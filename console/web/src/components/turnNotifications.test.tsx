// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/api";
import { keyBytes, usePushToggle } from "@/components/PushToggle";

// "Turn on notifications" in the installed app: one tap asks the phone, subscribes this device and stores it on
// the console; then a bell sends a test to this device. Nothing shows where push cannot work.

function Host() {
  const p = usePushToggle();
  return (
    <div>
      {p.bell}
      {p.banner}
    </div>
  );
}

const g = globalThis as unknown as Record<string, unknown>;
const saved = { sw: Object.getOwnPropertyDescriptor(navigator, "serviceWorker"), pm: g.PushManager, n: g.Notification };

function fakePush(o: { permission?: NotificationPermission; answer?: NotificationPermission } = {}) {
  let sub: { endpoint: string; toJSON: () => unknown } | null = null;
  const subscribe = vi.fn(async () => {
    sub = { endpoint: "https://web.push.apple.com/QTest", toJSON: () => ({ endpoint: "https://web.push.apple.com/QTest", keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } }) };
    return sub;
  });
  const reg = { pushManager: { getSubscription: async () => sub, subscribe } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: vi.fn(async () => reg), getRegistration: async () => reg, ready: Promise.resolve(reg) } });
  g.PushManager = function () {};
  const N = { permission: o.permission ?? "default", requestPermission: vi.fn(async () => o.answer ?? "granted") };
  g.Notification = N;
  return { subscribe, N };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (saved.sw) Object.defineProperty(navigator, "serviceWorker", saved.sw);
  else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  g.PushManager = saved.pm;
  g.Notification = saved.n;
});

describe("T18-S13 Turn on notifications", () => {
  it("decodes the console's key for the browser", () => {
    expect([...keyBytes("BAEC")]).toEqual([4, 1, 2]);
  });

  it("shows nothing where push cannot work (no service worker)", async () => {
    const get = vi.spyOn(api, "getPush");
    render(<Host />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("push-banner")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("shows nothing for another world's login", async () => {
    fakePush();
    vi.spyOn(api, "getPush").mockResolvedValue({ configured: true, publicKey: "BAEC", devices: 0, endpoints: [], notifies: false });
    render(<Host />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("push-banner")).toBeNull();
  });

  it("one tap: asks, subscribes, stores the device, then the bell sends a test to it", async () => {
    const f = fakePush();
    vi.spyOn(api, "getPush").mockResolvedValue({ configured: true, publicKey: "BAEC", devices: 0, endpoints: [], notifies: true });
    const store = vi.spyOn(api, "subscribePush").mockResolvedValue({ ok: true });
    const test = vi.spyOn(api, "testPush").mockResolvedValue({ ok: true, sent: 1 });
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
    await waitFor(() => expect(store).toHaveBeenCalled());
    expect(f.N.requestPermission).toHaveBeenCalled();
    expect(f.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(store.mock.calls[0][0]).toMatchObject({ endpoint: "https://web.push.apple.com/QTest" });
    expect((await screen.findByTestId("push-note")).textContent).toBe("Notifications are on.");
    fireEvent.click(screen.getByTestId("push-bell"));
    await waitFor(() => expect(test).toHaveBeenCalledWith("https://web.push.apple.com/QTest"));
    expect(await screen.findByText("Test sent to this device.")).toBeTruthy();
  });

  it("says how to allow them again when the phone blocked them", async () => {
    fakePush({ permission: "denied" });
    vi.spyOn(api, "getPush").mockResolvedValue({ configured: true, publicKey: "BAEC", devices: 0, endpoints: [], notifies: true });
    render(<Host />);
    expect(await screen.findByText(/Notifications are blocked for this app/)).toBeTruthy();
  });
});
