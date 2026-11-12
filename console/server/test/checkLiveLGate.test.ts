import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { checkLive, type LiveCheckDeps } from "../src/review/review.js";

/**
 * the live check of "done, waiting for your review" (L-34): a card is in review only once its URL answers where
 * the owner opens it; a console URL naming a commit also needs a deployed release that contains it. (The list, Approve and
 * Relaunch are spine rows since: rowsTs.test.ts.)
 */
let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s1-"));
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake web: url → status (missing = no answer). Records what was fetched. */
const web = (answers: Record<string, number>) => {
  const seen: string[] = [];
  const f = (async (u: string) => {
    seen.push(String(u));
    const s = answers[String(u)];
    if (s === undefined) throw new Error("ECONNREFUSED");
    return new Response("ok", { status: s });
  }) as unknown as typeof fetch;
  return { f, seen };
};

describe("T48-S1 checkLive (L-34 gate)", () => {
  it("2xx/3xx answers; 4xx/5xx or no answer does not", async () => {
    const { f } = web({ "https://epicspine.dev/": 200, "https://x.dev/gone": 404 });
    expect((await checkLive("https://epicspine.dev/", undefined, { fetch: f })).ok).toBe(true);
    expect(await checkLive("https://x.dev/gone", undefined, { fetch: f })).toMatchObject({ ok: false, status: 404 });
    expect(await checkLive("https://nowhere.dev/", undefined, { fetch: f })).toMatchObject({ ok: false, status: 0 });
  });

  it("the console's own public names are checked on loopback (no shadow agent line)", async () => {
    const { f, seen } = web({ "http://127.0.0.1:8750/book": 200 });
    const r = await checkLive("https://team.example.com/book", undefined, { fetch: f, localOrigin: "http://127.0.0.1:8750", consoleHosts: ["team.example.com"] });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["http://127.0.0.1:8750/book"]);
  });

  it("merged but not deployed stays pending: the live release must contain the commit", async () => {
    const { f } = web({ "http://127.0.0.1:8750/book": 200 });
    const d = (rev: string | undefined, contains: boolean): LiveCheckDeps => ({
      fetch: f,
      localOrigin: "http://127.0.0.1:8750",
      consoleHosts: ["team.example.com"],
      revision: () => rev,
      contains: async () => contains,
    });
    expect((await checkLive("https://team.example.com/book", "abc1234", d("f8e0f60aaaa", false))).error).toMatch(/merged but not deployed/);
    expect((await checkLive("https://team.example.com/book", "abc1234", d(undefined, true))).ok).toBe(false);
    expect((await checkLive("https://team.example.com/book", "abc1234", d("f8e0f60aaaa", true))).ok).toBe(true);
    expect((await checkLive("https://team.example.com/book", "f8e0f60", d("f8e0f60aaaa", false))).ok).toBe(true);
  });
});

describe("T48-S1 liveCheckDepsFromEnv", () => {
  it("checks the console's own names on the address it listens on (host1: the tailnet IP)", async () => {
    const { liveCheckDepsFromEnv } = await import("../src/review/review.js");
    expect(liveCheckDepsFromEnv({ port: 8750, host: "10.104.206.10" }).localOrigin).toBe("http://10.104.206.10:8750");
    expect(liveCheckDepsFromEnv({ port: 8750 }).localOrigin).toBe("http://127.0.0.1:8750");
  });
});
