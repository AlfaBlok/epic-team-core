import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createAuth } from "../src/auth/identity.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { ATTACH_HEAD, ATTACH_MAX_BYTES, attachType, bytesMatch, createAttachments, safeName } from "../src/desk/attachments.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";

/**
 * screenshots and files in Chat. The page uploads each file (POST /api/chat/attachments), then sends the message
 * with their ids; the console adds one `📎 Attachments` block with a link per file, so the desk downloads and opens them.
 * Files are served only within their world.
 */
const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://127.0.0.1:18799";
const Z = "social";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PROJECTS = [{ id: "p_home_repo", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: { displayName: "acme/home_repo" } }];

class FakeT3 implements T3Client {
  sent: string[] = [];
  threads = new Map<string, T3ThreadMessage[]>();
  private pos = 0;
  async listProjects() {
    return PROJECTS;
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { message?: string }) {
    const id = `t_${this.threads.size + 1}`;
    this.threads.set(id, []);
    if (input.message) this.threads.get(id)!.push({ itemId: `i${++this.pos}`, position: this.pos, role: "user", text: input.message, status: "completed", truncated: false });
    return { threadId: id };
  }
  async sendToThread(threadId: string, message: string) {
    this.sent.push(message);
    this.threads.get(threadId)?.push({ itemId: `i${++this.pos}`, position: this.pos, role: "user", text: message, status: "completed", truncated: false });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string): Promise<T3MessagePage> {
    const m = this.threads.get(threadId) ?? [];
    return { messages: m, nextPosition: m.at(-1)?.position ?? null, hasMore: false, archived: false };
  }
}
class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat2", providerInstanceId: "claudeAgent_seat2" };
  }
  async done() {}
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(auth: "off" | "on" = "off") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s11-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const t3 = new FakeT3();
  const filesDir = path.join(dir, "chat-attachments");
  const app = createApp(db, { auth, chatAttachmentsDir: filesDir, cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: BASE, runState: async () => undefined } });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
  const upload = (bytes: Uint8Array, type: string, name: string, headers: Record<string, string> = PAGE) =>
    app.request("/api/chat/attachments", { method: "POST", headers: { "content-type": type, "x-filename": encodeURIComponent(name), ...headers }, body: bytes as Uint8Array<ArrayBuffer> }, local);
  const send = (body: unknown) => app.request("/api/desk/messages", { method: "POST", headers: { "content-type": "application/json", ...PAGE }, body: JSON.stringify(body) }, local);
  return { db, t3, app, upload, send, filesDir, local };
}

describe("T18-S11 what Chat takes", () => {
  it("images, recordings and common documents; never an executable, SVG or a renamed binary", () => {
    expect(attachType("image/png", "a.png")).toBe("image/png");
    expect(attachType("image/jpg", "a.jpg")).toBe("image/jpeg");
    expect(attachType("", "Screenshot 2026.PNG")).toBe("image/png");
    expect(attachType("application/octet-stream", "notes.pdf")).toBe("application/pdf");
    expect(attachType("image/svg+xml", "x.svg")).toBeUndefined();
    expect(attachType("application/x-msdownload", "setup.exe")).toBeUndefined();
    expect(attachType("application/octet-stream", "run.sh")).toBeUndefined();
    expect(attachType("text/html", "page.html")).toBeUndefined();
    expect(bytesMatch("image/png", PNG)).toBe(true);
    expect(bytesMatch("image/png", new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBe(false); // MZ: a Windows program named.png
    expect(bytesMatch("text/plain", new TextEncoder().encode("#!/bin/sh\nrm -rf /"))).toBe(false);
    expect(bytesMatch("text/plain", new TextEncoder().encode("hello"))).toBe(true);
    expect(safeName("../../etc/passwd my shot (1).png", "png")).toBe("passwd-my-shot-1.png");
    expect(safeName("", "jpg")).toBe("file.jpg");
  });
});

describe("T18-S11 upload, send, serve", () => {
  it("uploads a screenshot, sends it with the message as a link the desk opens, and serves it back", async () => {
    const s = setup();
    const up = await s.upload(PNG, "image/png", "IMG_0042.PNG");
    expect(up.status).toBe(201);
    const { attachment } = (await up.json()) as any;
    expect(attachment).toMatchObject({ name: "IMG_0042.png", mime: "image/png", bytes: PNG.byteLength });
    expect(attachment.path).toBe(`/api/chat/attachments/${attachment.id}/IMG_0042.png`);

    const r = await s.send({ text: "look at this", attachments: [attachment.id] });
    expect(r.status).toBeLessThan(300);
    const msg = s.t3.sent.at(-1)!;
    expect(msg).toContain("look at this");
    expect(msg).toContain(`${ATTACH_HEAD} (1)`);
    expect(msg).toContain(`- IMG_0042.png · image/png · 1 KB · ${BASE}${attachment.path}`);
    expect(msg).toContain("-H 'X-Console-Run: team-desk'"); // the Team desk downloads it with its own headers

    const got = await s.app.request(attachment.path, {}, s.local);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  });

  it("a message may be files alone", async () => {
    const s = setup();
    const { attachment } = (await (await s.upload(PNG, "image/png", "a.png")).json()) as any;
    expect((await s.send({ text: "", attachments: [attachment.id] })).status).toBeLessThan(300);
    expect(s.t3.sent.at(-1)!.startsWith(`${ATTACH_HEAD} (1)`)).toBe(true);
  });

  it("refuses a too big file, a refused type, a disguised executable, an unknown id and a persona's upload", async () => {
    const s = setup();
    expect((await s.upload(new Uint8Array(ATTACH_MAX_BYTES + 1).fill(0x41), "text/plain", "big.txt")).status).toBe(413);
    expect((await s.upload(new TextEncoder().encode("<svg onload=alert(1)>"), "image/svg+xml", "x.svg")).status).toBe(415);
    expect((await s.upload(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]), "image/png", "x.png")).status).toBe(415);
    expect((await s.send({ text: "hi", attachments: ["att_nope"] })).status).toBe(404);
    expect((await s.upload(PNG, "image/png", "a.png", { "X-Console-Run": "team-desk" })).status).toBe(403);
    expect(fs.existsSync(s.filesDir) ? fs.readdirSync(path.join(s.filesDir, "home")).length : 0).toBe(0);
  });

  it("serves a file only in its own world (another world's id is a 404, both ways)", async () => {
    const s = setup("on");
    const auth = createAuth(s.db);
    s.db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'internal', ?)").run(Z, Z, new Date().toISOString());
    const zTok = auth.createToken({ tenant: Z, label: "social check" }).token;
    const aTok = auth.createToken({ tenant: "home", label: "checks" }).token;
    const outside = { incoming: { socket: { remoteAddress: "203.0.113.7" } } };
    const get = (p: string, tok: string) => s.app.request(p, { headers: { authorization: `Bearer ${tok}` } }, outside);
    const a = createAttachments({ db: s.db, dir: s.filesDir, world: () => "home", publicUrl: BASE }).add(PNG, "image/png", "alpha.png");
    const z = createAttachments({ db: s.db, dir: s.filesDir, world: () => Z, publicUrl: BASE }).add(PNG, "image/png", "zed.png");
    expect((await get(a.path, aTok)).status).toBe(200);
    expect((await get(z.path, zTok)).status).toBe(200);
    expect((await get(a.path, zTok)).status).toBe(404);
    expect((await get(z.path, aTok)).status).toBe(404);
    expect((await s.app.request(a.path, {}, outside)).status).toBe(401); // nobody signed in
    expect(isTenantSafe("GET", a.path)).toBe(true);
    expect(isTenantSafe("POST", "/api/chat/attachments")).toBe(true);
  });
});
