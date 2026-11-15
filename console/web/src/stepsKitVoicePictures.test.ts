// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// every note box records voice in place (no window) and takes pictures, attached or pasted.

const KIT = fs.readFileSync(path.join(__dirname, "../public/steps-kit.js"), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete (window as { isSecureContext?: boolean }).isSecureContext;
});

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const VIEW = { page: { id: "sp_12345678", title: "TEST", url: "http://x/" }, steps: {}, notes: {}, ticks: {}, changes: {} };
const ANSWER = { spine: "saved", state: "todo", done: false, step: "a", steps: {}, notes: { a: [{ at: "2026-11-12", words: "hello" }] }, ticks: {}, changes: {}, change: { id: 1, status: "filed", wake: "started", at: "x" } };

function boot(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  document.body.innerHTML = '<section data-step="a" data-title="Step A"><h2>Step A</h2></section>';
  const script = document.createElement("script");
  script.setAttribute("data-steps-token", "tok");
  script.setAttribute("data-steps-api", "http://console");
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  new Function(KIT)();
}

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

describe("steps kit note box", () => {
  it("a pasted screenshot uploads at once and goes with the note; no window ever opens", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/files")) return json({ file: { id: "att_0123456789ab", name: "s.png" } }, 201);
      if (init?.method === "POST") return json(ANSWER);
      return json(VIEW);
    });
    boot(fetchMock);
    await flush();
    const box = document.querySelector("textarea")!;
    const send = document.querySelector<HTMLButtonElement>(".sk-send")!;
    expect(send.disabled).toBe(true);
    const pic = new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" });
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { files: [pic], items: [] };
    box.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    const up = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/files"))!;
    expect(up[0]).toBe("http://console/api/public/steps/tok/files");
    expect((up[1] as RequestInit).headers).toMatchObject({ "content-type": "image/png" });
    expect(document.querySelector(".sk-file-item")!.textContent).toContain("Ready");
    expect(send.disabled).toBe(false);
    box.value = "see this";
    send.click();
    await flush();
    const tick = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/ticks"))!;
    expect(JSON.parse(String((tick[1] as RequestInit).body))).toMatchObject({ step: "a", comment: "see this", files: ["att_0123456789ab"] });
    expect(document.querySelector(".sk-files")!.hasAttribute("hidden")).toBe(true);
    // the voice button on a plain-http page never opens a window: it goes to the page's secure copy
    expect(window.isSecureContext).not.toBe(true);
    expect(document.querySelector(".sk-voice")!.getAttribute("title")).toMatch(/secure copy/);
    expect(open).not.toHaveBeenCalled();
  });

  it("on a secure page Voice records in place: press, speak, press again, the words are filed as the note", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const stop = vi.fn();
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } }));
    class FakeRecorder {
      static isTypeSupported = () => true;
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable?: (e: { data: Blob }) => void;
      onstop?: () => void;
      private ls: (() => void)[] = [];
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
        this.onstop?.();
        this.ls.forEach((f) => f());
      }
      addEventListener(_n: string, f: () => void) {
        this.ls.push(f);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    (window as { KEEP?: unknown }).KEEP = undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("steps-keep.js")) return json({});
      if (u.endsWith("/voice/notes")) return json({ note: { id: "vn_0000abcd" }, segmentS: 120, maxMin: 30 }, 201);
      if (/\/segments\/\d+$/.test(u)) return json({ ok: true });
      if (u.endsWith("/finish")) return json({ note: { transcript: "the button is grey" } });
      if (init?.method === "POST") return json(ANSWER);
      return json(VIEW);
    });
    boot(fetchMock);
    await flush();
    // the keep script is loaded with a <script> tag: answer it as missing (the note still goes from memory)
    document.querySelectorAll("script[src$='steps-keep.js']").forEach((s) => s.dispatchEvent(new Event("error")));
    const voice = document.querySelector<HTMLButtonElement>(".sk-voice")!;
    voice.click();
    await flush();
    document.querySelectorAll("script[src$='steps-keep.js']").forEach((s) => s.dispatchEvent(new Event("error")));
    await flush();
    expect(voice.classList.contains("on")).toBe(true);
    expect(document.querySelector(".sk-rec")!.hasAttribute("hidden")).toBe(false);
    voice.click();
    await flush();
    await flush();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://console/api/public/steps/tok/voice/notes");
    expect(urls).toContain("http://console/api/public/steps/tok/voice/notes/vn_0000abcd/segments/0");
    expect(urls).toContain("http://console/api/public/steps/tok/voice/notes/vn_0000abcd/finish");
    const tick = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/ticks"))!;
    expect(JSON.parse(String((tick[1] as RequestInit).body))).toMatchObject({ step: "a", comment: "the button is grey" });
    expect(stop).toHaveBeenCalled();
    expect(voice.classList.contains("on")).toBe(false);
  });
});
