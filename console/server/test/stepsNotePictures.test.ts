import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createAttachments } from "../src/desk/attachments.js";
import { cardFilesLine } from "../src/desk/attachLimits.js";
import type { EditInput, SpineWriter } from "../src/inbox/spineWrite.js";
import { isOpen } from "../src/auth/routeScope.js";
import { createSteps, mountSteps, shortWords } from "../src/steps/steps.js";
import { mountStepsView, rewriteHtml } from "../src/steps/stepView.js";

// every note box on a steps page takes pictures (attached or pasted, uploaded by the page token, sent with
// the note as one line of links) and records voice in place on the page's secure copy, served by the console.

const SPINE = "docs/spines/epic-9.md";
const TEXT = `# PLAN-9: test

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-11-01 | accepted | first | one | x | never |
`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);

describe("steps note boxes: pictures and the secure copy", () => {
  let db: DB;
  let repo: string;
  let dir: string;
  const writer = (): SpineWriter =>
    ({
      edit: async (o: EditInput) => {
        const file = path.join(o.repoDir, o.path);
        const e = o.edit(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "2026-11-12");
        if ("skip" in e) return { status: "skipped", reason: e.skip };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, e.text);
        return { status: "written", sha: "sha1", path: o.path };
      },
    }) as unknown as SpineWriter;

  beforeEach(() => {
    db = openDb(":memory:");
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "e96s31-"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "e96s31-att-"));
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(repo, SPINE), TEXT);
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setup = () => {
    const steps = createSteps({ db, pump: false, fileDelayMs: 0, writer: writer(), repoDir: (n) => (n === "repo1" ? repo : undefined), milestoneFor: async () => undefined });
    const atts = createAttachments({ db, dir, world: () => "default", publicUrl: "https://team.example.test" });
    const api = new Hono();
    mountSteps(api, steps, { add: (b, t, n, w) => atts.add(b, t, n, w), line: (ids, w) => atts.cardText("", ids, w) });
    const app = new Hono();
    app.route("/api", api);
    const p = steps.register({ title: "TEST pictures", url: "http://worker:9196/t/E907-S3/", repo: "repo1", spine: SPINE, by: "an agent" });
    return { steps, atts, app, p };
  };

  it("uploads a pasted screenshot by the page token and files it with the note as a line of links", async () => {
    const { app, p, steps } = setup();
    const up = await app.request(`/api/public/steps/${p.token}/files`, { method: "POST", headers: { "content-type": "image/png", "x-filename": "Screenshot%202026.png" }, body: PNG });
    expect(up.status).toBe(201);
    const { file } = (await up.json()) as { file: { id: string; name: string } };
    expect(file.id).toMatch(/^att_[a-f0-9]{12}$/);
    expect(file.name).toBe("Screenshot-2026.png");
    const r = await app.request(`/api/public/steps/${p.token}/ticks`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ step: "a", comment: "it says no", files: [file.id] }) });
    expect(r.status).toBe(200);
    const note = (steps.view(p).notes as Record<string, { words: string }[]>).a[0].words;
    expect(note).toMatch(/^it says no 📎 .* attached a file, open it with your console headers: https:\/\/team\.example\.test\/api\/chat\/attachments\/att_[a-f0-9]{12}\/Screenshot-2026\.png$/);
    // a picture alone is a note too
    const up2 = (await (await app.request(`/api/public/steps/${p.token}/files`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG })).json()) as { file: { id: string } };
    const r2 = await app.request(`/api/public/steps/${p.token}/ticks`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ step: "b", state: "stuck", files: [up2.file.id] }) });
    expect(r2.status).toBe(200);
  });

  it("refuses what is not a picture, a bad token, an id it did not make, and answers the preflight", async () => {
    const { app, p } = setup();
    const pdf = await app.request(`/api/public/steps/${p.token}/files`, { method: "POST", headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" });
    expect(pdf.status).toBe(415);
    const fake = await app.request(`/api/public/steps/${p.token}/files`, { method: "POST", headers: { "content-type": "image/png" }, body: "not a png" });
    expect(fake.status).toBe(415);
    const bad = await app.request(`/api/public/steps/nope-nope-nope-nope-nope/files`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    expect(bad.status).toBe(404);
    const ghost = await app.request(`/api/public/steps/${p.token}/ticks`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ step: "a", files: ["att_000000000000"] }) });
    expect(ghost.status).toBe(404);
    const pre = await app.request(`/api/public/steps/${p.token}/files`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-filename");
    expect(isOpen("POST", `/api/public/steps/${p.token}/files`)).toBe(true);
    expect(isOpen("OPTIONS", `/api/public/steps/${p.token}/files`)).toBe(true);
    expect(isOpen("GET", "/api/public/steps-keep.js")).toBe(true);
    // the secure copy is never an open path: the console's login guards it
    expect(isOpen("GET", `/steps/view/${p.id}/t/E907-S3/`)).toBe(false);
  });

  it("keeps a long note's files line whole in the spine line", () => {
    const line = cardFilesLine(["https://team.example.test/api/chat/attachments/att_0123456789ab/s.png"]);
    const out = shortWords(`${"word ".repeat(300)}${line}`);
    expect(out).toContain("…");
    expect(out.endsWith("att_0123456789ab/s.png")).toBe(true);
  });

  it("serves the registered page as a secure copy: kit from this console, its own links inside the copy, no other host", async () => {
    const { steps, p } = setup();
    const seen: string[] = [];
    const page = `<html><head><link rel="stylesheet" href="http://host1:8750/steps-kit.css"></head><body>
<a href="/t/E907-S4/">next</a><img src="http://worker:9196/t/E907-S3/shot.webp"><a href="https://example.com/x">out</a>
<script src="steps-token.js"></script><script src="http://host1:8750/steps-kit.js" data-voice-origin="https://team.example.com" defer></script></body></html>`;
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/moved")) return new Response(null, { status: 302, headers: { location: "http://evil.test/" } });
      return new Response(url.endsWith(".js") ? 'window.STEPS_TOKEN="t";' : page, { status: 200, headers: { "content-type": url.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" } });
    }) as typeof fetch;
    const app = new Hono();
    mountStepsView(app, { byId: (id) => steps.byId(id), fetch: fake });
    const top = await app.request(`/steps/view/${p.id}`);
    expect(top.status).toBe(302);
    expect(top.headers.get("location")).toBe(`/steps/view/${p.id}/t/E907-S3/`);
    const r = await app.request(`/steps/view/${p.id}/t/E907-S3/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(seen).toEqual(["http://worker:9196/t/E907-S3/"]);
    expect(html).toContain('href="/steps-kit.css"');
    expect(html).toContain('src="/steps-kit.js" defer');
    expect(html).not.toContain("data-voice-origin");
    expect(html).toContain(`href="/steps/view/${p.id}/t/E907-S4/"`);
    expect(html).toContain(`src="/steps/view/${p.id}/t/E907-S3/shot.webp"`);
    expect(html).toContain('href="https://example.com/x"');
    const js = await app.request(`/steps/view/${p.id}/t/E907-S3/steps-token.js`);
    expect(await js.text()).toBe('window.STEPS_TOKEN="t";');
    // a redirect off the page's host is not followed; a missing page is a 404
    expect((await app.request(`/steps/view/${p.id}/moved`)).status).toBe(502);
    expect((await app.request(`/steps/view/sp_00000000/`)).status).toBe(404);
    // a protocol-relative path cannot reach another host
    await app.request(`/steps/view/${p.id}//evil.test/x`);
    expect(seen.every((u) => u.startsWith("http://worker:9196/"))).toBe(true);
  });

  it("rewriteHtml leaves protocol-relative and other hosts alone", () => {
    expect(rewriteHtml('<a href="//cdn.test/x">', "http://w:1", "/steps/view/sp_1")).toBe('<a href="//cdn.test/x">');
  });
});
