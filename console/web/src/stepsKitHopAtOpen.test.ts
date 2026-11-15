// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// pressing the mic in a page's feedback box reloaded the whole page. A plain-http page now
// opens its secure copy the moment it opens, so the press records in place there and nothing reloads.

const KIT = fs.readFileSync(path.join(__dirname, "../public/steps-kit.js"), "utf8");
type W = Window & { SK_NAVIGATE?: (u: string) => void; isSecureContext?: boolean };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.style.visibility = "";
  delete (window as W).SK_NAVIGATE;
  delete (window as { isSecureContext?: boolean }).isSecureContext;
});

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const VIEW = { page: { id: "sp_12345678", title: "TEST", url: "http://x/" }, steps: {}, notes: {}, ticks: {}, changes: {} };
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

function boot(attrs: Record<string, string> = {}) {
  const nav = vi.fn();
  (window as W).SK_NAVIGATE = nav;
  vi.stubGlobal("fetch", vi.fn(async () => json(VIEW)));
  document.body.innerHTML = '<section data-step="feedback" data-row="E907-S3"><h2>Your feedback on this page</h2></section>';
  const script = document.createElement("script");
  script.setAttribute("data-steps-token", "tok");
  script.setAttribute("data-steps-api", "http://console");
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  new Function(KIT)();
  return nav;
}

describe("steps kit on a plain-http page", () => {
  it("opens the page's secure copy at once, hidden for that instant, so Voice never reloads the page later", async () => {
    const nav = boot();
    expect(document.documentElement.style.visibility).toBe("hidden");
    await flush();
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav.mock.calls[0][0]).toBe(`https://team.example.com/steps/view/sp_12345678${location.pathname}`);
  });

  it("stays on the page in a script-driven browser (the quality check's screenshots), and shows it", async () => {
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { webdriver: true }));
    const nav = boot();
    await flush();
    expect(nav).not.toHaveBeenCalled();
    expect(document.documentElement.style.visibility).toBe("");
  });

  it("stays when the page says data-voice-upgrade=off; Voice there still opens the copy at its step", async () => {
    const nav = boot({ "data-voice-upgrade": "off" });
    await flush();
    expect(nav).not.toHaveBeenCalled();
    expect(document.querySelector(".sk-voice")!.getAttribute("title")).toMatch(/secure copy/);
  });

  it("never hops from a page that can already record (the copy itself, or any https page)", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { mediaDevices: { getUserMedia: vi.fn() } }));
    vi.stubGlobal("MediaRecorder", class {});
    const nav = boot();
    await flush();
    expect(nav).not.toHaveBeenCalled();
    expect(document.documentElement.style.visibility).toBe("");
  });

  it("a page that cannot reach the console is shown as it is, never left hidden", async () => {
    const nav = vi.fn();
    (window as W).SK_NAVIGATE = nav;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    document.body.innerHTML = '<section data-step="feedback"><h2>Feedback</h2></section>';
    const script = document.createElement("script");
    script.setAttribute("data-steps-token", "tok");
    script.setAttribute("data-steps-api", "http://console");
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
    new Function(KIT)();
    await flush();
    expect(nav).not.toHaveBeenCalled();
    expect(document.documentElement.style.visibility).toBe("");
  });
});
