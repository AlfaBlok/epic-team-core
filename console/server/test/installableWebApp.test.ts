import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { isOpen } from "../src/auth/routeScope.js";
import { socialHead } from "../src/brand.js";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";

// the PWA basics. A manifest per skin (EpicTeam, the social product by
// host), standalone display, the 192 and 512 icons, open without a session (Add to Home Screen fetches it with no cookie).

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const PUBLIC = path.join(WEB, "public");
/** the social skin's home-screen name, as its manifest in web/public carries it (a social host gets that manifest) */
const SOCIAL_APP: string = JSON.parse(fs.readFileSync(path.join(PUBLIC, "manifest-social.webmanifest"), "utf8")).name;
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s8-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
  fs.cpSync(PUBLIC, dist, { recursive: true }); // public/ as the build copies it, folders too (fonts/)
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const app = createApp(db, { auth: "on", staticDir: dist, browser: { browserUrl: "http://127.0.0.1:9" } });
  return (url: string, host: string) => app.request(url, { headers: { host } }, { incoming: { socket: { remoteAddress: "203.0.113.7" } } });
}

describe("T18-S8 installable web app", () => {
  it.each([
    ["manifest.webmanifest", "EpicTeam"],
    ["manifest-social.webmanifest", SOCIAL_APP],
  ])("%s names %s, opens standalone at / and lists icons that exist", (file, name) => {
    const m = JSON.parse(fs.readFileSync(path.join(PUBLIC, file), "utf8"));
    expect(m).toMatchObject({ name, short_name: name, start_url: "/", scope: "/", display: "standalone" });
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"]);
    for (const i of m.icons) expect(fs.existsSync(path.join(PUBLIC, i.src)), i.src).toBe(true);
  });

  it("the manifest is open (GET only) and served as application/manifest+json, per host", async () => {
    expect(isOpen("GET", "/manifest.webmanifest")).toBe(true);
    expect(isOpen("POST", "/manifest.webmanifest")).toBe(false);
    expect(isOpen("GET", "/manifest.json")).toBe(false);
    const get = makeApp();
    const team = await get("/manifest.webmanifest", "team.example.com");
    expect(team.status).toBe(200);
    expect(team.headers.get("content-type")).toBe("application/manifest+json");
    expect((await team.json()).name).toBe("EpicTeam");
    const social = await get("/manifest.webmanifest", "social.example.com");
    expect(social.status).toBe(200);
    expect((await social.json()).name).toBe(SOCIAL_APP);
    expect(SOCIAL_APP).not.toBe("EpicTeam");
  });

  it("index.html links the manifest and names the home-screen app; the social head renames it", () => {
    const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="EpicTeam">');
    expect(socialHead(html)).toContain('<meta name="apple-mobile-web-app-title" content="SocialApp">');
    // Add to Home Screen from the login page (a new phone, logged out) installs the same app.
    expect(LOGIN_PAGE()).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(socialHead(LOGIN_PAGE())).toContain('<meta name="apple-mobile-web-app-title" content="SocialApp">');
  });
});
