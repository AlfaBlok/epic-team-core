// the build side of a phone's first visit: the libraries in their own cached script, the screen's script
// asked for with the app's entry (node environment: the vite config loads esbuild, which jsdom breaks).
import { describe, expect, it } from "vitest";
import { ROUTE_PRELOADS, routePreloadMap, vendorChunk } from "../vite.config";

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
    const map = routePreloadMap(bundle);
    expect(map).toEqual([["^\\/chat\\/?$", ["assets/Chat-c.js", "assets/send-s.js"]]]);
    expect(new RegExp(map[0][0]).test("/chat")).toBe(true);
    expect(new RegExp(map[0][0]).test("/chat/")).toBe(true);
    expect(new RegExp(map[0][0]).test("/chatty")).toBe(false);
  });

  it("skips a screen that is in the entry already or gone", () => {
    expect(routePreloadMap(bundle, [[/^\/x$/, "src/pages/Gone.tsx"], [/^\/$/, "src/main.tsx"]])).toEqual([]);
  });

  it("covers Chat and the milestone page, the two screens a phone opens first", () => {
    expect(ROUTE_PRELOADS.map(([, m]) => m)).toEqual(["src/pages/Chat.tsx", "src/pages/Milestone.tsx"]);
  });
});
