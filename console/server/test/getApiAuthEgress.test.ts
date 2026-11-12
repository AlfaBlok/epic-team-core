import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { createAuth } from "../src/auth/identity.js";

/**
 * Post now shows only while the posts really go out at once. a social world repo's own Team Browser has no egress map; its
 * posts go out on the home world's (browser/worlds.ts wakeBrowserUrls), through the owner's Mac. GET /api/auth/egress?posting=1 reads
 * every instance the world posts through, its own first; without it, only its own (the Sign-ins page, as before).
 */
const A = "home";
const B = "social";
function fakeBrowser(egresses: Record<string, unknown>) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/health" ? { egress: { egresses } } : {}));
  });
  return { server, url: "" };
}
const browsers = { [A]: fakeBrowser({ laptop: { state: "offline", lastSeen: "2026-11-04T01:28:36Z" } }), [B]: fakeBrowser({}) };
beforeAll(async () => {
  for (const b of Object.values(browsers)) {
    await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", r));
    b.url = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  }
});
afterAll(() => Object.values(browsers).forEach((b) => b.server.close()));

describe("T61-S3 GET /api/auth/egress?posting=1", () => {
  it("social's posting path is home's laptop (offline here); its own list stays empty; home reads its own", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e61s3-"));
    const db = openDb(path.join(dir, "console.db"));
    try {
      db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(B, B, new Date().toISOString());
      const app = createApp(db, { auth: "on", browser: { browserUrl: browsers[A].url, worldUrls: { [B]: browsers[B].url } } });
      const auth = createAuth(db);
      const as = async (tenant: string, q = "") => {
        const id = auth.addMember({ email: `sam+${tenant}${q.length}@example.com`, tenant, role: "owner" });
        const res = await app.request(`/api/auth/egress${q}`, { headers: { cookie: `console_session=${auth.createSession(id, tenant).id}` } });
        return (await res.json()) as any;
      };
      expect((await as(B)).egresses).toEqual([]);
      expect((await as(B, "?posting=1")).egresses).toEqual([{ name: "laptop", state: "offline", lastSeen: "2026-11-04T01:28:36Z" }]);
      expect((await as(A, "?posting=1")).egresses.map((e: any) => [e.name, e.state])).toEqual([["laptop", "offline"]]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
