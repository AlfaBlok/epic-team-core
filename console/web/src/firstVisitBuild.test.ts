// the build side of a phone's first visit: the libraries in their own cached script, the screen's script
// asked for with the app's entry (node environment: the vite config loads esbuild, which jsdom breaks).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MOCK_STUB_ID, ROUTE_PRELOADS, WIDE_MEDIA, WIDE_PRELOADS, realApiOnly, routePreloadMap, vendorChunk } from "../vite.config";

describe("the vendor script", () => {
  it("holds React, the router and tailwind-merge, never the app's own code or other libraries", () => {
    expect(vendorChunk("/x/node_modules/react/index.js")).toBe("vendor");
    expect(vendorChunk("/x/node_modules/react-dom/cjs/react-dom.production.min.js")).toBe("vendor");
    expect(vendorChunk("/x/node_modules/@remix-run/router/dist/router.js")).toBe("vendor");
    expect(vendorChunk("C:\\x\\node_modules\\scheduler\\index.js")).toBe("vendor");
    expect(vendorChunk("/x/node_modules/tailwind-merge/dist/bundle.mjs")).toBe("vendor");
    expect(vendorChunk("/x/src/pages/Chat.tsx")).toBeUndefined();
    expect(vendorChunk("/x/node_modules/lucide-react/dist/icon.js")).toBeUndefined();
    expect(vendorChunk("/x/node_modules/react-markdown/index.js")).toBeUndefined();
  });
});

describe("the route preloads", () => {
  const bundle = {
    "assets/index-a.js": { type: "chunk", fileName: "assets/index-a.js", isEntry: true, moduleIds: ["/r/src/main.tsx"], imports: ["assets/vendor-v.js"] },
    "assets/vendor-v.js": { type: "chunk", fileName: "assets/vendor-v.js", moduleIds: ["/r/node_modules/react/index.js"], imports: [] },
    "assets/Chat-c.js": { type: "chunk", fileName: "assets/Chat-c.js", moduleIds: ["/r/src/pages/Chat.tsx"], imports: ["assets/send-s.js", "assets/vendor-v.js", "assets/index-a.js"] },
    "assets/send-s.js": { type: "chunk", fileName: "assets/send-s.js", moduleIds: ["/r/node_modules/lucide-react/send.js"], imports: [] },
    "assets/index-x.css": { type: "asset", fileName: "assets/index-x.css" },
  };

  it("names a screen's script and what it imports, minus what the entry already loads", () => {
    const map = routePreloadMap(bundle, ROUTE_PRELOADS, []);
    expect(map).toEqual([["^\\/chat\\/?$", ["assets/Chat-c.js", "assets/send-s.js"]]]);
    expect(new RegExp(map[0][0]).test("/chat")).toBe(true);
    expect(new RegExp(map[0][0]).test("/chat/")).toBe(true);
    expect(new RegExp(map[0][0]).test("/chatty")).toBe(false);
  });

  it("skips a screen that is in the entry already or gone", () => {
    expect(routePreloadMap(bundle, [[/^\/x$/, "src/pages/Gone.tsx"], [/^\/$/, "src/main.tsx"]], [])).toEqual([]);
  });

  it("covers Chat, the milestone page, the Inbox and Home, the screens a phone opens first", () => {
    expect(ROUTE_PRELOADS.map(([, m]) => m)).toEqual(["src/pages/Chat.tsx", "src/pages/Milestone.tsx", "src/pages/Team.tsx", "src/components/homeView.tsx"]);
    const inbox = ROUTE_PRELOADS.find(([, m]) => m === "src/pages/Team.tsx")![0];
    expect(inbox.test("/inbox")).toBe(true);
    expect(inbox.test("/inboxes")).toBe(false);
  });

  // the laptop's sidebar scripts, asked beside the entry on a wide screen only (an "@<media>" entry)
  it("adds the wide screen's scripts under its media query, once each, never the entry's", () => {
    const map = routePreloadMap(bundle, [], ["src/pages/Chat.tsx"]);
    expect(map).toEqual([[`@${WIDE_MEDIA}`, ["assets/Chat-c.js", "assets/send-s.js"]]]);
    expect(WIDE_PRELOADS).toEqual(["src/components/goalSets.tsx"]);
  });
});

describe("the first download of a production build", () => {
  it("gets a stub for the mock API, which a real build never calls", () => {
    const real = realApiOnly("real") as unknown as { resolveId: (s: string, i?: string) => string | null; load: (id: string) => string | null };
    expect(real.resolveId("./mock", "/r/src/api/index.ts")).toBe(MOCK_STUB_ID);
    expect(real.resolveId("./mock", "/r/src/lib/other.ts")).toBeNull();
    expect(real.load(MOCK_STUB_ID)).toMatch(/export function createMockClient/);
    const mock = realApiOnly(undefined) as unknown as { resolveId: (s: string, i?: string) => string | null };
    expect(mock.resolveId("./mock", "/r/src/api/index.ts")).toBeNull();
  });

  // the app frame and the Inbox page reach these only through import() (lib/lazyPage, lib/sidebarScripts):
  // a static import puts the screen back into what a phone downloads before its inbox shows.
  const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
  const staticFrom = (f: string) => [...src(f).matchAll(/^import[^;]*?from "([^"]+)"/gms)].map((m) => m[1]);
  it.each([
    ["App.tsx", ["@/components/homeView", "@/components/pursuits", "@/pages/Team"]],
    ["components/Layout.tsx", ["@/components/goalSets", "@/components/campaignHome"]],
    ["pages/Team.tsx", ["@/components/dialogs", "@/pages/Campaigns", "@/pages/social/parts", "@/components/goalSets"]],
  ])("%s imports none of its later screens statically", (file, later) => {
    const got = staticFrom(file);
    for (const l of later) expect(got, `${file} imports ${l}`).not.toContain(l);
  });
});
