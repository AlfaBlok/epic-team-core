import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createSpineWriter, timeWrites } from "../src/inbox/spineWrite.js";
import type { PressWorker } from "../src/press/mount.js";
import { makeRepo, spineText } from "./reviewFixture.js";

/**
 * every press on production logged "(no steps)" for the review buttons after 6edde61 shipped (Snooze on an ask
 * named its steps). Two causes together: the review route's tally sat inside the press worker's, so a step counted only
 * in the inner one, and the route's Server-Timing header never came back: production serves through @hono/node-server,
 * whose response drops a header set on it after it was made once the world filter (auth on) rebuilds it. Now a step
 * counts in every open tally and the worker reads its own first.
 */
const cadence = { type: "interval" as const, everyMinutes: 60 };
const SPINE = "docs/spines/root.md";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

describe("T72-S13 every press names its steps", () => {
  it("a write inside nested tallies counts in each of them (lock, fetch, commit, push, the whole write)", async () => {
    const dir = tmp("console-e72s13-nest-");
    const repo = makeRepo(dir, "home_repo", { "docs/x.md": "a\n" }, { cards: false });
    const writer = createSpineWriter();
    const { steps: outer, out } = await timeWrites(async () => {
      const { steps: inner, out: w } = await timeWrites(() =>
        writer.edit({ repoDir: repo.dir, path: "docs/x.md", label: "x", edit: (t) => ({ text: `${t}b\n`, msg: "T72-S13 test", body: "" }) }),
      );
      return { inner, w };
    });
    expect(out.w.status).toBe("written");
    for (const s of [out.inner, outer]) expect(Object.keys(s)).toEqual(expect.arrayContaining(["lock", "fetch", "commit", "push", "write"]));
    expect(outer).toEqual(out.inner);
  });

  describe("on production's response (@hono/node-server) with auth on", () => {
    const keep = globalThis.Request;
    const keepRes = globalThis.Response;
    beforeAll(() => {
      // node-server swaps both globals when it serves; keep the platform Request so app.request works in the test
      getRequestListener(() => new Response(""));
      Object.defineProperty(globalThis, "Request", { value: keep, configurable: true, writable: true });
    });
    afterAll(() => {
      Object.defineProperty(globalThis, "Response", { value: keepRes, configurable: true, writable: true });
    });

    it("a review press's try keeps its steps although the route's Server-Timing header is lost", async () => {
      expect(globalThis.Response).not.toBe(keepRes);
      const dir = tmp("console-e72s13-");
      const writeRoot = tmp("console-e72s13-write-");
      const db: DB = openDb(path.join(dir, "console.db"));
      cleanup.push(() => db.close());
      makeRepo(dir, "home_repo", {
        [SPINE]: spineText("PLAN-0", "home_repo", [{ id: "T74-S1", title: "TEST card", status: "review", evidence: "[page](https://team.example/audit)" }]),
      });
      const logs: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
      cleanup.push(() => (console.warn = warn));
      let worker: PressWorker | undefined;
      const app = createApp(db, {
        read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
        review: { live: { fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch, consoleHosts: [] } },
        presses: { retryMs: [0], onWorker: (w) => (worker = w), answerFirst: true },
        writeClones: { root: writeRoot },
        auth: "on",
      });
      const s = createStore(db);
      const m = s.createMilestone({ title: "home_repo", repo: "home_repo", path: SPINE, owner: "Sam", paused: false });
      const p = s.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
      s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence, enabled: true });
      const req = async (method: string, url: string) => {
        const res = await app.request(url, { method }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
        return { status: res.status, json: JSON.parse((await res.text()) || "null"), pressId: res.headers.get("x-press-id") };
      };
      await req("GET", "/api/review-items");
      await new Promise((r) => setTimeout(r, 30));
      const [card] = (await req("GET", "/api/review-items")).json as { id: string }[];
      const r = await req("POST", `/api/review-items/${encodeURIComponent(card.id)}/complete`);
      expect(r.status).toBe(202);
      const id = r.pressId ?? r.json.press.id;
      let press: any;
      for (let i = 0; i < 400; i++) {
        press = (await req("GET", `/api/presses/${id}`)).json;
        if (press.state !== "landing") break;
        if (i % 10 === 9) await worker!.tick();
        await new Promise((res) => setTimeout(res, 25));
      }
      expect(press.state).toBe("landed");
      const wrote = [...press.tries].reverse().find((t: { steps?: Record<string, number> }) => t.steps);
      expect(wrote, JSON.stringify(press.tries)).toBeTruthy();
      expect(Object.keys(wrote.steps)).toEqual(expect.arrayContaining(["lock", "fetch", "commit", "push", "write"]));
      const line = logs.find((l) => l.startsWith(`press ${id} `));
      expect(line).toMatch(/landed in \d+ ms \(lock \d+, .*fetch \d+, (scan \d+, )?commit \d+, push \d+, .*write \d+\)/);
    });
  });
});
