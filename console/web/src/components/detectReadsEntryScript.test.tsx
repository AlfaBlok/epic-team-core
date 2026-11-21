// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildWatch, CHECK_EVERY_MS, entryOf, FOCUS_GAP_MS, IDLE_MS, hasUnsent, loadedEntry, NewBuild, RELOADED_KEY } from "@/components/NewBuild";
import { NoteTab } from "@/voice/NoteProvider";
import { CallTab } from "@/voice/CallProvider";
import fs from "node:fs";
import path from "node:path";

/**
 * an open page notices a newer
 * build and reloads when nothing would be lost, else shows one Reload bar; never in dev, never a loop.
 */
const page = (entry: string) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body><div id="root"></div></body></html>`;
const OLD = "/assets/index-OLD111.js";
const NEW = "/assets/index-NEW222.js";

let visibility: DocumentVisibilityState = "visible";
let served: () => Response | Promise<Response>;
const fetchFn = vi.fn(async (..._a: unknown[]) => served());
const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

function mount(entry = OLD) {
  const s = document.createElement("script");
  s.type = "module";
  s.setAttribute("src", entry);
  s.dataset.e18s17 = "1";
  document.head.appendChild(s);
}

function watch(o: { busy?: () => boolean; storage?: ReturnType<typeof memStore>; now?: () => number } = {}) {
  const reload = vi.fn();
  const storage = o.storage ?? memStore();
  const w = new BuildWatch({ fetch: fetchFn as unknown as typeof fetch, doc: document, win: window, storage, reload, busy: o.busy ?? (() => false), now: o.now });
  return { w, reload, storage };
}

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  served = () => new Response(page(NEW), { status: 200, headers: { "content-type": "text/html" } });
  fetchFn.mockClear();
  mount();
});
afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-e18s17]").forEach((e) => e.remove());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("T18-S17 detect", () => {
  it("reads the entry script from index.html and from the running page", () => {
    expect(entryOf(page(NEW))).toBe(NEW);
    expect(entryOf('<script type="module" crossorigin src="https://team.example.com/assets/index-Abc_9.js?x=1"></script>')).toBe("/assets/index-Abc_9.js");
    expect(entryOf("<html><body>Sign in</body></html>")).toBeUndefined();
    expect(loadedEntry(document)).toBe(OLD);
  });

  it("the built index.html carries a hashed entry the watcher can read (when built)", () => {
    const dist = path.resolve(__dirname, "../../dist/index.html");
    if (!fs.existsSync(dist)) return;
    expect(entryOf(fs.readFileSync(dist, "utf8"))).toMatch(/^\/assets\/index-[\w-]+\.js$/);
  });

  it("asks for the app page with no cache and finds a newer build", async () => {
    const { w } = watch();
    await w.check();
    expect(fetchFn).toHaveBeenCalledWith("/", expect.objectContaining({ cache: "no-store" }));
    expect(w.pending).toBe(NEW);
  });

  it("the same build, a failed fetch, an error, a login page or a redirect is not a new build", async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response(page(OLD)),
      () => Promise.reject(new TypeError("offline")),
      () => new Response("bad gateway", { status: 502 }),
      () => new Response("<html><form>Sign in</form></html>"),
      () => {
        const r = new Response(page(NEW));
        Object.defineProperty(r, "redirected", { value: true });
        return r;
      },
    ];
    for (const a of answers) {
      served = a;
      const { w, reload } = watch();
      await w.back("visible");
      expect(w.pending).toBeUndefined();
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it("checks every 5 minutes while visible, never while hidden", async () => {
    vi.useFakeTimers();
    const { w } = watch();
    const off = w.start();
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(fetchFn).not.toHaveBeenCalled();
    visibility = "visible";
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    off();
  });

  it("the 5-minute check reloads an untouched open page when nothing would be lost", async () => {
    vi.useFakeTimers();
    served = () => new Response(page(NEW));
    const { w, reload } = watch();
    const off = w.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    off();
  });

  it("the 5-minute check never reloads under a recent click or scroll, or with typed words: the bar shows instead", async () => {
    vi.useFakeTimers();
    served = () => new Response(page(NEW));
    const { w, reload } = watch();
    const off = w.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1000);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.pending).toBe(NEW);
    expect(reload).not.toHaveBeenCalled();
    const box = document.createElement("textarea");
    box.value = "half a sentence";
    document.body.appendChild(box);
    await vi.advanceTimersByTimeAsync(Math.max(IDLE_MS, CHECK_EVERY_MS));
    expect(reload).not.toHaveBeenCalled();
    box.value = "";
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    off();
  });

  it("focus checks at most once per gap", async () => {
    let t = 1_000_000;
    const { w } = watch({ now: () => t });
    served = () => new Response(page(OLD));
    await w.back("focus");
    await w.back("focus");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t += FOCUS_GAP_MS;
    await w.back("focus");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does nothing in dev (no hashed entry, or not enabled)", async () => {
    document.querySelectorAll("[data-e18s17]").forEach((e) => e.remove());
    mount("/src/main.tsx");
    const { w, reload } = watch();
    await w.back("visible");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    render(<NewBuild enabled={false} />);
    fireEvent(document, new Event("visibilitychange"));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("T18-S17 act", () => {
  it("reloads by itself when the page comes back and nothing would be lost", async () => {
    const { w, reload, storage } = watch();
    const off = w.start();
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(storage.m.get(RELOADED_KEY)).toBe(NEW);
    off();
  });

  it("typed words in a box, a file waiting or text in an input stop the reload", async () => {
    for (const html of ['<textarea>my answer</textarea>', '<input type="text" value="half a title">', '<ul><li data-testid="chat-attach-item"></li></ul>']) {
      document.body.innerHTML = html;
      expect(hasUnsent(document)).toBe(true);
      const { w, reload } = watch();
      await w.back("visible");
      expect(w.pending).toBe(NEW);
      expect(reload).not.toHaveBeenCalled();
    }
    document.body.innerHTML = '<textarea>   </textarea><input type="checkbox" checked><input type="hidden" value="x">';
    expect(hasUnsent(document)).toBe(false);
  });

  it("a voice note or a call on stops the reload (the tab's owners say busy)", async () => {
    const notes = new NoteTab(undefined);
    const calls = new CallTab(undefined);
    expect(notes.busy()).toBe(false);
    expect(calls.busy()).toBe(false);
    const { w, reload } = watch({ busy: () => true });
    await w.back("visible");
    expect(w.pending).toBe(NEW);
    expect(reload).not.toHaveBeenCalled();
  });

  it("never loops: one reload per new build per tab", async () => {
    const storage = memStore();
    const a = watch({ storage });
    await a.w.back("visible");
    expect(a.reload).toHaveBeenCalledTimes(1);
    // The reloaded page still got the old build (a stale proxy): the same new build is not reloaded for again.
    const b = watch({ storage });
    await b.w.back("visible");
    expect(b.w.pending).toBe(NEW);
    expect(b.reload).not.toHaveBeenCalled();
    // A later build is.
    served = () => new Response(page("/assets/index-NEWER3.js"));
    const c = watch({ storage });
    await c.w.back("visible");
    expect(c.reload).toHaveBeenCalledTimes(1);
  });

  it("no session storage: never reloads by itself", async () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("off"); } };
    const reload = vi.fn();
    const w = new BuildWatch({ fetch: fetchFn as unknown as typeof fetch, doc: document, win: window, storage, reload, busy: () => false });
    await w.back("visible");
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows one Reload bar when it cannot reload, and Reload reloads", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    render(
      <div>
        <textarea defaultValue="typed" />
        <NewBuild enabled deps={{ reload, fetch: fetchFn as unknown as typeof fetch }} />
      </div>,
    );
    expect(screen.queryByTestId("new-build")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    });
    expect(screen.getByTestId("new-build").textContent).toContain("A new version is live.");
    expect(screen.getAllByTestId("new-build")).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-build-reload").className).toContain("max-sm:min-h-11");
    fireEvent.click(screen.getByTestId("new-build-reload"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the bar hides until a later build", async () => {
    vi.useFakeTimers();
    render(<NewBuild enabled deps={{ reload: vi.fn(), fetch: fetchFn as unknown as typeof fetch, busy: () => true }} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    });
    fireEvent.click(screen.getByTestId("new-build-hide"));
    expect(screen.queryByTestId("new-build")).toBeNull();
  });

  it("the service worker never serves a stale page online (the offline copy only when the network fails)", () => {
    const sw = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
    // only a navigation gets the kept shell, and only in the catch of the network fetch: this build check's fetch of the
    // page (not a navigation) always reaches the console.
    const page = sw.slice(sw.indexOf("async function page("), sw.indexOf("async function asset("));
    expect(page.indexOf("await fetch(q)")).toBeGreaterThan(-1);
    expect(page.indexOf("await fetch(q)")).toBeLessThan(page.indexOf("catch"));
    expect(page.indexOf("c.match(")).toBeGreaterThan(page.indexOf("catch"));
    expect(sw).toMatch(/q\.mode === "navigate"/);
    expect(sw).toMatch(/q\.method !== "GET"/);
  });
});
