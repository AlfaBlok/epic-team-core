import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { memoReadOn } from "../src/store.js";

// a kept list read holds across writes to other tables and drops on a write to its own, from any connection
describe("lists kept until their own tables change", () => {
  it("keeps across other writes, re-reads after its table changes on another connection, and after maxAge", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-on-"));
    const file = path.join(dir, "c.db");
    const a = new Database(file);
    a.pragma("journal_mode = WAL");
    a.exec("CREATE TABLE runs (id TEXT); CREATE TABLE other (id TEXT); INSERT INTO runs VALUES ('r1');");
    let reads = 0;
    let t = 1_000;
    const list = () => memoReadOn(a as never, ["runs"], "runs-all", () => (reads++, a.prepare("SELECT id FROM runs ORDER BY id").all() as { id: string }[]), { now: () => t, maxAgeMs: 60_000 });
    expect(list().map((r) => r.id)).toEqual(["r1"]);
    a.prepare("INSERT INTO other VALUES ('x')").run();
    list();
    expect(reads).toBe(1);
    const b = new Database(file);
    b.prepare("INSERT INTO runs VALUES ('r2')").run();
    expect(list().map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(reads).toBe(2);
    b.prepare("UPDATE runs SET id = 'r3' WHERE id = 'r2'").run();
    expect(list().map((r) => r.id)).toEqual(["r1", "r3"]);
    list()[0].id = "changed by a caller";
    expect(list()[0].id).toBe("r1");
    expect(reads).toBe(3);
    t += 61_000;
    list();
    expect(reads).toBe(4);
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
