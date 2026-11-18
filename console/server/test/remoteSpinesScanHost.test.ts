import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SpinesJson } from "../src/adapters/spines.js";
import { originUrl, remoteSpinesRunner } from "../src/indexer/remoteSpines.js";

/**
 * the indexer's spines.py scans run on a scan host; this host only reads its answer, and scans here itself
 * whenever the scan host cannot answer for exactly this checkout.
 */
const out = (path: string): SpinesJson => ({ root: path, nodes: [], orphans: [], mismatches: [] });
const SHA = "a".repeat(40);
const base = { url: "http://scan.test/", head: () => SHA, origin: () => "https://github.com/o/r.git", dirty: async () => false };

function fakeFetch(answer: { status: number; body: string } | Error) {
  const calls: { url: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("remoteSpinesRunner ", () => {
  it("asks the scan host for the checkout's commit and uses its answer; nothing runs here", async () => {
    let local = 0;
    const { f, calls } = fakeFetch({ status: 200, body: JSON.stringify(out("docs/spines/root.md")) });
    const run = remoteSpinesRunner({ ...base, fetch: f, local: async () => (local++, out("local")) });
    const r = await run("/repos/world-repo");
    expect(r.root).toBe("docs/spines/root.md");
    expect(local).toBe(0);
    expect(calls[0].url).toBe("http://scan.test/scan");
    expect(calls[0].body).toEqual({ repo: "world-repo", sha: SHA, origin: "https://github.com/o/r.git" });
    expect(run.stats()).toMatchObject({ remote: 1, local: 0 });
  });

  it("an unchanged answer is the same object (trees memoized on it stay valid)", async () => {
    const { f } = fakeFetch({ status: 200, body: JSON.stringify(out("x")) });
    const run = remoteSpinesRunner({ ...base, fetch: f, local: async () => out("local") });
    expect(await run("/r/a")).toBe(await run("/r/a"));
  });

  it.each([
    ["the scan host does not know the commit", { status: 404, body: "commit not on origin" }],
    ["the scan host is down", new Error("connect ECONNREFUSED")],
    ["the answer is not spines.py's shape", { status: 200, body: "{}" }],
  ])("falls back to a local scan when %s", async (_why, answer) => {
    const { f } = fakeFetch(answer as { status: number; body: string } | Error);
    const run = remoteSpinesRunner({ ...base, fetch: f, local: async () => out("local") });
    expect((await run("/r/a")).root).toBe("local");
    expect(run.stats().local).toBe(1);
    expect(run.stats().why[0]).toMatch(/^a: /);
  });

  it("a checkout with a tracked change, or no commit, is scanned here without asking", async () => {
    const { f, calls } = fakeFetch({ status: 200, body: JSON.stringify(out("remote")) });
    const dirty = remoteSpinesRunner({ ...base, dirty: async () => true, fetch: f, local: async () => out("local") });
    expect((await dirty("/r/a")).root).toBe("local");
    const noHead = remoteSpinesRunner({ ...base, head: () => undefined, fetch: f, local: async () => out("local") });
    expect((await noHead("/r/a")).root).toBe("local");
    expect(calls.length).toBe(0);
  });

  it("reads origin from the config file and never sends a credential in it", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "e6s163-"));
    fs.mkdirSync(path.join(d, ".git"));
    fs.writeFileSync(path.join(d, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://${["user", "pass"].join(":")}${"@"}github.com/o/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    expect(originUrl(d)).toBe("https://github.com/o/r.git");
    fs.rmSync(d, { recursive: true, force: true });
  });
});
