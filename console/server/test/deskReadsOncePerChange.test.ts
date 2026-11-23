// the desk's sweeps read a spine or an inbox note once per change, not once per placement or per sweep.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { createPlacements, ledgerRow, ledgerRows, migratePlacements } from "../src/desk/placements.js";
import { readInbox } from "../src/desk/inbox.js";

const spine = (s2: string) =>
  ["# EPIC-907: Test", "", "## Issue Ledger", "| ID | Title | Status |", "|---|---|---|", "| E907-S1 | One | ready |", `| E907-S2 | Two | ${s2} |`, "| E907-S3 | Three | ready |", ""].join("\n");

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "desk-reads-"));
  fs.mkdirSync(path.join(root, "r", "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "r", "desk", "inbox"), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("placements: one read per spine version", () => {
  it("reads a shared spine once for all its placements, again only after it changes, and sees the change", () => {
    const f = path.join(root, "r", "docs", "e.md");
    fs.writeFileSync(f, spine("ready"));
    const db = openDb(":memory:");
    migratePlacements(db);
    const pl = createPlacements({ db, reposRoot: root });
    for (const id of ["E907-S1", "E907-S2", "E907-S3"]) pl.place({ repo: "r", path: "docs/e.md", kind: "row", itemId: id });
    fs.writeFileSync(f, spine("done") + "\n"); // a new version: size changes
    const reads = vi.spyOn(fs, "readFileSync");
    const states = pl.list().map((p) => [p.itemId, p.state]);
    expect(reads.mock.calls.filter(([p]) => p === f)).toHaveLength(1);
    expect(states).toEqual([["E907-S1", "placed"], ["E907-S2", "delivered"], ["E907-S3", "placed"]]);
    pl.list();
    expect(reads.mock.calls.filter(([p]) => p === f)).toHaveLength(1); // unchanged: no read
  });

  it("ledgerRows matches ledgerRow row by row, the first of a repeated id wins", () => {
    const t = spine("done") + "| E907-S2 | Again | dropped |\n";
    expect(ledgerRows(t).get("E907-S2")).toEqual(ledgerRow(t, "E907-S2"));
    expect(ledgerRow(t, "E907-S2")).toEqual({ title: "Two", status: "done" });
    expect(ledgerRow(t, "E909-S9")).toBeUndefined();
  });
});

describe("readInbox: a note is parsed again only when its file changes", () => {
  const note = (about: string, status = "open") => `---\nfrom: sam\nabout: ${about}\nstatus: ${status}\n---\nbody\n`;
  it("serves unchanged notes from memory, rereads a changed one and forgets a removed one", () => {
    const dir = path.join(root, "r", "desk", "inbox");
    fs.writeFileSync(path.join(dir, "a.md"), note("A"));
    fs.writeFileSync(path.join(dir, "b.md"), note("B"));
    expect(readInbox(path.join(root, "r")).map((n) => n.about)).toEqual(["A", "B"]);
    const reads = vi.spyOn(fs, "readFileSync");
    readInbox(path.join(root, "r"));
    expect(reads).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(dir, "b.md"), note("B", "answered"));
    fs.rmSync(path.join(dir, "a.md"));
    const now = readInbox(path.join(root, "r"));
    expect(now.map((n) => [n.about, n.status])).toEqual([["B", "answered"]]);
    expect(reads).toHaveBeenCalledTimes(1);
    now[0].status = "changed by a caller";
    expect(readInbox(path.join(root, "r"))[0].status).toBe("answered"); // callers get copies
  });
});
