import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createAuth } from "../src/auth/identity.js";
import { Hono } from "hono";
import { applyMark, consolePathOf, mountLandingMarks } from "../src/landing.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { tempCheckout } from "./helpers/gitRepo.js";
import { withIdentity } from "../src/identityPage.js";

// the voice-note landing reports at /landing/, read from the repo's docs/landing at request
// time (a commit is live once the checkout pulls), the home world only (they quote the owner's private notes), never outside the folder.

const OUTSIDE = "203.0.113.7";
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function makeApp(auth: "on" | "off") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e76s1-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const landing = path.join(dir, "landing");
  fs.mkdirSync(path.join(landing, "notes"), { recursive: true });
  fs.writeFileSync(path.join(landing, "index.html"), "<html>landing index</html>");
  fs.writeFileSync(path.join(landing, "notes", "2026-11-07.html"), "<html>7 Nov</html>");
  fs.writeFileSync(path.join(landing, "notes", "index.html"), "<html>notes index</html>");
  fs.mkdirSync(path.join(landing, "empty"));
  fs.writeFileSync(path.join(landing, "data.json"), '{"notes":[]}');
  fs.writeFileSync(path.join(landing, "build.py"), "print(1)");
  fs.writeFileSync(path.join(dir, "secret.html"), "outside");
  const dist = path.join(dir, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES ('memo', 'memo', 'social', 'founding', ?)").run(new Date().toISOString());
  const app = createApp(db, { auth, staticDir: dist, landingDir: landing, browser: { browserUrl: "http://127.0.0.1:9" } });
  const a = createAuth(db);
  const session = (email: string, tenant: string) => `console_session=${a.createSession(a.addMember({ email, tenant }), tenant).id}`;
  const get = (url: string, cookie?: string, dest?: string) =>
    app.request(url, { headers: { host: "team.example.com", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...(dest ? { "sec-fetch-dest": dest } : {}) } }, { incoming: { socket: { remoteAddress: OUTSIDE } } });
  return { get, session };
}

describe("E976-S1 round 3: the reports open inside the console", () => {
  it("maps each framed page to its console page, and nothing else", () => {
    expect(consolePathOf("/landing/")).toBe("/goal-graph");
    expect(consolePathOf("/landing/index.html")).toBe("/goal-graph");
    expect(consolePathOf("/landing/notes/2026-11-07-e-5fc46c.html")).toBe("/goal-graph/notes/2026-11-07-e-5fc46c");
    expect(consolePathOf("/landing/memory/index.html")).toBe("/memory-memory");
    expect(consolePathOf("/landing/memory/")).toBe("/memory-memory");
    for (const p of ["/landing/proposals/", "/landing/data.json", "/landing/notes/../x.html", "/landing/marks/a.json"]) expect(consolePathOf(p), p).toBeUndefined();
  });

  it("a page opened directly redirects into the console; the console's frame and agents get the file", async () => {
    const { get } = makeApp("off");
    const top = await get("/landing/notes/2026-11-07.html", undefined, "document");
    expect(top.status).toBe(302);
    expect(top.headers.get("location")).toBe("/goal-graph/notes/2026-11-07");
    expect((await get("/landing/", undefined, "document")).headers.get("location")).toBe("/goal-graph");
    expect(await (await get("/landing/notes/2026-11-07.html", undefined, "iframe")).text()).toBe("<html>7 Nov</html>");
    expect(await (await get("/landing/notes/2026-11-07.html")).text()).toBe("<html>7 Nov</html>");
    // a page the console does not frame (the data, a folder of another row) is served as before
    expect((await get("/landing/data.json", undefined, "document")).status).toBe(200);
    expect(await (await get("/landing/notes/", undefined, "document")).text()).toBe("<html>notes index</html>");
    // a missing page stays a 404 (no redirect to an empty console page)
    expect((await get("/landing/notes/nope.html", undefined, "document")).status).toBe(404);
    // the console page itself is the app
    expect(await (await get("/goal-graph/notes/2026-11-07", undefined, "document")).text()).toBe(withIdentity("<html>app</html>"));
  });
});

describe("E976-S1 landing reports at /landing/", () => {
  it("serves the folder's index, a note page and its data; /landing redirects to /landing/", async () => {
    const { get } = makeApp("off");
    const idx = await get("/landing/");
    expect(idx.status).toBe(200);
    expect(idx.headers.get("content-type")).toContain("text/html");
    expect(await idx.text()).toBe("<html>landing index</html>");
    expect(await (await get("/landing/notes/2026-11-07.html")).text()).toBe("<html>7 Nov</html>");
    // a sub-folder path serves its own index (the proposals and gap-finder pages); a folder without one is a 404
    expect(await (await get("/landing/notes/")).text()).toBe("<html>notes index</html>");
    expect((await get("/landing/empty/")).status).toBe(404);
    expect(await (await get("/landing/data.json")).json()).toEqual({ notes: [] });
    const bare = await get("/landing");
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe("/landing/");
  });

  it("never leaves the folder or serves a script; a missing page is a 404, not the app", async () => {
    const { get } = makeApp("off");
    for (const p of ["/landing/..%2Fsecret.html", "/landing/build.py", "/landing/nope.html"]) {
      const r = await get(p);
      expect([400, 404], p).toContain(r.status);
      expect(await r.text(), p).not.toMatch(/outside|print|app/);
    }
    // a dot segment is resolved by the URL parser before routing: it leaves /landing/ altogether (the app's page, not the file)
    expect(await (await get("/landing/%2e%2e/secret.html")).text()).not.toContain("outside");
  });

  it("needs a login; an home login reads it, another world's login gets a 404", async () => {
    const { get, session } = makeApp("on");
    const anon = await get("/landing/");
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/login");
    const sam = await get("/landing/", session("sam@example.com", "home"));
    expect(sam.status).toBe(200);
    expect(await sam.text()).toBe("<html>landing index</html>");
    const other = await get("/landing/", session("owner@example.com", "memo"));
    expect(other.status).toBe(404);
  });
});

// no 36-item score list; the owner marks a node "wrong place" on the tree and each tap is a commit of
// docs/landing/marks/<note>.json in the repo (L-45), which build.py reads into the weekly measure.
describe("E976-S1 round 2: wrong-place marks on the tree", () => {
  it("applyMark adds, clears and reviews, keeping items in order", () => {
    let m = applyMark("", "n1", { n: 7, verdict: "wrong", belongs: "EPIC-946" }, "t1", "Sam");
    m = applyMark(JSON.stringify(m), "n1", { n: 2, verdict: "wrong" }, "t2", "Sam");
    expect(Object.keys(m.marks)).toEqual(["2", "7"]);
    expect(m.marks["7"]).toEqual({ verdict: "wrong", belongs: "EPIC-946", at: "t1", by: "Sam" });
    m = applyMark(JSON.stringify(m), "n1", { n: 7, verdict: "clear" }, "t3", "Sam");
    expect(Object.keys(m.marks)).toEqual(["2"]);
    m = applyMark(JSON.stringify(m), "n1", { verdict: "reviewed" }, "t4", "Sam");
    expect(m.reviewed).toEqual({ at: "t4", by: "Sam" });
    expect(applyMark("not json", "n1", { verdict: "unreviewed" }, "t5", "Sam")).toEqual({ note: "n1", reviewed: null, marks: {} });
  });

  it("POST /api/landing/marks/<note> commits and pushes the marks file; bad input saves nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e76s1-marks-"));
    const data = { id: "2026-11-07-e-x", items: [{ n: 1 }, { n: 2 }] };
    const co = tempCheckout(root, "home_repo", { "docs/landing/data/2026-11-07-e-x.json": JSON.stringify(data), "docs/spines/root.md": "# EPIC: t\n\nIntegration policy: main-direct\n" });
    cleanup = () => {
      co.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    };
    const api = new Hono();
    mountLandingMarks(api, { writer: createSpineWriter(), repo: () => co.dir, who: () => "Sam" });
    const post = (note: string, body: unknown) => api.request(`/landing/marks/${note}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const r = await post("2026-11-07-e-x", { n: 2, verdict: "wrong", belongs: "  the SocialApp launch  " });
    expect(r.status).toBe(200);
    const onMain = JSON.parse(co.onMain("docs/landing/marks/2026-11-07-e-x.json"));
    expect(onMain.marks["2"]).toMatchObject({ verdict: "wrong", belongs: "the SocialApp launch", by: "Sam" });
    expect(co.log()[0]).toBe("Sam marked 2026-11-07-e-x: item 2 wrong place (belongs: the SocialApp launch)");
    expect((await post("2026-11-07-e-x", { verdict: "reviewed" })).status).toBe(200);
    expect(JSON.parse(co.onMain("docs/landing/marks/2026-11-07-e-x.json")).reviewed.by).toBe("Sam");

    const commits = co.log().length;
    expect((await post("2026-11-07-e-x", { n: 9, verdict: "wrong" })).status).toBe(400);
    expect((await post("2026-11-07-e-x", { n: 1, verdict: "maybe" })).status).toBe(400);
    expect((await post("nope", { n: 1, verdict: "wrong" })).status).toBe(404);
    expect((await post("..%2Fx", { n: 1, verdict: "wrong" })).status).not.toBe(200);
    expect(co.log().length).toBe(commits);
  });
});

// Round 4 (the owner, vn_e3c358a1: "I'm confused about what this is, to be honest. I don't understand what this is about."):
// the built report (docs/landing/build.py, committed) opens with one sentence saying what it is, reads one line aloud as an
// example, then the tree; the measures, findings and the two-memories box are gone from it.
describe("E976-S1 round 4: the report says what it is", () => {
  const repo = path.resolve(__dirname, "../../../..");
  const page = (f: string) => fs.readFileSync(path.join(repo, "docs/landing", f), "utf8").split("</style>")[1].split("<script>")[0];
  it("opens with the sentence, then one example line, then the tree with Wrong place on each line", () => {
    const html = page("notes/2026-11-07-e-5fc46c.html");
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text.startsWith("Each voice note you leave becomes tasks for the team. This page shows where each thing you said went, so you can catch what landed wrong.")).toBe(true);
    expect(text).toMatch(/For example, you said “[^”]+” → it became the task “[^”]+” in the epic “[^”]+”\./);
    expect(html.match(/class="node"/g)).toHaveLength(36);
    expect(html.match(/>Wrong place<\/button>/g)).toHaveLength(36);
    for (const gone of ['class="kpi', 'class="which"', "What we found", "Memo's side", "docs/landing/"]) expect(html).not.toContain(gone);
    expect(text).not.toMatch(/\bE\d+-S\d+\b/);
  });
  it("the list of notes says the same sentence and links each note", () => {
    const html = page("index.html");
    expect(html).toContain("Each voice note you leave becomes tasks for the team.");
    expect(html.match(/href="notes\/[\w-]+\.html"/g)).toHaveLength(3);
    expect(html).not.toContain("<table");
  });
});
