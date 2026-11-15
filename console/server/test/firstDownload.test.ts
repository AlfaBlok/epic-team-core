import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";

// the first download: a fresh open loads only what the first screen needs
let dir: string;
let db: DB;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-download-"));
  db = openDb(":memory:");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function dist() {
  const d = path.join(dir, "dist");
  fs.mkdirSync(path.join(d, "assets"), { recursive: true });
  const html = `<!doctype html><script src="/assets/index-abc.js"></script>${"<!-- pad -->".repeat(200)}`;
  fs.writeFileSync(path.join(d, "index.html"), html);
  // a brotli copy of the page too: never served, the page is rewritten here (identity) and must not be
  fs.writeFileSync(path.join(d, "index.html.br"), zlib.brotliCompressSync(Buffer.from(html)));
  const js = "console.log('app');\n".repeat(5000);
  fs.writeFileSync(path.join(d, "assets", "index-abc.js"), js);
  fs.writeFileSync(path.join(d, "assets", "index-abc.js.br"), zlib.brotliCompressSync(Buffer.from(js)));
  fs.writeFileSync(path.join(d, "assets", "Chat-x.js"), "export const a = 1;\n".repeat(200)); // no .br: gzip as before
  return { d, js };
}

describe("the first download", () => {
  it("serves the build's brotli copy of a hashed script to a browser that takes br, gzip to one that does not", async () => {
    const { d, js } = dist();
    const app = createApp(db, { staticDir: d });
    const br = await app.request("/assets/index-abc.js", { headers: { "Accept-Encoding": "gzip, deflate, br, zstd" } });
    expect(br.status).toBe(200);
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(zlib.brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(js);
    const gz = await app.request("/assets/index-abc.js", { headers: { "Accept-Encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(js);
    const plain = await app.request("/assets/index-abc.js");
    expect(plain.headers.get("content-encoding")).toBeNull();
    // a screen's script with no brotli copy still goes out gzipped
    const chat = await app.request("/assets/Chat-x.js", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(chat.headers.get("content-encoding")).toBe("gzip");
  });

  it("never sends the app page as brotli (it is rewritten here) and keeps its revalidation", async () => {
    const { d } = dist();
    const app = createApp(db, { staticDir: d });
    const page = await app.request("/", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(page.headers.get("content-encoding")).toBe("gzip");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(zlib.gunzipSync(Buffer.from(await page.arrayBuffer())).toString()).toContain("__IDENTITY__");
  });

  it("answers 404 for a hashed script that is gone (an older build's screen), never the app page", async () => {
    const { d } = dist();
    const app = createApp(db, { staticDir: d });
    const gone = await app.request("/assets/Milestone-old123.js");
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toBe("no-store");
    expect(await gone.text()).not.toContain("<script");
    // any other address still opens the app (the router shows the screen)
    const screen = await app.request("/milestones/ms_1");
    expect(screen.status).toBe(200);
    expect(await screen.text()).toContain("/assets/index-abc.js");
  });
});
