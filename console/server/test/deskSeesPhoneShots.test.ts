import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { AGENT_IMAGE_MAX_EDGE, agentImage, createAttachments, imageSize } from "../src/desk/attachments.js";

/**
 * the owner's phone screenshots (JPEG 716x1600 carrying the phone's sRGB colour profile) reached the desk intact,
 * but the model refused every one. The console now redraws each picture as a plain PNG (no profile, no metadata, longest
 * side at most 1568) and the message links that `read:` copy beside the original; a picture it cannot redraw gets
 * `read: none` and the desk is told to say plainly it could not see it, never to guess.
 */
const BASE = "http://127.0.0.1:18799";
const PHONE = new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "phone-716x1600.jpg")));
const pngSize = (b: Uint8Array) => imageSize(b)!;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e18s24-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const filesDir = path.join(dir, "chat-attachments");
  const app = createApp(db, { auth: "off", chatAttachmentsDir: filesDir });
  const atts = createAttachments({ db, dir: filesDir, world: () => "home", publicUrl: BASE });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, atts, local: { incoming: { socket: { remoteAddress: "127.0.0.1" } } } };
}

describe("the desk sees phone screenshots", () => {
  it("reads the size of a 716x1600 phone JPEG and redraws it as a plain PNG at the model's size", () => {
    expect(imageSize(PHONE)).toEqual({ w: 716, h: 1600 });
    const png = agentImage(PHONE, "image/jpeg")!;
    expect(png).toBeDefined();
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(pngSize(png)).toEqual({ w: 702, h: 1568 });
    // no colour profile chunk in the copy (the profile is what the model refused)
    expect(png.includes(Buffer.from("iCCP"))).toBe(false);
  });

  it("scales a large picture down to the model's longest side", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="3000"><rect width="1000" height="3000" fill="#c33"/></svg>`;
    const big = new Resvg(svg).render().asPng();
    expect(pngSize(big)).toEqual({ w: 1000, h: 3000 });
    const s = pngSize(agentImage(big, "image/png")!);
    expect(s.h).toBe(AGENT_IMAGE_MAX_EDGE);
    expect(Math.abs(s.w - Math.round((1000 * AGENT_IMAGE_MAX_EDGE) / 3000))).toBeLessThanOrEqual(1);
  });

  it("gives nothing for a picture it cannot decode (HEIC, a broken file)", () => {
    expect(agentImage(PHONE, "image/heic")).toBeUndefined();
    const broken = new Uint8Array(PHONE.subarray(0, 400));
    expect(agentImage(broken, "image/jpeg")).toBeUndefined();
  });

  it("the desk message links the read copy beside the original and says to admit a picture it cannot see", async () => {
    const s = setup();
    const a = s.atts.add(PHONE, "image/jpeg", "Screenshot_2026-11-15-11-39-11.jpg");
    const msg = s.atts.compose("Diagnose image sending error", [a.id], "-H 'X-Console-Run: team-desk'");
    const readUrl = `${BASE}/api/chat/attachments/${a.id}/agent/Screenshot_2026-11-15-11-39-11.png`;
    expect(msg).toContain(`- Screenshot_2026-11-15-11-39-11.jpg · image/jpeg · 23 KB · ${BASE}${a.path}`);
    expect(msg).toContain(`  read: ${readUrl}`);
    expect(msg).toContain(`curl -sS -H 'X-Console-Run: team-desk' -o /tmp/${a.id}-Screenshot_2026-11-15-11-39-11.png '${readUrl}'`);
    expect(msg).toContain("say plainly in your answer that you could not see it");
    expect(msg).toContain("never guess what it shows");

    const got = await s.app.request(readUrl.slice(BASE.length), {}, s.local);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await got.arrayBuffer());
    expect(pngSize(body)).toEqual({ w: 702, h: 1568 });
    expect(isTenantSafe("GET", readUrl.slice(BASE.length))).toBe(true);
    // the original stays served as it came
    expect(new Uint8Array(await (await s.app.request(a.path, {}, s.local)).arrayBuffer())).toEqual(PHONE);
  });

  it("a picture the console cannot redraw says read: none, and its copy route answers 415", async () => {
    const s = setup();
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0, ...new Array(40).fill(1)]);
    const a = s.atts.add(heic, "image/heic", "IMG_1.HEIC");
    const msg = s.atts.compose("", [a.id]);
    expect(msg).toContain("read: none, the console cannot redraw this picture (say you could not see it)");
    expect((await s.app.request(`/api/chat/attachments/${a.id}/agent/IMG_1.png`, {}, s.local)).status).toBe(415);
  });

  it("a card answer's files line links the read copy of a picture", () => {
    const s = setup();
    const a = s.atts.add(PHONE, "image/jpeg", "shot.jpg");
    expect(s.atts.cardText("see this", [a.id])).toContain(`${BASE}/api/chat/attachments/${a.id}/agent/shot.png`);
  });
});
