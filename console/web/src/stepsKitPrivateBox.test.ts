// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// a step that needs a key has its private box on the steps page itself, beside Done.

const KIT = fs.readFileSync(path.join(__dirname, "../public/steps-kit.js"), "utf8");
const VALUE = "sk_test_E84S13_kit_never_shown";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("T84-S13 steps kit: the private box", () => {
  it("shows a write-only box on the registered step only; one press stores and switches Done; the box empties", async () => {
    const box = { app: "agent-team-console", name: "ANTHROPIC_API_KEY", ask: "T94-A1", replace: false, set: false };
    const base = { page: { id: "sp_1", title: "TEST", url: "http://x/" }, notes: {}, ticks: {}, changes: {} };
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push({ url, body: JSON.parse(String(init.body)) });
          return { ok: true, status: 201, json: async () => ({ ...base, spine: "saved", state: "done", step: "key", steps: { key: { state: "done", at: "2026-11-10" } }, stored: { app: box.app, name: box.name, deployer: true } }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ ...base, steps: {}, secrets: { key: [box] } }) } as Response;
      }),
    );
    document.body.innerHTML = '<section data-step="read" data-ask="T94-A1"><h2>Read</h2></section><section data-step="key" data-ask="T94-A1"><h2>Paste the key</h2></section>';
    const script = document.createElement("script");
    script.setAttribute("data-steps-token", "tok");
    script.setAttribute("data-steps-api", "http://console");
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
    new Function(KIT)();
    await flush();
    expect(document.querySelectorAll(".sk-key")).toHaveLength(1);
    const step = document.querySelector('[data-step="key"]')!;
    const input = step.querySelector<HTMLInputElement>(".sk-key input")!;
    const save = step.querySelector<HTMLButtonElement>(".sk-key-save")!;
    expect(input.type).toBe("password");
    expect(step.querySelector(".sk-key code")!.textContent).toBe("ANTHROPIC_API_KEY");
    // the box sits above the step's Done buttons
    expect(step.querySelector(".sk-done")!.firstElementChild!.classList.contains("sk-key")).toBe(true);
    expect(save.disabled).toBe(true);
    expect(save.textContent).toBe("Save key · Done");
    input.value = VALUE;
    input.dispatchEvent(new Event("input"));
    save.click();
    expect(input.value).toBe(""); // emptied at the press
    await flush();
    expect(posts).toEqual([{ url: "http://console/api/public/steps/tok/secret", body: { step: "key", name: "ANTHROPIC_API_KEY", value: VALUE, title: "Paste the key" } }]);
    expect(step.querySelector('.sk-seg button[data-s="done"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(step.querySelector(".sk-state")!.textContent).toMatch(/^Key saved/);
    expect(input.hidden).toBe(true);
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  it("two boxes on a step: the first says Save key, the last one Save key · Done", async () => {
    const id = { app: "agent-team-console", name: "GOOGLE_OAUTH_CLIENT_ID", ask: "T88-A1", replace: false, set: false };
    const sec = { ...id, name: "GOOGLE_OAUTH_CLIENT_SECRET" };
    const base = { page: { id: "sp_1", title: "TEST", url: "http://x/" }, notes: {}, ticks: {}, changes: {} };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? ({ ok: true, status: 201, json: async () => ({ ...base, spine: "same", state: "todo", step: "g", steps: {}, missing: [sec.name], stored: { app: id.app, name: id.name, deployer: false } }) } as Response)
          : ({ ok: true, status: 200, json: async () => ({ ...base, steps: {}, secrets: { g: [id, sec] } }) } as Response),
      ),
    );
    document.body.innerHTML = '<section data-step="g" data-ask="T88-A1"><h2>Google</h2></section>';
    const script = document.createElement("script");
    script.setAttribute("data-steps-token", "tok");
    script.setAttribute("data-steps-api", "http://console");
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
    new Function(KIT)();
    await flush();
    const saves = [...document.querySelectorAll<HTMLButtonElement>(".sk-key-save")];
    expect(saves.map((b) => b.textContent)).toEqual(["Save key", "Save key"]);
    const input = document.querySelector<HTMLInputElement>(".sk-key input")!;
    input.value = "id-value";
    input.dispatchEvent(new Event("input"));
    saves[0].click();
    await flush();
    expect(document.querySelector(".sk-state")!.textContent).toBe("Key saved · now the other box");
    expect(saves[0].hidden).toBe(true);
    expect(saves[1].textContent).toBe("Save key · Done");
  });
});
