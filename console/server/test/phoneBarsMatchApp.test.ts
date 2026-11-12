import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { socialHead } from "../src/brand.js";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";

// (the owner, voice notes 2026-11-08: the installed app's status bar and back/home bar are bright white; "stay dark"):
// both phone bars take the app's dark colour, the see-through iOS status bar has the page padded under it.

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const read = (p: string) => fs.readFileSync(path.join(WEB, p), "utf8");
const DARK = "#09090b";

describe("T18-S10 phone bars match the app", () => {
  it("the app head: dark theme-color, see-through iOS status bar, page under it", () => {
    const html = read("index.html");
    expect(html).toContain(`<meta name="theme-color" content="${DARK}" data-app-theme>`);
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
    expect(html).toMatch(/name="viewport" content="[^"]*viewport-fit=cover/);
    expect(html).not.toContain('content="#ffffff">');
    // the social skin keeps them (same head, names swapped)
    expect(socialHead(html)).toContain("black-translucent");
  });

  it("both manifests open and paint dark", () => {
    for (const f of ["public/manifest.webmanifest", "public/manifest-social.webmanifest"]) {
      const m = JSON.parse(read(f));
      expect([f, m.theme_color, m.background_color]).toEqual([f, DARK, DARK]);
    }
  });

  it("the login page: theme-color per system theme, padded under the bars", () => {
    expect(LOGIN_PAGE()).toContain(`<meta name="theme-color" content="${DARK}" media="(prefers-color-scheme: dark)">`);
    expect(LOGIN_PAGE()).toContain('<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">');
    expect(LOGIN_PAGE()).toContain("env(safe-area-inset-top)");
  });

  it("the top bar, menu, page bottom and chat box keep clear of the bars; the page colour is under them", () => {
    const layout = read("src/components/Layout.tsx");
    expect(layout).toContain("pt-[env(safe-area-inset-top)]");
    expect(layout).toContain("pb-[calc(1.5rem+env(safe-area-inset-bottom))]");
    expect(layout).toContain('setAttribute("content", dark ? "#09090b" : "#ffffff")');
    expect(read("src/components/ui/sheet.tsx")).toContain("pt-[env(safe-area-inset-top)]");
    expect(read("src/pages/Chat.tsx")).toContain("-env(safe-area-inset-top)-env(safe-area-inset-bottom))");
    expect(read("src/index.css")).toMatch(/html \{ @apply bg-background; \}/);
  });
});
