import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { BIG_BLOB_BYTES, cloneDirFor, createCloneWriter, exactPattern } from "../src/inbox/writeClone.js";
import { git, makeRepo } from "./reviewFixture.js";

/**
 * the console's write copies held 769 MB, mostly
 * tax-assist-research's big.docx and base64 text and macro_dash's docs/reports/*.html. Every tracked file over 1 MB now
 * stays out of a write copy's tree, a big file added later goes on the next write, and a write to one still lands.
 */
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});
const big = "x".repeat(BIG_BLOB_BYTES + 1);

describe("T6-S73 write copies leave out files over 1 MB", () => {
  it("leaves big files out (odd names too), drops one added later, and still writes to one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s73-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(
      root,
      "r1",
      {
        "AGENTS.md": "a\n",
        "docs/reports/cube/index.html": big,
        "06_Respuesta/20_word/A01 Anexo [1]*Gastos ñ.docx": big,
        "docs/reports/small/index.html": "<p>small</p>\n",
        "notes.md": "n\n",
      },
      { cards: false },
    );
    const logs: string[] = [];
    const w = createCloneWriter(createSpineWriter(), { root: path.join(root, "_write"), log: (m) => logs.push(m), checkTtlMs: 0 });
    const edit = (rel: string, text: string) =>
      w.edit({ repoDir: repo.dir, path: rel, label: "t", edit: () => ({ text, msg: `edit ${rel}`, body: "b" }) });
    expect((await edit("notes.md", "n1\n")).status).toBe("written");
    const clone = w.cloneOf(repo.dir)!;
    const has = (rel: string) => fs.existsSync(path.join(clone, rel));
    expect(has("docs/reports/cube/index.html")).toBe(false);
    expect(has("06_Respuesta/20_word/A01 Anexo [1]*Gastos ñ.docx")).toBe(false);
    expect(["AGENTS.md", "notes.md", "docs/reports/small/index.html"].every(has)).toBe(true);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(logs.some((l) => /leaves out 2 file\(s\) over/.test(l))).toBe(true);

    // a big file pushed later by someone else goes on the next write
    fs.writeFileSync(path.join(repo.dir, "late.txt"), big);
    git(repo.dir, "add", "late.txt");
    git(repo.dir, "commit", "-q", "-m", "late");
    git(repo.dir, "push", "-q", "origin", "main");
    expect((await edit("notes.md", "n2\n")).status).toBe("written");
    expect((await edit("notes.md", "n3\n")).status).toBe("written");
    expect(has("late.txt")).toBe(false);
    expect(git(repo.bare, "show", "main:notes.md")).toBe("n3");

    // a write to a big file widens for it and lands; it stays in afterwards
    expect((await edit("docs/reports/cube/index.html", "<p>now small</p>\n")).status).toBe("written");
    expect(git(repo.bare, "show", "main:docs/reports/cube/index.html")).toBe("<p>now small</p>");
    expect((await edit("notes.md", "n4\n")).status).toBe("written");
    expect(has("docs/reports/cube/index.html")).toBe(true);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("a write copy made before the size cap sheds its big files on its next write", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s73-old-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "r1", { "a.md": "a\n", "docs/reports/r.html": big }, { cards: false });
    const writeRoot = path.join(root, "_write");
    const w1 = createCloneWriter(createSpineWriter(), { root: writeRoot, log: () => {}, checkTtlMs: 0 });
    expect((await w1.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text: "b\n", msg: "m", body: "b" }) })).status).toBe("written");
    const dir = cloneDirFor(writeRoot, repo.dir);
    // as a pre- copy: only the old patterns, the big file checked out
    git(dir, "sparse-checkout", "set", "--no-cone", "/*", "!/docs/status/");
    expect(fs.existsSync(path.join(dir, "docs/reports/r.html"))).toBe(true);
    expect((await w1.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text: "c\n", msg: "m", body: "b" }) })).status).toBe("written");
    expect(fs.existsSync(path.join(dir, "docs/reports/r.html"))).toBe(false);
  });

  it("exactPattern escapes glob characters", () => {
    expect(exactPattern("a/b [1]*?.docx")).toBe("/a/b \\[1\\]\\*\\?.docx");
    expect(exactPattern("/x.md")).toBe("/x.md");
  });
});
