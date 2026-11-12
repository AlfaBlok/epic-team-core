import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createAuth } from "../src/auth/identity.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { cardFilesLine, createAttachments } from "../src/desk/attachments.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";

/**
 * a box whose own route takes only words
 * (Send to, Steer, Run now, a post's or an idea's feedback) asks POST /api/chat/attachments/line for the line of links of
 * the files he added and puts it after his words: the owner's own page only, files of the request's world only.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s12-"));
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

describe("T18-S12 the links line of uploaded files", () => {
  it("gives the card line for his files, refuses a caller that is not his page, an empty list and another world's file", async () => {
    const s = setup();
    const { attachment } = (await (await s.upload(PNG, "image/png", "shot.png")).json()) as any;
    const line = (body: unknown, headers: Record<string, string> = PAGE) =>
      s.app.request("/api/chat/attachments/line", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, s.local);
    const ok = await line({ ids: [attachment.id] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).line).toBe(cardFilesLine([`${BASE}${attachment.path}`]));
    expect((await line({ ids: [attachment.id] }, {})).status).toBe(403); // not from his page
    expect((await line({ ids: [] })).status).toBe(400);
    expect((await line({ ids: ["att_000000000000"] })).status).toBe(404);
    const z = createAttachments({ db: s.db, dir: s.filesDir, world: () => "social", publicUrl: BASE }).add(PNG, "image/png", "zed.png");
    expect((await line({ ids: [z.id] })).status).toBe(404);
    expect(isTenantSafe("POST", "/api/chat/attachments/line")).toBe(true);
  });
});
