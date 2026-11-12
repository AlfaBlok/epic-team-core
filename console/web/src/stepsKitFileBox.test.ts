// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// a key that is a file ('s Google service-account JSON key) gets a file box on the steps page.

const KIT = fs.readFileSync(path.join(__dirname, "../public/steps-kit.js"), "utf8");
const FILE = '{\n  "type": "service_account",\n  "private_key": "E84S23_kit_never_shown"\n}\n';
const base = { page: { id: "sp_1", title: "TEST", url: "http://x/" }, notes: {}, ticks: {}, changes: {} };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function boot(html: string, secrets: unknown, post?: (body: Record<string, unknown>) => Response) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push({ url, body });
        return post!(body);
      }
      return { ok: true, status: 200, json: async () => ({ ...base, steps: {}, secrets }) } as Response;
    }),
  );
  document.body.innerHTML = html;
  const script = document.createElement("script");
  script.setAttribute("data-steps-token", "tok");
  script.setAttribute("data-steps-api", "http://console");
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  new Function(KIT)();
  return posts;
}

const pick = (input: HTMLInputElement, f: File) => {
  Object.defineProperty(input, "files", { value: [f], configurable: true });
  input.dispatchEvent(new Event("change"));
};

describe("T84-S23 steps kit: the file box", () => {
  it("a registered file box: pick the file, one press sends the whole file and switches Done; nothing of it is shown", async () => {
    const box = { app: "agent-team-console", name: "GOOGLE_TEAM_MAIL_SA_JSON", ask: "T92-A2", replace: false, set: false, file: true, maxBytes: 65536 };
    const posts = boot(
      '<section data-step="sa" data-ask="T92-A2" data-secret-file="agent-team-console GOOGLE_TEAM_MAIL_SA_JSON"><h2>Google key</h2></section>',
      { sa: [box] },
      () => ({ ok: true, status: 201, json: async () => ({ ...base, spine: "saved", state: "done", step: "sa", steps: { sa: { state: "done", at: "2026-11-10" } }, stored: { app: box.app, name: box.name, deployer: false } }) }) as Response,
    );
    await flush();
    const step = document.querySelector('[data-step="sa"]')!;
    expect(step.querySelectorAll(".sk-file")).toHaveLength(1);
    const input = step.querySelector<HTMLInputElement>(".sk-file input")!;
    const save = step.querySelector<HTMLButtonElement>(".sk-key-save")!;
    expect(input.type).toBe("file");
    expect(step.querySelector(".sk-file code")!.textContent).toBe("GOOGLE_TEAM_MAIL_SA_JSON");
    expect(step.querySelector(".sk-done")!.firstElementChild!.classList.contains("sk-file")).toBe(true);
    expect(save.disabled).toBe(true);
    expect(save.textContent).toBe("Save file · Done");
    pick(input, new File([FILE], "epicteam-mail-0123abcd.json", { type: "application/json" }));
    expect(save.disabled).toBe(false);
    expect(step.textContent).not.toContain("epicteam-mail-0123abcd.json"); // the file's name is never shown
    save.click();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await flush();
    expect(posts).toEqual([{ url: "http://console/api/public/steps/tok/secret", body: { step: "sa", name: box.name, value: FILE, title: "Google key" } }]);
    expect(step.querySelector('.sk-seg button[data-s="done"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(step.querySelector(".sk-state")!.textContent).toMatch(/^File saved/);
    expect(step.querySelector<HTMLElement>(".sk-file-pick")!.hidden).toBe(true);
    expect(save.hidden).toBe(true);
    expect(document.body.innerHTML).not.toContain("E84S23_kit_never_shown");
  });

  it("a file over the cap is refused in the page, nothing sent", async () => {
    const box = { app: "a", name: "K_JSON", ask: "T92-A2", replace: false, set: false, file: true, maxBytes: 10 };
    const posts = boot('<section data-step="sa" data-ask="T92-A2"><h2>Key</h2></section>', { sa: [box] }, () => {
      throw new Error("never");
    });
    await flush();
    pick(document.querySelector<HTMLInputElement>(".sk-file input")!, new File([FILE], "k.json"));
    document.querySelector<HTMLButtonElement>(".sk-key-save")!.click();
    await flush();
    expect(posts).toEqual([]);
    expect(document.querySelector(".sk-state")!.textContent).toMatch(/too big/);
  });

  it("a data-secret-file the page did not register says so, and shows no box", async () => {
    boot('<section data-step="sa" data-ask="T92-A2" data-secret-file="agent-team-console GOOGLE_TEAM_MAIL_SA_JSON"><h2>Key</h2></section>', {});
    await flush();
    expect(document.querySelectorAll(".sk-file")).toHaveLength(0);
    expect(document.querySelector(".sk-file-missing")!.textContent).toMatch(/not switched on/);
  });
});
