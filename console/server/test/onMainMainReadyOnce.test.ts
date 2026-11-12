import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { createSpineWriter, onMain, runner } from "../src/inbox/spineWrite.js";
import { makeRepo } from "./reviewFixture.js";

/**
 * three "writing it to the project… 250 s"
 * lines that never ended, and an answer that failed "the checkout is on a detached HEAD, not main" while every write
 * copy's reflog stayed on main. A passing git state is waited out, a detached HEAD that holds nothing goes back on main,
 * anything else is refused as before; and another world's page may ask after its own presses.
 */

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const SPINE = "# PLAN-1: t\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n";
let root: string;
let dir: string;
const g = () => runner(dir, { ...process.env, GIT_TERMINAL_PROMPT: "0" });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "e72s20-"));
  dir = makeRepo(root, "r", { "docs/spines/root.md": SPINE }, { cards: false }).dir;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("T72-S20 onMain", () => {
  it("on main: ready at once", async () => {
    expect(await onMain(g(), dir, [])).toEqual({ ok: true });
  });

  it("detached at a commit main has, clean tree: back on main, nothing lost", async () => {
    git(dir, "checkout", "-q", "--detach", "HEAD");
    expect(await onMain(g(), dir, [])).toEqual({ ok: true });
    expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("detached with a commit main lacks: refused and left exactly as it was", async () => {
    git(dir, "checkout", "-q", "--detach", "HEAD");
    fs.writeFileSync(path.join(dir, "x.md"), "someone's work\n");
    git(dir, "add", "x.md");
    git(dir, "commit", "-q", "-m", "work");
    const sha = git(dir, "rev-parse", "HEAD");
    const r = await onMain(g(), dir, []);
    expect(r).toMatchObject({ ok: false, transient: false });
    expect((r as { reason: string }).reason).toContain("with commits main lacks");
    expect(git(dir, "rev-parse", "HEAD")).toBe(sha);
  });

  it("another git mid-rebase: waited out; once it finishes the write goes on", async () => {
    git(dir, "checkout", "-q", "--detach", "HEAD");
    const marker = path.join(dir, ".git", "rebase-merge");
    fs.mkdirSync(marker);
    const r = await onMain(g(), dir, [0, 0]);
    expect(r).toMatchObject({ ok: false, transient: true });
    expect((r as { reason: string }).reason).toMatch(/a rebase.*tried 3 times/);
    // the rebase ends (back on main) during the pauses
    const pending = onMain(g(), dir, [300]);
    setTimeout(() => {
      fs.rmSync(marker, { recursive: true });
      git(dir, "checkout", "-q", "main");
    }, 50);
    expect(await pending).toEqual({ ok: true });
  });

  it("an index.lock held by someone else is waited out, never read as a detached HEAD", async () => {
    git(dir, "checkout", "-q", "--detach", "HEAD");
    fs.writeFileSync(path.join(dir, ".git", "index.lock"), "");
    const r = await onMain(g(), dir, [0]);
    expect(r).toMatchObject({ ok: false, transient: true });
    expect((r as { reason: string }).reason).toContain("index.lock");
  });

  it("git failing (a timeout on a loaded host) is transient, never 'a detached HEAD'", async () => {
    let calls = 0;
    const slow = async (args: string[]) => {
      if (args[0] === "symbolic-ref" && calls++ < 1) return { ok: false, out: "", err: "git symbolic-ref timed out after 30000 ms (killed with its children)", stderr: "git symbolic-ref timed out" };
      return g()(args);
    };
    expect(await onMain(slow, dir, [0])).toEqual({ ok: true });
    const always = async (args: string[]) =>
      args[0] === "symbolic-ref" ? { ok: false, out: "", err: "git symbolic-ref timed out after 30000 ms (killed with its children)", stderr: "git symbolic-ref timed out" } : g()(args);
    const r = await onMain(always, dir, [0]);
    expect(r).toMatchObject({ ok: false, transient: true });
    expect((r as { reason: string }).reason).not.toContain("detached");
  });
});

describe("T72-S20 the spine writer", () => {
  it("a write on a checkout left detached at main's commit lands, on main", async () => {
    git(dir, "checkout", "-q", "--detach", "HEAD");
    const w = createSpineWriter();
    const r = await w.edit({ repoDir: dir, path: "docs/spines/root.md", label: "t", edit: (t) => ({ text: `${t}x\n`, msg: "T72-S20 test", body: "b" }) });
    expect(r.status).toBe("written");
    expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(dir, "log", "-1", "--format=%s", "origin/main")).toBe("T72-S20 test");
  });

  it("a write meeting a rebase that does not end fails (retried later by its job), never skipped", async () => {
    git(dir, "checkout", "-q", "--detach", "HEAD");
    fs.mkdirSync(path.join(dir, ".git", "rebase-apply"));
    const w = createSpineWriter();
    const r = await w.edit({ repoDir: dir, path: "docs/spines/root.md", label: "t", edit: (t) => ({ text: `${t}x\n`, msg: "m", body: "b" }) });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("another git process");
  }, 20_000);
});

describe("T72-S20 a world asks after its own presses", () => {
  it("GET /api/presses/:id is reachable from another world (scoped to its own presses in press/mount.ts)", () => {
    expect(isTenantSafe("GET", "/api/presses/pr_1")).toBe(true);
    expect(isTenantSafe("GET", "/api/presses")).toBe(false);
  });
});

describe("T72-S20 GET /api/presses/:id per world", () => {
  it("a world reads its own press (the card follows it to landed) and never another world's", async () => {
    const { Hono } = await import("hono");
    const { openDb } = await import("../src/db.js");
    const { runWithAuth } = await import("../src/auth/identity.js");
    const { mountPresses } = await import("../src/press/mount.js");
    const { createPresses } = await import("../src/press/presses.js");
    const db = openDb(path.join(root, "console.db"));
    try {
      const presses = createPresses(db);
      const app = new Hono();
      const api = new Hono();
      // the request's login names its world (what the gate sets in production)
      app.use("*", (c, next) => {
        const tenant = c.req.header("x-test-world") ?? "home";
        return runWithAuth({ mode: "on", identity: { kind: "session", tenant, userId: "u", email: "j@x", name: "Sam", role: "owner" } }, next);
      });
      mountPresses(api, { db, presses, fetch: (r) => app.fetch(r), answerFirst: false, authMode: "on", log: () => undefined });
      api.post("/review-items/:id/complete", (c) => c.json({ item: { id: c.req.param("id"), state: "done" } }));
      app.route("/api", api);
      const r = await app.fetch(new Request("http://console.local/api/review-items/rv_s1/complete", { method: "POST", headers: { "content-type": "application/json", "x-test-world": "social" }, body: "{}" }));
      expect(r.status).toBeLessThan(300);
      const id = (presses.list({}) as { id: string }[])[0]!.id;
      const get = (world: string) => app.fetch(new Request(`http://console.local/api/presses/${id}`, { headers: { "x-test-world": world } }));
      const own = await get("social");
      expect(own.status).toBe(200);
      expect(((await own.json()) as { state: string }).state).toBe("landed");
      expect((await get("e77-test")).status).toBe(404);
      expect((await get("home")).status).toBe(200);
    } finally {
      db.close();
    }
  });
});
