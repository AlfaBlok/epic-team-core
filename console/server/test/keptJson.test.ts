// GET /api/scorecards is kept ready in the background; a request never builds it (the sidebar never waits).
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { keptJson, sendPrepared } from "../src/keptJson.js";
import { leanJson } from "../src/leanJson.js";

function setup(o: { sig?: () => string } = {}) {
  let t = 1_000_000;
  let builds = 0;
  let fail = false;
  let gate: Promise<void> | undefined;
  const kept = keptJson({
    build: async () => {
      if (gate) await gate;
      if (fail) throw new Error("boom");
      builds++;
      return { n: builds, rows: Array.from({ length: 200 }, (_, i) => `row ${i}`) };
    },
    checkMs: 15_000,
    minGapMs: 60_000,
    everyMs: 180_000,
    signature: o.sig,
    now: () => t,
    timer: false,
  });
  return {
    kept,
    builds: () => builds,
    advance: (ms: number) => (t += ms),
    failNext: (v: boolean) => (fail = v),
    hold: () => {
      let open!: () => void;
      gate = new Promise((r) => (open = r));
      return () => ((gate = undefined), open());
    },
  };
}
const body = (p: { json: Buffer }) => JSON.parse(p.json.toString()) as { n: number };

describe("keptJson", () => {
  it("builds once on the first ask, then answers from the kept copy with no build", async () => {
    const s = setup();
    expect(body(await s.kept.get()).n).toBe(1);
    for (let i = 0; i < 20; i++) await s.kept.get();
    expect(s.builds()).toBe(1);
  });

  it("answers the old copy at once while a rebuild runs (never waits on a build)", async () => {
    const s = setup();
    await s.kept.get();
    const open = s.hold();
    s.advance(200_000);
    const turn = s.kept.tick();
    const got = await Promise.race([s.kept.get(), new Promise((r) => setTimeout(() => r("waited"), 50))]);
    expect(got).not.toBe("waited");
    expect(body(got as { json: Buffer }).n).toBe(1);
    open();
    await turn;
    expect(body(await s.kept.get()).n).toBe(2);
  });

  it("rebuilds every everyMs whatever changed, not before", async () => {
    const s = setup();
    await s.kept.get();
    s.advance(170_000);
    await s.kept.tick();
    expect(s.builds()).toBe(1);
    s.advance(10_000);
    await s.kept.tick();
    expect(s.builds()).toBe(2);
  });

  it("rebuilds when an input changed, at most once a minGap", async () => {
    let sig = "a";
    const s = setup({ sig: () => sig });
    await s.kept.get();
    sig = "b";
    s.advance(30_000);
    await s.kept.tick();
    expect(s.builds()).toBe(1); // too soon
    s.advance(30_000);
    await s.kept.tick();
    expect(s.builds()).toBe(2);
    s.advance(60_000);
    await s.kept.tick();
    expect(s.builds()).toBe(2); // nothing changed since
  });

  it("keeps the last answer when a build fails", async () => {
    const s = setup();
    await s.kept.get();
    s.failNext(true);
    expect(await s.kept.refresh()).toBeUndefined();
    expect(body(await s.kept.get()).n).toBe(1);
  });

  it("a refresh asked during a build builds once more after it (a write mid-build shows)", async () => {
    const s = setup();
    await s.kept.get();
    const open = s.hold();
    const a = s.kept.refresh();
    const b = s.kept.refresh();
    open();
    await a;
    expect(body((await b)!).n).toBe(3);
  });

  it("the route sends the kept bytes gzipped with an ETag, 304 when unchanged, and leanJson leaves it", async () => {
    const s = setup();
    const app = new Hono();
    app.use("*", leanJson());
    app.get("/scorecards", async (c) => sendPrepared(c, await s.kept.get()));
    const r1 = await app.request("/scorecards", { headers: { "Accept-Encoding": "gzip" } });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("Content-Encoding")).toBe("gzip");
    expect(r1.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(gunzipSync(Buffer.from(await r1.arrayBuffer())).toString()).n).toBe(1);
    const etag = r1.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"/);
    const r2 = await app.request("/scorecards", { headers: { "If-None-Match": etag } });
    expect(r2.status).toBe(304);
    const r3 = await app.request("/scorecards");
    expect(r3.headers.get("Content-Encoding")).toBeNull();
    expect((await r3.json()).n).toBe(1);
    expect(s.builds()).toBe(1);
  });
});
