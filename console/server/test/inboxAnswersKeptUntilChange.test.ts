import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { tableVersion } from "../src/tableVersion.js";

/**
 * the inbox keeps its parsed answers between requests until the answers table changes, from any connection
 * (the console, its press worker, the indexer). A write the cache missed would show his old answer, or none.
 */

const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const fileDb = (): { db: DB; file: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e48s196-"));
  dirs.push(dir);
  const file = path.join(dir, "console.db");
  const db = openDb(file);
  dbs.push(db);
  return { db, file };
};
const other = (file: string) => {
  const d = new Database(file);
  dbs.push(d);
  return d;
};

describe("tableVersion", () => {
  it("changes on every insert, update and delete, from another connection too", () => {
    const { db, file } = fileDb();
    db.exec("CREATE TABLE things (id TEXT PRIMARY KEY, v TEXT)");
    const version = tableVersion(db, "things");
    const v0 = version();
    expect(v0).toBe(0);
    const o = other(file);
    o.prepare("INSERT INTO things VALUES ('a', '1')").run();
    const v1 = version()!;
    expect(v1).toBeGreaterThan(v0!);
    o.prepare("UPDATE things SET v = '2' WHERE id = 'a'").run();
    const v2 = version()!;
    expect(v2).toBeGreaterThan(v1);
    db.prepare("DELETE FROM things").run();
    expect(version()!).toBeGreaterThan(v2);
    // a second reader of the same table shares the counter (idempotent setup)
    expect(tableVersion(db, "things")()).toBe(version());
  });

  it("gives no version on a database it may not write: the caller reads fresh", () => {
    const { db, file } = fileDb();
    db.exec("CREATE TABLE things (id TEXT)");
    const ro = new Database(file, { readonly: true });
    dbs.push(ro);
    expect(tableVersion(ro as unknown as DB, "things")()).toBeUndefined();
  });

  it("refuses a table name that is not one", () => {
    const { db } = fileDb();
    expect(() => tableVersion(db, "x; DROP TABLE y")).toThrow();
  });
});

describe("the inbox list and its stored answers", () => {
  const item = (q: string) => JSON.stringify({ id: "wj_kept1", source: "ask", repo: "r", code: "T1-A1", path: "docs/spines/root.md", question: q, title: "T", state: "open" });
  const insert = (d: { prepare: DB["prepare"] }, text: string) =>
    d
      .prepare(
        `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, assignment_id, delivery, created_at, spine_status, spine_path, spine_at)
         VALUES ('jr_kept1', 'wj_kept1', NULL, ?, 'answer', ?, NULL, 'sent', ?, 'written', 'docs/spines/root.md', ?)`,
      )
      .run(item("Ship it?"), text, new Date().toISOString(), new Date().toISOString());
  const answers = async (app: ReturnType<typeof createApp>) =>
    ((await (await app.request("/api/waiting-on-owner")).json()) as { id: string; answer?: string; response?: { text: string } }[]).filter((i) => i.id === "wj_kept1");

  it("shows an answer another connection wrote, changed or removed, on the next read", async () => {
    const { db, file } = fileDb();
    const app = createApp(db);
    expect(await answers(app)).toEqual([]);
    const o = other(file);
    insert(o, "yes, ship it");
    const first = await answers(app);
    expect(first).toHaveLength(1);
    expect(first[0].response?.text).toBe("yes, ship it");
    expect(await answers(app)).toEqual(first); // kept: the same answer again
    o.prepare("UPDATE jordi_responses SET text = 'no, wait' WHERE id = 'jr_kept1'").run();
    expect((await answers(app))[0].response?.text).toBe("no, wait");
    o.prepare("DELETE FROM jordi_responses WHERE id = 'jr_kept1'").run();
    expect(await answers(app)).toEqual([]);
  });

  it("a list read never changes the kept answers for the next one", async () => {
    const { db } = fileDb();
    const app = createApp(db);
    insert(db, "yes, ship it");
    const a = await answers(app);
    a[0].response!.text = "changed by a caller";
    expect((await answers(app))[0].response?.text).toBe("yes, ship it");
  });
});
