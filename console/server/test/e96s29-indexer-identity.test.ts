import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { indexerEnv } from "../src/indexer/launch.js";
import { identity } from "../src/identity.js";

/**
 * E996-S29: the indexer process ran with the neutral identity (home world `home`, owner "the owner"), so the real home
 * world's milestones on a symlinked checkout read as another world's refused repo and their asks (T9-A10's private
 * key box) never reached the owner. The console's identity now travels in the indexer's config and is set first.
 */
describe("E996-S29 indexer identity", () => {
  it("hands the console's identity to the indexer in its config", () => {
    const env = indexerEnv({ dbPath: "/d", reposRoot: "/r" }, 42, { PATH: "/bin" });
    const c = JSON.parse(env.CONSOLE_INDEXER_CONFIG);
    expect(c.identity).toEqual(identity());
    expect(Object.keys(env)).not.toContain("CONSOLE_OWNER_NAME"); // nothing else of the console's env leaks
  });

  it("the indexer process takes the home world and owner from its config before its database opens", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e96s29-"));
    const dbPath = path.join(dir, "console.db");
    const reposRoot = path.join(dir, "repos");
    fs.mkdirSync(reposRoot);
    const config = { dbPath, reposRoot, tickMs: 0, bookTickMs: 0, startReportMs: 0, identity: { owner: "Ada", homeWorld: "acme9" } };
    // a parent pid that is gone: the indexer opens its database, starts, sees no console and stops within a second or two.
    const r = spawnSync(process.execPath, [path.join(__dirname, "../src/indexer/indexer-dev.mjs")], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, CONSOLE_INDEXER_CONFIG: JSON.stringify(config), CONSOLE_INDEXER_PARENT: "999999" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    const tenants = db.prepare("SELECT id, owner_handle AS owner FROM tenants").all();
    db.close();
    expect(tenants).toEqual([{ id: "acme9", owner: "Ada" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);
});
