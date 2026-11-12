import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { makeFixtureRoot } from "./fixtures.js";

/** a title saved in Settings wins over the spine's own title; clearing it goes back to the spine's. */
const P = "docs/spines/epic-900.md";
const SPINE = "EPIC 0 · Foundation Spine";

describe("T6-S26 Settings title override", () => {
  let fx: ReturnType<typeof makeFixtureRoot>;
  let dbDir: string;
  let db: DB;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    fx = makeFixtureRoot();
    fx.write("poly-maker/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/poly-maker.git\n`);
    fx.write(`poly-maker/${P}`, `# ${SPINE}\n\n## Current State\n\nStatus: active\n`);
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s26-"));
    db = openDb(path.join(dbDir, "c.db"));
    const spines = async () => { throw new Error("spines.py missing"); };
    app = createApp(db, { read: { reposRoot: fx.root, seatsFile: path.join(fx.root, "seats.json"), listThreads: async () => [], spines } as ReadConfig });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fx.cleanup();
  });
  const json = { "Content-Type": "application/json" };
  const create = async () =>
    (await app.request("/api/milestones", { method: "POST", headers: json, body: JSON.stringify({ title: "Memo", repo: "poly-maker", path: P, owner: "Sam" }) })).json();
  const patch = async (id: string, body: object) =>
    (await app.request(`/api/milestones/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) })).json();
  const listed = async (id: string) => ((await (await app.request("/api/milestones")).json()) as { id: string }[]).find((m) => m.id === id) as Record<string, unknown>;

  it("a created milestone follows the spine title (no override)", async () => {
    const m = await create();
    expect(m.docTitle).toBe(SPINE);
    expect(m.titleOverride).toBeUndefined();
  });

  it("saving the stored title again (it differs from the spine's) marks it explicit; detail and list agree", async () => {
    const m = await create();
    const out = await patch(m.id, { title: "Memo" });
    expect(out).toMatchObject({ title: "Memo", docTitle: SPINE, titleOverride: true });
    expect(await listed(m.id)).toMatchObject({ title: "Memo", titleOverride: true });
    expect(await (await app.request(`/api/milestones/${m.id}`)).json()).toMatchObject({ title: "Memo", titleOverride: true });
  });

  it("a PATCH without title (other fields) keeps the mark; an empty title clears it and keeps the stored title", async () => {
    const m = await create();
    await patch(m.id, { title: "Memo launch" });
    expect(await patch(m.id, { owner: "Ana" })).toMatchObject({ title: "Memo launch", titleOverride: true });
    const cleared = await patch(m.id, { title: "  " });
    expect(cleared.title).toBe("Memo launch");
    expect(cleared.titleOverride).toBeUndefined();
    expect(cleared.docTitle).toBe(SPINE);
  });

  it("saving the spine's own title clears the mark (the spine's title shows from then on)", async () => {
    const m = await create();
    await patch(m.id, { title: "Memo" });
    const out = await patch(m.id, { title: SPINE });
    expect(out.title).toBe(SPINE);
    expect(out.titleOverride).toBeUndefined();
    expect(out.docTitle).toBeUndefined();
  });

  it("create still requires a title", async () => {
    const res = await app.request("/api/milestones", { method: "POST", headers: json, body: JSON.stringify({ title: "", repo: "poly-maker", path: P }) });
    expect(res.status).toBe(400);
  });
});
