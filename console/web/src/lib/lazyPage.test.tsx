// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHUNK_RELOADED_KEY, lazyPage, reloadForNewBuild } from "@/lib/lazyPage";

// the first download: a fresh open loads only what the first screen needs

function fakeWindow(entry = "/assets/index-abc.js") {
  const store = new Map<string, string>();
  const reload = vi.fn();
  const doc = document.implementation.createHTMLDocument("x");
  const s = doc.createElement("script");
  s.setAttribute("src", entry);
  doc.head.appendChild(s);
  return {
    win: { document: doc, sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }, location: { reload } } as unknown as Window,
    reload,
    store,
  };
}

afterEach(() => sessionStorage.clear());

describe("screens load on first open", () => {
  it("a screen shows Loading… then itself, with its props", async () => {
    let done!: (m: { Hello: (p: { name: string }) => JSX.Element }) => void;
    const Hello = lazyPage(() => new Promise<{ Hello: (p: { name: string }) => JSX.Element }>((r) => (done = r)), "Hello");
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(<Hello name="Sam" />));
    expect(el.textContent).toBe("Loading…");
    await act(async () => done({ Hello: ({ name }) => <p>Hi {name}</p> }));
    expect(el.textContent).toBe("Hi Sam");
    root.unmount();
  });

  it("a script gone after a release reloads the page once per build, never in a loop", () => {
    const a = fakeWindow();
    expect(reloadForNewBuild(a.win)).toBe(true);
    expect(a.reload).toHaveBeenCalledTimes(1);
    expect(a.store.get(CHUNK_RELOADED_KEY)).toBe("/assets/index-abc.js");
    // the same build failing again (a real outage): no second reload, the page shows its error
    expect(reloadForNewBuild(a.win)).toBe(false);
    expect(a.reload).toHaveBeenCalledTimes(1);
  });

  it("the first screen's code names no heavy screen statically (they would be back in the first download)", () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const heavy = ["@/pages/Milestone", "@/pages/Chat", "@/pages/Team", "@/components/waiting", "@/components/review", "@/components/dialogs", "@/pages/EpicDeck", "@/pages/social/Pipeline"];
    for (const f of ["App.tsx", "components/Layout.tsx", "components/homeView.tsx", "components/goalSets.tsx", "components/outcome.tsx", "components/tree.tsx"]) {
      const statics = [...src(f).matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
      expect(statics.filter((s) => heavy.includes(s)), f).toEqual([]);
    }
  });

  it("Home asks for its goals list beside the code; the Inbox's lists wait unless the Inbox is the page", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
    const script = /<script>\s*\/\/ what the first screen shows[\s\S]*?<\/script>/.exec(html)![0].replace(/<\/?script>/g, "");
    const run = (pathname: string, hostname = "team.example.com") => {
      const fetched: string[] = [];
      const w = { location: { pathname, hostname }, fetch: (u: string) => (fetched.push(u), Promise.resolve({ ok: false })) } as unknown as Window & { __earlyGets?: object };
      new Function("window", "location", "fetch", script.replace(/window\.__earlyGets/g, "window.__earlyGets"))(w, w.location, w.fetch);
      return fetched;
    };
    expect(run("/")).toEqual(["/api/scorecards", "/api/status", "/api/laptop"]);
    expect(run("/inbox")).toContain("/api/waiting-on-owner?includeSuperseded=true&view=list");
    expect(run("/", "social.example.com")).toContain("/api/review-items");
    // Chat asks its last 20 messages beside the code; a social site's chat and other screens ask nothing
    expect(run("/chat")).toEqual(["/api/desk/messages?limit=20"]);
    expect(run("/chat", "social.example.com")).toEqual([]);
    expect(run("/runs")).toEqual([]);
  });
});
