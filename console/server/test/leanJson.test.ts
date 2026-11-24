// JSON answers go out with an ETag (304 when unchanged) and gzipped; streams and other answers pass untouched.
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { describe, expect, it } from "vitest";
import { acceptsBrotli, etagMatches, leanJson } from "../src/leanJson.js";

const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, title: `row ${i} of the sidebar list` })) };
function app() {
  const a = new Hono();
  a.use("*", leanJson());
  a.get("/big", (c) => c.json(big));
  a.get("/small", (c) => c.json({ ok: true }));
  a.get("/own-cache", (c) => { c.header("Cache-Control", "no-store"); return c.json(big); });
  a.get("/stream", (c) => c.body("data: hi\n\n", 200, { "Content-Type": "text/event-stream" }));
  a.get("/missing", (c) => c.json({ error: "no" }, 404));
  a.post("/big", (c) => c.json(big));
  return a;
}

describe("leanJson", () => {
  it("gzips a large JSON answer for a caller that accepts it, with an ETag and no-cache", async () => {
    const res = await app().request("/big", { headers: { "Accept-Encoding": "gzip, deflate" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("ETag")).toMatch(/^W\/"/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("Vary")).toMatch(/Accept-Encoding/);
    const raw = Buffer.from(await res.arrayBuffer());
    expect(raw.length).toBeLessThan(JSON.stringify(big).length / 3);
    expect(JSON.parse(gunzipSync(raw).toString())).toEqual(big);
  });

  // every https browser takes brotli; the inbox lists come out smaller than gzip
  it("sends brotli to a browser that takes it, smaller than gzip, same ETag", async () => {
    const a = app();
    const br = await a.request("/big", { headers: { "Accept-Encoding": "gzip, deflate, br, zstd" } });
    const gz = await a.request("/big", { headers: { "Accept-Encoding": "gzip" } });
    expect(br.headers.get("Content-Encoding")).toBe("br");
    expect(br.headers.get("ETag")).toBe(gz.headers.get("ETag"));
    const raw = Buffer.from(await br.arrayBuffer());
    expect(raw.length).toBeLessThan(Buffer.from(await gz.arrayBuffer()).length);
    expect(JSON.parse(brotliDecompressSync(raw).toString())).toEqual(big);
  });

  it("reads br in Accept-Encoding only when it is offered", () => {
    expect(acceptsBrotli("gzip, deflate, br")).toBe(true);
    expect(acceptsBrotli("br;q=0.9, gzip")).toBe(true);
    expect(acceptsBrotli("gzip, br;q=0")).toBe(false);
    expect(acceptsBrotli("gzip, brotli")).toBe(false);
    expect(acceptsBrotli(undefined)).toBe(false);
  });

  it("answers 304 with no body when the list did not change", async () => {
    const a = app();
    const first = await a.request("/big");
    const etag = first.headers.get("ETag")!;
    const again = await a.request("/big", { headers: { "If-None-Match": etag, "Accept-Encoding": "gzip" } });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    const changed = await a.request("/big", { headers: { "If-None-Match": 'W/"other"' } });
    expect(changed.status).toBe(200);
  });

  it("a caller with no cache and no gzip gets the plain answer as before", async () => {
    const res = await app().request("/big");
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(await res.json()).toEqual(big);
  });

  it("leaves small answers unzipped, keeps a route's own Cache-Control, and skips streams, errors and writes", async () => {
    const a = app();
    const small = await a.request("/small", { headers: { "Accept-Encoding": "gzip" } });
    expect(small.headers.get("Content-Encoding")).toBeNull();
    expect(await small.json()).toEqual({ ok: true });
    expect((await a.request("/own-cache")).headers.get("Cache-Control")).toBe("no-store");
    const stream = await a.request("/stream", { headers: { "Accept-Encoding": "gzip" } });
    expect(stream.headers.get("ETag")).toBeNull();
    expect(await stream.text()).toBe("data: hi\n\n");
    expect((await a.request("/missing")).headers.get("ETag")).toBeNull();
    expect((await a.request("/big", { method: "POST", headers: { "Accept-Encoding": "gzip" } })).headers.get("Content-Encoding")).toBeNull();
  });

  it("inside the Inbox lists' own compress layer (app.ts order): one gzip, an ETag, and a 304 when unchanged", async () => {
    const a = new Hono();
    a.get("/list", compress());
    a.use("*", leanJson());
    a.get("/list", (c) => c.json(big));
    const res = await a.request("/list", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    const etag = res.headers.get("ETag")!;
    expect(etag).toMatch(/^W\//);
    expect(JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString())).toEqual(big);
    const again = await a.request("/list", { headers: { "Accept-Encoding": "gzip", "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("matches If-None-Match lists, weak or strong", () => {
    expect(etagMatches('"a", W/"b"', 'W/"b"')).toBe(true);
    expect(etagMatches('"b"', 'W/"b"')).toBe(true);
    expect(etagMatches("*", 'W/"b"')).toBe(true);
    expect(etagMatches('W/"c"', 'W/"b"')).toBe(false);
    expect(etagMatches(undefined, 'W/"b"')).toBe(false);
  });
});
